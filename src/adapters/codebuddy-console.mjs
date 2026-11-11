import { createHash, randomUUID } from "node:crypto";
import { InputError } from "../http.mjs";
import { AdapterError } from "./client.mjs";
import { consoleDayStart, descriptor, entries, iso, matchesLog, nativeId, number, redact, redactText, unsupported, usageBucket } from "../console-data.mjs";

const SYSTEM = "codebuddy";
const INTERNAL_NAME = "platform2api 统一入口";
const EVENT_KINDS = ["runtime", "admin", "credit"];
const keyFields = [
  { key: "models", label: "允许的模型", type: "list", help: "留空允许全部模型" },
  { key: "expiresAt", label: "到期时间", type: "text", help: "留空表示长期有效" },
  { key: "ipAllow", label: "允许的 IP", type: "list", help: "支持 IP 或 CIDR" },
  { key: "rpm", label: "每分钟请求上限", type: "number", min: 1, max: 100000 },
];
const secondsIso = (value) => iso(typeof value === "number" ? value * 1000 : value);
const seconds = (value) => value === null || value === "" ? null : typeof value === "number" ? value : Date.parse(value) / 1000;
const revisionOf = (value, fallback) => {
  const revision = value?.revision ?? value?.version ?? fallback;
  if (!Number.isInteger(revision)) throw new InputError("请先刷新条目再保存", 409, { code: "revision_required" });
  return revision;
};
const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const decode = (value) => {
  try {
    if (typeof value !== "string" || value.length > 32000) throw new Error();
    return JSON.parse(Buffer.from(value, "base64url").toString());
  } catch { throw new InputError("日志游标无效", 400); }
};
const fingerprint = (query) => createHash("sha256").update(JSON.stringify(
  [query.kind || "request", query.from, query.to, query.result, query.model, query.account, query.key, query.q],
)).digest("hex");

// Defense in depth for old service versions that returned credential internals.
export function redactCodebuddy(value) {
  if (Array.isArray(value)) return value.map(redactCodebuddy);
  if (value && typeof value === "object") return redact(Object.fromEntries(Object.entries(value).map(([key, item]) =>
    [key, /^(?:.*token|.*secret|.*password|authorization|cookie|set-cookie)$/i.test(key) && !/(?:_at|At|expired|Configured)$/.test(key)
      ? "[REDACTED]" : redactCodebuddy(item)])));
  return redact(value);
}

export function codebuddyAccountFields(record) {
  const credits = record.quota ?? record.credits;
  let quota = null;
  if (credits && !credits.unlimited) {
    const remaining = typeof credits === "number" ? credits : credits.remaining ?? credits.credits;
    const segments = Array.isArray(credits.segments) ? credits.segments : [];
    const total = credits.total ?? (segments.length ? segments.reduce((sum, item) => sum + number(item.total), 0) : null);
    if (remaining !== null && remaining !== undefined && Number.isFinite(Number(remaining))) quota = {
      unit: "credits", total, remaining: Number(remaining), used: total === null ? null : Math.max(0, total - Number(remaining)),
      percent: total ? Math.max(0, Math.min(100, (1 - Number(remaining) / total) * 100)) : null,
    };
  }
  const display = [
    descriptor("profile", "端点", record.profile, "badge"),
    descriptor("uid", "用户 ID", record.uid, "mono"),
    descriptor("enterprise", "组织", record.enterpriseName || record.enterprise_id),
    descriptor("expiresAt", "凭据到期", secondsIso(record.token_expires_at ?? record.expires_at ?? record.expiresAt), "time"),
    descriptor("lastRefresh", "最近刷新", secondsIso(record.last_refresh_time), "time"),
    descriptor("autoCheckin", "自动签到", record.auto_checkin, "bool"),
    descriptor("autoTravel", "自动旅行", record.auto_travel, "bool"),
    descriptor("autoChat", "自动每日对话", record.auto_daily_chat, "bool"),
    descriptor("autoGrowth", "自动成长", record.auto_growth, "bool"),
    descriptor("lastError", "最近错误", record.last_error_code || record.sync_error),
  ].filter((item) => item.value !== null);
  return {
    quota,
    lastUsedAt: secondsIso(record.usage_stats?.last_request_at ?? record.last_used_at),
    primary: display.filter((item) => ["profile", "uid"].includes(item.key)), display: redactCodebuddy(display),
    actions: [
      { id: "update", label: "编辑账号" },
      { id: "delete", label: "删除账号", danger: true, confirm: true },
    ],
  };
}

function keyItem(row) {
  return {
    id: nativeId(row.id), nativeId: nativeId(row.id), name: row.name || row.id,
    masked: row.masked || `${row.prefix || ""}••••••••`, enabled: row.enabled !== false && !row.overridden,
    builtin: row.type === "admin" || row.source === "external", revision: row.version ?? null,
    createdAt: secondsIso(row.created_at), lastUsedAt: secondsIso(row.last_used_at), usage: redactCodebuddy(row.usage ?? null),
    limits: { models: row.models ?? null, expiresAt: secondsIso(row.expires_at), ipAllow: row.ip_allow ?? null, rpm: row.rpm ?? null },
  };
}

function modelItem(row, revision) {
  const id = nativeId(row.id);
  return { id, nativeId: id, model: row.public_id || id, enabled: row.enabled !== false, revision,
    display: [descriptor("upstream", "上游模型", row.upstream_id || id, "mono"),
      descriptor("region", "区域", row.region, "badge"), descriptor("profile", "端点", row.profile, "badge"),
      descriptor("custom", "自定义模型", row.custom === true, "bool")].filter((field) => field.value !== null),
    actions: [{ id: "toggle", label: row.enabled === false ? "启用模型" : "停用模型" }, { id: "update", label: "编辑模型" },
      ...(row.custom ? [{ id: "delete", label: "删除模型", danger: true, confirm: true }] : [])] };
}

function logItem(row, kind = "request") {
  const id = kind === "request" ? nativeId(row.id) : `event:${kind}:${encode([row.started_at, row.id])}`;
  return { id, nativeId: id, system: SYSTEM, at: secondsIso(row.started_at), model: row.model ?? null,
    account: row.credential ?? row.details?.credential ?? null, key: row.api_key ?? null,
    status: row.status_code ?? (row.outcome === "error" || row.outcome === "cancelled" ? 502 : 200),
    durationMs: number(row.duration_ms), inputTokens: number(row.input_tokens), outputTokens: number(row.output_tokens),
    stream: row.streaming === true, ...(row.error_code ? { error: redactText(row.error_code) } : {}),
    ...(kind !== "request" ? { kind: "system", eventKind: kind, action: row.action, message: row.action } : {}) };
}

export function createCodebuddyConsole({ client, baseUrl }) {
  const keyVersions = new Map(), modelSnapshots = new Map();
  const builtinKeys = new Set(["admin-external"]);
  let settingsSnapshot = null;
  let credentialPromise = null;
  const request = async (path, options = {}) => {
    const result = await client.request(path, options);
    if (!result.ok) {
      const status = [400, 401, 403, 404, 409, 422].includes(result.status) ? result.status : 502;
      const detail = result.body?.detail ?? result.body?.error?.message ?? result.body?.message;
      throw new AdapterError(`CodeBuddy 返回 ${result.status}${typeof detail === "string" ? `：${redactText(detail).slice(0, 300)}` : ""}`,
        { status, code: result.status === 409 ? "revision_conflict" : [404, 405].includes(result.status) ? "capability_unsupported" : "upstream_error" });
    }
    if (!result.body || typeof result.body !== "object") throw new AdapterError("CodeBuddy 响应格式无效", { code: "upstream_shape" });
    return result.body;
  };
  const rememberKey = (row) => {
    const item = keyItem(row); keyVersions.set(item.id, item.revision);
    if (item.builtin) builtinKeys.add(item.id);
    return item;
  };
  const keyPayload = (input = {}, creating = false) => {
    const values = { ...(input.limits ?? {}), ...input }, payload = {};
    if (creating) payload.type = "standard";
    for (const key of ["name", "enabled", "models", "rpm"]) if (values[key] !== undefined) payload[key] = values[key];
    // Unified forms use an empty selection for unrestricted access. The native
    // API distinguishes null (all models) from [] (no models at all).
    if (Array.isArray(payload.models) && !payload.models.length) payload.models = null;
    if (values.expiresAt !== undefined) {
      payload.expires_at = seconds(values.expiresAt);
      if (payload.expires_at !== null && !Number.isFinite(payload.expires_at)) throw new InputError("到期时间无效");
    }
    if (values.ipAllow !== undefined) payload.ip_allow = values.ipAllow;
    return payload;
  };
  const logQuery = (query, kind, cursor, limit) => ({ kind, limit, ...(cursor ? { cursor } : {}),
    ...(query.model ? { model: query.model } : {}), ...(query.account ? { credential: String(query.account).replace(/^codebuddy:/, "") } : {}),
    ...(query.key ? { key: String(query.key).replace(/^codebuddy:/, "") } : {}),
    ...(query.from ? { from: seconds(query.from) } : {}), ...(query.to ? { to: seconds(query.to) } : {}),
    ...(query.q ? { search: query.q } : {}),
    ...(query.result === "success" ? { status: "success" } : {}),
  });
  const fetchLogPage = async (query, kind, cursor, limit) => {
    const data = await request("/admin/logs", { query: logQuery(query, kind, cursor, limit) });
    return { items: entries(data), cursor: data.next_cursor ?? null };
  };

  const api = {
    keyManagement: { list: "/admin/keys", items: "items", prefix: "/admin/keys/", revealSuffix: "/reveal" },
    async capabilities() {
      const paths = ["/admin/keys", "/admin/models", "/admin/settings", "/admin/logs", "/admin/credentials"];
      const probes = await Promise.all(paths.map(async (path) => {
        const reply = await client.request(path, { query: path.endsWith("logs") ? { limit: 1 } : undefined });
        if ([404, 405, 501].includes(reply.status)) return false;
        if (!reply.ok) throw new AdapterError(`CodeBuddy 能力读取失败（HTTP ${reply.status}）`, { code: "upstream_error" });
        return Boolean(reply.body && typeof reply.body === "object");
      }));
      const [keys, models, settings, logs, accounts] = probes;
      return { accounts: { add: accounts ? ["oauth", "refresh-token", "credentials"] : [], batch: accounts ? ["enable", "disable", "tags", "delete"] : [] },
        keys: { create: keys, update: keys, delete: keys, reveal: false, rotate: keys, resetUsage: false, fields: keys ? keyFields : [] },
        models: { toggle: models }, logs: { kinds: logs ? ["request", "system"] : [], filters: logs ? ["from", "to", "result", "model", "account", "key", "q"] : [] },
        usage: { extras: logs ? ["retained-request-logs"] : [] }, settings: { supported: settings } };
    },

    async listKeys() {
      const body = await request("/admin/keys");
      const items = entries(body).map(rememberKey);
      if (body.external) items.unshift({ id: "admin-external", nativeId: "admin-external", name: "内置推理密钥", masked: "••••••••",
        enabled: true, builtin: true, createdAt: null, lastUsedAt: null, usage: null, limits: {} });
      return items;
    },
    async createKey(payload) {
      const row = await request("/admin/keys", { method: "POST", body: keyPayload(payload, true) });
      const secret = row.secret ?? row.key;
      if (typeof secret !== "string" || !secret) throw new AdapterError("CodeBuddy 未返回新密钥", { code: "upstream_shape" });
      return { item: rememberKey(row.item ?? row), secret };
    },
    async updateKey(id, payload = {}) {
      if (id === "admin-external") unsupported("修改内置密钥");
      const row = await request(`/admin/keys/${encodeURIComponent(nativeId(id))}`, { method: "PATCH",
        body: { ...keyPayload(payload), version: revisionOf(payload, keyVersions.get(id)) } });
      return { item: rememberKey(row.item ?? row) };
    },
    async deleteKey(id, payload = {}) {
      if (builtinKeys.has(id)) unsupported("删除内置密钥");
      await request(`/admin/keys/${encodeURIComponent(nativeId(id))}`, { method: "DELETE", body: { version: revisionOf(payload, keyVersions.get(id)) } });
      keyVersions.delete(id);
      return { ok: true };
    },
    async keyAction(id, action, payload = {}) {
      if (action !== "rotate" || id === "admin-external") unsupported("此密钥操作");
      const row = await request(`/admin/keys/${encodeURIComponent(nativeId(id))}/rotate`, { method: "POST", body: { version: revisionOf(payload, keyVersions.get(id)) } });
      const secret = row.secret ?? row.key;
      if (typeof secret !== "string" || !secret) throw new AdapterError("CodeBuddy 未返回轮换密钥", { code: "upstream_shape" });
      return { item: rememberKey(row.item ?? row), secret };
    },
    async listModels() {
      const data = await request("/admin/models");
      return entries(data, "models").map((raw) => {
        const row = typeof raw === "string" ? { id: raw } : raw;
        modelSnapshots.set(row.id, { row, revision: data.revision });
        return modelItem(row, data.revision);
      });
    },
    async modelAction(id, action, payload = {}) {
      const snapshot = modelSnapshots.get(id);
      const revision = revisionOf(payload, snapshot?.revision);
      const path = `/admin/models/${encodeURIComponent(nativeId(id))}`;
      if (action === "delete") return request(path, { method: "DELETE", body: { revision } });
      if (!["toggle", "enable", "disable", "update", "preview"].includes(action)) unsupported("此模型操作");
      if (!snapshot) throw new InputError("请先刷新模型再保存", 409);
      const rule = Object.fromEntries(["public_id", "upstream_id", "keep_original", "region", "profile", "credential_ids", "enabled", "routes", "credits_override"]
        .filter((key) => snapshot.row[key] !== undefined || payload[key] !== undefined).map((key) => [key, payload[key] !== undefined ? payload[key] : snapshot.row[key]]));
      if (action === "toggle") rule.enabled = typeof payload.enabled === "boolean" ? payload.enabled : snapshot.row.enabled === false;
      if (action === "enable" || action === "disable") rule.enabled = action === "enable";
      const result = await request(action === "preview" ? `${path}/preview` : path,
        { method: action === "preview" ? "POST" : "PUT", body: { ...rule, revision } });
      if (result.model) modelSnapshots.set(id, { row: result.model, revision: result.revision });
      return result.model ? { item: modelItem(result.model, result.revision), revision: result.revision } : redactCodebuddy(result);
    },

    async listLogs(query = {}) {
      const limit = Math.max(1, Math.min(200, Number(query.limit) || 50));
      const kinds = query.kind === "system" ? EVENT_KINDS : ["request"];
      const hash = fingerprint(query);
      const state = query.cursor ? decode(query.cursor) : { v: 1, hash, streams: {} };
      if (state?.v !== 1 || state.hash !== hash || !state.streams || typeof state.streams !== "object") throw new InputError("日志游标与筛选不匹配", 400);
      const pools = await Promise.all(kinds.map(async (kind) => {
        const stream = { ...(state.streams[kind] || { cursor: null, done: false }) };
        const result = [];
        let batches = 0;
        while (!stream.done && result.length < limit && batches++ < 50) {
          const previous = stream.cursor;
          const page = await fetchLogPage(query, kind, previous, limit - result.length);
          stream.cursor = page.cursor;
          stream.done = !page.cursor;
          if (page.cursor && page.cursor === previous) throw new AdapterError("CodeBuddy 日志游标未推进", { code: "upstream_shape" });
          for (const row of page.items) {
            const item = logItem(row, kind);
            if (matchesLog(item, query)) result.push({ row, item, kind });
          }
          if (query.from && page.items.length && secondsIso(page.items.at(-1).started_at) < query.from) stream.done = true;
        }
        return { kind, stream, result };
      }));
      const merged = pools.flatMap((pool) => pool.result).sort((a, b) => (b.item.at || "").localeCompare(a.item.at || "") || b.item.id.localeCompare(a.item.id));
      const selected = merged.slice(0, limit);
      const selectedIds = new Set(selected.map((entry) => entry.item.id));
      for (const { kind, stream, result } of pools) {
        const used = result.filter((entry) => selectedIds.has(entry.item.id));
        if (used.length < result.length) {
          // Rewind only this stream to its last emitted native row. No fetched
          // entries are discarded when another event kind filled the page.
          if (used.length) {
            const row = used.at(-1).row;
            state.streams[kind] = { cursor: JSON.stringify([row.started_at, row.id]), done: false };
          } else state.streams[kind] ??= { cursor: null, done: false };
        } else state.streams[kind] = stream;
      }
      return { items: selected.map((entry) => entry.item), nextCursor: kinds.some((kind) => !state.streams[kind]?.done) ? encode(state) : null };
    },
    async getLog(id) {
      let row, kind = "request";
      if (id.startsWith("event:")) {
        const match = /^event:(runtime|admin|credit):(.+)$/.exec(id);
        if (!match) throw new InputError("日志 ID 无效");
        kind = match[1];
        const [at, key] = decode(match[2]);
        if (!Number.isFinite(at) || typeof key !== "string" || key.length > 150) throw new InputError("日志 ID 无效");
        const data = await fetchLogPage({}, kind, JSON.stringify([at, `${key}z`]), 1);
        row = data.items.find((item) => item.id === key);
        if (!row) throw new InputError("日志不存在或已过期", 404);
      } else row = await request(`/admin/logs/${encodeURIComponent(nativeId(id))}`);
      const item = logItem(row, kind);
      return { item, display: [descriptor("at", "时间", item.at, "time"), descriptor("profile", "端点", row.profile, "badge"),
        descriptor("kind", "日志类别", kind, "badge"), descriptor("action", "事件", row.action), descriptor("outcome", "结果", row.outcome, "badge")]
        .filter((entry) => entry.value !== null), raw: redactCodebuddy(row) };
    },
    async usage(query = {}) {
      const now = Date.now();
      const from = query.from || new Date(consoleDayStart(now)).toISOString();
      const to = query.to || new Date(now).toISOString();
      const series = new Map(), byModel = new Map(), byKey = new Map(), byAccount = new Map();
      const add = (map, key, row) => {
        if (!key) return;
        const value = map.get(key) || { name: key, requests: 0, inputTokens: 0, outputTokens: 0 };
        value.requests++; value.inputTokens += row.inputTokens; value.outputTokens += row.outputTokens; map.set(key, value);
      };
      let cursor = null, count = 0;
      do {
        const page = await api.listLogs({ kind: "request", from, to, limit: 200, cursor });
        for (const row of page.items) {
          if (query.excludeKeys?.includes(row.key) || !row.at) continue;
          const bucket = usageBucket(row.at, query.bucket);
          add(series, bucket, row); add(byModel, row.model, row); add(byKey, row.key, row); add(byAccount, row.account, row);
        }
        cursor = page.nextCursor;
        if (++count >= 1000 && cursor) throw new InputError("统计范围过大，请缩短时间范围", 422);
      } while (cursor);
      return { excludesInternalKeys: true, series: [...series].map(([bucket, values]) => ({ bucket, system: SYSTEM, ...values })),
        byModel: [...byModel.values()], byKey: [...byKey.values()], byAccount: [...byAccount.values()],
        extras: { coverage: "retained-request-logs", detail: "按尚在保留期内的请求日志统计" } };
    },
    async settings() {
      const data = await request("/admin/settings");
      settingsSnapshot = data;
      const fields = entries(data).filter((row) => !row.locked && !["readonly", "startup"].includes(row.mode)).map((row) => ({
        key: row.key, label: row.label || row.key, type: row.choices ? "select" : ({ boolean: "bool", integer: "number", number: "number", secret: "secret" }[row.type] || "text"),
        value: row.type === "secret" ? "" : row.value, help: row.mode === "restart" ? "保存后重启渠道服务生效" : "",
        ...(row.choices ? { options: row.choices.map((value) => ({ label: String(value), value })) } : {}),
        ...(row.min !== undefined ? { min: row.min } : {}), ...(row.max !== undefined ? { max: row.max } : {}),
      }));
      return { groups: fields.length ? [{ id: "runtime", title: "运行设置", description: "", revision: data.revision, fields }] : [], embeds: [] };
    },
    async saveSettings(group, values = {}) {
      const groupId = typeof group === "object" ? group.id : group;
      if (groupId !== "runtime") throw new InputError("设置分组不存在", 404);
      const revision = revisionOf(values, typeof group === "object" ? group.revision : settingsSnapshot?.revision);
      if (!settingsSnapshot) throw new InputError("请先读取设置再保存", 409);
      const allowed = new Set(settingsSnapshot.items.filter((item) => !item.locked && !["readonly", "startup"].includes(item.mode)).map((item) => item.key));
      const secretKeys = new Set(settingsSnapshot.items.filter((item) => item.type === "secret").map((item) => item.key));
      const patch = Object.fromEntries(Object.entries(values).filter(([key, value]) => !["revision", "version"].includes(key) && !(secretKeys.has(key) && value === "")));
      if (Object.keys(patch).some((key) => !allowed.has(key))) throw new InputError("包含不支持修改的设置项");
      const result = await request("/admin/settings", { method: "PATCH", body: { revision, values: patch } });
      settingsSnapshot = result.items ? result : { ...settingsSnapshot, revision: result.revision };
      return { ok: true, revision: result.revision };
    },
    inference() {
      return { url: baseUrl, routes: ["/v1/chat/completions", "/v1/responses", "/v1/messages", "/v1/embeddings", "/v1/rerank", "/v1/images/generations", "/v1/images/edits", "/v1/videos", "/v1/messages/count_tokens"] };
    },
    async ensureUpstreamCredential({ force = false } = {}) {
      if (credentialPromise && !force) return credentialPromise;
      credentialPromise = (async () => {
        const data = await request("/admin/keys");
        // A user may independently choose the same name. Never rotate or
        // rewrite a key based on its display name; only create our own key.
        const occupied = entries(data).some((row) => row.name === INTERNAL_NAME);
        const name = occupied ? `${INTERNAL_NAME} ${randomUUID().slice(0, 8)}` : INTERNAL_NAME;
        const row = await request("/admin/keys", { method: "POST", body: { name, type: "standard" } });
        if (typeof row.secret !== "string" || !row.secret || !row.id) throw new AdapterError("CodeBuddy 未返回上游凭据", { code: "upstream_shape" });
        return { secret: row.secret, id: row.id, name: row.name || INTERNAL_NAME };
      })().catch((error) => { credentialPromise = null; throw error; });
      return credentialPromise;
    },
  };
  return api;
}

import { createHash } from "node:crypto";
import { AdapterError } from "./client.mjs";
import { InputError } from "../http.mjs";
import { descriptor, entries, filters, iso, matchesLog, normalizeLog, number, redact, unsupported, usageBucket } from "../console-data.mjs";

const SYSTEM = "cnb";
const DAY_MS = 86400000;
const FIELD_GROUPS = [
  { id: "scheduling", title: "调度与超时", fields: [
    { key: "strategy", label: "调度策略", type: "select", options: [{ value: "weighted", label: "按权重" }, { value: "least-connections", label: "最少连接" }, { value: "failover", label: "故障转移" }] },
    { key: "sessionAffinity", label: "保持会话账号", type: "bool" },
    { key: "maxAttempts", label: "最大尝试次数", type: "number", min: 1, max: 10 },
    { key: "cooldownSeconds", label: "冷却时间（秒）", type: "number", min: 5, max: 3600 },
    { key: "healthIntervalSeconds", label: "探活间隔（秒）", type: "number", min: 15, max: 3600 },
    { key: "connectTimeoutSeconds", label: "连接超时（秒）", type: "number", min: 1, max: 120 },
    { key: "idleTimeoutSeconds", label: "流式空闲超时（秒）", type: "number", min: 10, max: 1800 },
  ] },
  { id: "compatibility", title: "客户端兼容", fields: [
    { key: "dshCompat", label: "启用 DSH 兼容", type: "bool" },
    { key: "claudeCodeCompat", label: "启用 Claude Code 兼容", type: "bool" },
  ] },
  { id: "quota-protection", title: "额度保护", parent: "quotaProtection", fields: [
    { key: "enabled", label: "启用额度保护", type: "bool" },
    { key: "thresholdPercent", label: "剩余额度阈值（%）", type: "number", min: 1, max: 100 },
  ] },
  { id: "inference-probe", title: "定时推理探测", parent: "inferenceProbe", fields: [
    { key: "enabled", label: "启用定时探测", type: "bool" },
    { key: "intervalMinutes", label: "探测间隔（分钟）", type: "number", min: 5, max: 1440 },
  ] },
];
const AUTH_FIELDS = [
  { key: "keyLoginEnabled", label: "启用面板密钥登录", type: "bool" },
  { key: "ssoEnabled", label: "启用单点登录", type: "bool" },
  { key: "providerName", label: "提供方名称", type: "text" },
  { key: "issuer", label: "颁发者地址", type: "text" },
  { key: "clientId", label: "客户端 ID", type: "text" },
  { key: "clientSecret", label: "客户端密钥", type: "secret", help: "已保存时留空则不修改" },
  { key: "scope", label: "授权范围", type: "text" },
  { key: "allowedEmails", label: "允许的邮箱", type: "list" },
  { key: "allowedSubjects", label: "允许的 Subject", type: "list" },
  { key: "callbackUrl", label: "回调地址", type: "text" },
];

const signature = (query) => createHash("sha256").update(JSON.stringify(Object.fromEntries(
  Object.entries(query).filter(([key]) => !["cursor", "limit"].includes(key)).sort(([a], [b]) => a.localeCompare(b)),
))).digest("hex").slice(0, 20);
const encode = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const decode = (cursor, fingerprint) => {
  if (!cursor) return 0;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (value.v !== 1 || value.f !== fingerprint || !Number.isSafeInteger(value.offset) || value.offset < 0) throw new Error();
    return value.offset;
  } catch { throw new InputError("日志分页游标无效，请重新加载", 400); }
};
const bucket = usageBucket;
const countTokens = (row) => ({ inputTokens: number(row.tokenUsage?.input), outputTokens: number(row.tokenUsage?.output) });

// These are management routes only. Inference credentials are deliberately
// exposed through a separate internal adapter method, never this console API.
export function createCnbConsole({ serviceJson }) {
  const detailCache = new Map();
  let probed = null;
  let probedAt = 0;
  const optional = async (path, options) => {
    try { return await serviceJson(path, options); }
    catch (error) { if ([404, 405, 501].includes(error.status)) return null; throw error; }
  };

  async function capabilities() {
    if (probed && Date.now() - probedAt < 30000) return structuredClone(probed);
    const [accounts, access, models, requests, events, settings, history] = await Promise.all([
      optional("/api/accounts"), optional("/api/access"), optional("/api/models"),
      optional("/api/logs/requests", { query: { limit: 1, offset: 0 } }),
      optional("/api/logs/system", { query: { limit: 1, offset: 0 } }),
      optional("/api/settings"), optional("/api/usage/history", { query: { days: 7 } }),
    ]);
    probed = {
      accounts: { add: accounts ? ["credentials"] : [], batch: accounts ? ["enable", "disable", "probe", "tags", "delete"] : [] },
      keys: { list: Boolean(access), create: false, update: false, delete: false, reveal: false, rotate: false, resetUsage: false, fields: [] },
      models: { list: Boolean(models), toggle: false },
      logs: { kinds: [...(requests ? ["request"] : []), ...(events ? ["system"] : [])], filters: requests ? ["result", "q"] : [], pagination: requests && Number.isFinite(requests.total) ? "offset" : "none" },
      usage: { extras: history ? ["credit-rates", "worker-usage"] : [] },
      settings: { supported: Boolean(settings) },
    };
    probedAt = Date.now();
    return structuredClone(probed);
  }

  async function listKeys() {
    const data = await optional("/api/access");
    if (!data) return [];
    if (typeof data.maskedKey !== "string" || !data.maskedKey) return [];
    return [{ id: "builtin", nativeId: "builtin", name: "CNB 内置网关密钥", masked: data.maskedKey,
      enabled: data.configured !== false, builtin: true, createdAt: null, lastUsedAt: null, usage: null, limits: {} }];
  }

  async function listModels() {
    const data = await optional("/api/models");
    if (!data) return [];
    return entries(data, "models").map((row) => {
      const model = String(typeof row === "string" ? row : row.id ?? row.model ?? "");
      if (!model) throw new AdapterError("CNB 模型缺少 ID", { code: "upstream_shape" });
      return { id: model, nativeId: model, model, enabled: null, actions: [], display: [
        descriptor("listed", "已发布", row.listed ?? null, "bool"),
        descriptor("eligibleAccounts", "可用账号", Array.isArray(row.eligibleAccounts) ? row.eligibleAccounts.length : null),
        descriptor("configuredAccounts", "配置账号", Array.isArray(row.configuredAccounts) ? row.configuredAccounts.map((a) => a.name || a.id).join("、") : null),
        descriptor("discoveredAccounts", "发现账号", Array.isArray(row.discoveredAccounts) ? row.discoveredAccounts.map((a) => a.name || a.id).join("、") : null),
      ] };
    });
  }

  const cache = (id, raw) => {
    detailCache.delete(id);
    detailCache.set(id, raw);
    if (detailCache.size > 500) detailCache.delete(detailCache.keys().next().value);
  };
  const log = (row, kind = "request") => {
    if (!row?.id) throw new AdapterError("CNB 日志缺少 ID", { code: "upstream_shape" });
    const id = kind === "request" ? String(row.id) : `system.${row.id}`;
    const normalized = normalizeLog(SYSTEM, { ...row, id, key: row.keyName ?? null });
    return { ...normalized, id, nativeId: id, kind, accountName: row.accountName ?? null,
      ...(row.message ? { message: redact(row.message) } : {}) };
  };

  async function listLogs(input = {}) {
    const query = filters(input);
    const kind = query.kind || "request";
    const path = kind === "system" ? "/api/logs/system" : "/api/logs/requests";
    const fingerprint = signature({ ...query, kind });
    let offset = decode(query.cursor, fingerprint);
    const items = [];
    let more = false;
    let scanned = 0;
    let legacy = false;
    // Native CNB supports only outcome and q. Remaining filters are evaluated
    // on each fetched page; the cursor advances by consumed rows, never a full
    // page whose unreturned tail would otherwise disappear.
    do {
      const data = await serviceJson(path, { query: { limit: Math.min(100, query.limit), offset,
        ...(query.q ? { q: query.q } : {}),
        ...(["success", "failure", "error"].includes(query.result) ? { outcome: query.result === "error" ? "failure" : query.result } : {}),
      } });
      const rows = entries(data, "logs");
      legacy = !Number.isFinite(data.total);
      const selected = legacy ? rows.slice(offset) : rows;
      if (!selected.length) { more = false; break; }
      let consumed = 0;
      for (const raw of selected) {
        consumed++;
        const item = log(raw, kind);
        if (matchesLog(item, query)) { items.push(item); cache(item.id, redact(raw)); }
        if (items.length >= query.limit) break;
      }
      offset += consumed;
      scanned += consumed;
      more = legacy ? offset < rows.length : offset < data.total;
    } while (more && items.length < query.limit && scanned < 2000);
    return { items, nextCursor: more ? encode({ v: 1, f: fingerprint, offset }) : null,
      pagination: legacy ? "snapshot" : "offset", partial: more && scanned >= 2000,
      ...(legacy ? { warning: "旧版渠道未提供分页元数据，仅展示当前返回的日志" } : {}) };
  }

  async function getLog(id) {
    const value = String(id ?? "");
    const system = value.startsWith("system.");
    let raw;
    if (system) {
      raw = detailCache.get(value);
      if (!raw) {
        const data = await serviceJson("/api/logs/system", { query: { download: 1 } });
        raw = entries(data, "logs").find((row) => `system.${row.id}` === value);
      }
    } else {
      if (!/^[A-Za-z0-9._:-]{1,200}$/.test(value)) throw new InputError("日志 ID 无效");
      const data = await serviceJson(`/api/logs/requests/${encodeURIComponent(value)}`);
      raw = data.log;
    }
    if (!raw) throw new InputError("请求记录不存在", 404);
    const item = log(raw, system ? "system" : "request");
    return { item, raw: redact(raw), display: [
      descriptor("at", "时间", item.at, "time"), descriptor("model", "模型", item.model, "mono"),
      descriptor("accountName", "账号", raw.accountName ?? item.account), descriptor("status", "状态码", item.status, "badge"),
      descriptor("durationMs", "耗时（毫秒）", item.durationMs), descriptor("stream", "流式响应", item.stream, "bool"),
      ...(raw.message ? [descriptor("message", "说明", redact(raw.message))] : []),
    ] };
  }

  async function usage(input = {}) {
    const query = filters(input);
    const overview = await serviceJson("/api/overview");
    const now = Date.now();
    const span = query.from ? Math.max(1, Math.ceil((now - Date.parse(query.from)) / DAY_MS) + 1) : 30;
    const days = [7, 30, 90, 365].find((value) => value >= span) || 365;
    const [history, rates, comparison] = await Promise.all([
      optional("/api/usage/history", { query: { days } }),
      optional("/api/credits/rates", { query: { window: span <= 1 ? "24h" : "7d" } }),
      optional("/api/usage/comparison"),
    ]);
    const hourly = query.bucket === "hour" || !history;
    const selected = hourly ? overview.hourly ?? [] : history.days ?? [];
    const rows = [];
    for (const row of selected) {
      const at = hourly ? iso(row.at) : `${row.date}T00:00:00+08:00`;
      const start = iso(at);
      const end = iso(Date.parse(start) + (hourly ? 3600000 : DAY_MS) - 1);
      if (!start || query.from && end < query.from || query.to && start > query.to) continue;
      rows.push({ bucket: hourly ? bucket(start, query.bucket || "day") : row.date, system: SYSTEM,
        requests: number(row.requests), ...countTokens(row), partial: Boolean(row.partial) || Boolean(query.from && query.from > start || query.to && query.to < end) });
    }
    const merged = new Map();
    for (const row of rows) {
      const old = merged.get(row.bucket);
      if (!old) merged.set(row.bucket, { ...row });
      else { old.requests += row.requests; old.inputTokens += row.inputTokens; old.outputTokens += row.outputTokens; old.partial ||= row.partial; }
    }
    // Native per-account history describes the entire fixed-day window. It is
    // not safe to relabel that total as belonging to an arbitrary subrange.
    const completeRange = !query.from && !query.to;
    const byAccount = completeRange && history ? (history.accounts ?? []).map((row) => ({ id: row.accountId, account: row.accountId,
      name: row.name || row.accountId, system: SYSTEM, requests: number(row.requests), ...countTokens(row) })) : [];
    return { series: [...merged.values()].sort((a, b) => a.bucket.localeCompare(b.bucket)), byModel: [], byKey: [], byAccount,
      extras: { "credit-rates": redact(rates ?? overview.creditRates ?? null), "worker-usage": redact(comparison),
        limitations: ["渠道暂无按模型与密钥汇总的历史统计", ...(!completeRange ? ["自定义区间暂不返回全窗口账号排行"] : []),
          ...(span > 365 ? ["渠道仅提供最近 365 天的每日统计"] : []), ...(hourly ? ["小时统计仅保留最近 30 天"] : [])],
        partial: rows.some((row) => row.partial), range: history?.range ?? null } };
  }

  async function settings() {
    const [data, auth] = await Promise.all([optional("/api/settings"), optional("/api/auth/settings")]);
    const values = data?.settings ?? {};
    const groups = FIELD_GROUPS.map((group) => {
      const source = group.parent ? values[group.parent] ?? {} : values;
      return { id: group.id, title: group.title, fields: group.fields.filter((field) => Object.hasOwn(source, field.key)).map((field) => ({ ...field, value: source[field.key] })) };
    }).filter((group) => group.fields.length);
    if (auth) groups.push({ id: "auth", title: "渠道登录方式", fields: AUTH_FIELDS.map((field) => ({ ...field,
      value: field.type === "secret" ? "" : auth[field.key] ?? (field.type === "bool" ? false : field.type === "list" ? [] : ""),
      ...(field.type === "secret" ? { configured: Boolean(auth.clientSecretConfigured || auth.hasClientSecret) } : {}),
    })) });
    return { groups, embeds: [
      ...(Object.hasOwn(values, "requestOverrides") ? ["cnb-request-overrides"] : []),
      ...(Object.hasOwn(values, "upstreamHeaders") ? ["cnb-upstream-headers"] : []),
      ...(Object.hasOwn(values, "registrationRelay") ? ["cnb-registration-relay"] : []),
    ] };
  }

  async function saveSettings(groupId, values) {
    if (!values || typeof values !== "object" || Array.isArray(values)) throw new InputError("设置内容须为对象");
    const group = groupId === "auth" ? { fields: AUTH_FIELDS } : FIELD_GROUPS.find((candidate) => candidate.id === groupId);
    if (!group) return unsupported("该设置分组");
    const available = (await settings()).groups.find((candidate) => candidate.id === groupId);
    if (!available) return unsupported("该设置分组");
    const body = {};
    for (const [key, value] of Object.entries(values)) {
      const field = available.fields.find((candidate) => candidate.key === key);
      if (!field) throw new InputError(`不支持的设置项：${key}`, 400, { param: key });
      if (field.type === "secret" && value === "") continue;
      if (field.type === "bool" && typeof value !== "boolean" || field.type === "number" && (!Number.isInteger(value) || value < field.min || value > field.max) || field.type === "select" && !field.options.some((option) => option.value === value))
        throw new InputError(`${field.label}格式不正确`, 400, { param: key });
      body[key] = value;
    }
    if (Object.keys(body).length) await serviceJson(groupId === "auth" ? "/api/auth/settings" : "/api/settings", {
      method: "PATCH", body: group.parent ? { [group.parent]: body } : body,
    });
    return settings();
  }

  return { capabilities, listKeys, listModels, listLogs, getLog, usage, settings, saveSettings,
    createKey: async () => unsupported("创建多个网关密钥"), updateKey: async () => unsupported("修改内置网关密钥"),
    deleteKey: async () => unsupported("删除内置网关密钥"), keyAction: async () => unsupported("该密钥操作"),
    modelAction: async () => unsupported("修改全局模型状态"),
  };
}

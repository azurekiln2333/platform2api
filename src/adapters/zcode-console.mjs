import { AdapterError } from "./client.mjs";
import { InputError } from "../http.mjs";
import { descriptor as field, iso, matchesLog, normalizeLog, redact, unsupported, usageBucket } from "../console-data.mjs";

const POOL = { stickyTtlMin: "会话保持（分钟）", topN: "候选账号数", maxInFlight: "最大并发", breakerThreshold: "熔断失败次数", breakerCooldownMin: "熔断冷却（分钟）", blockedCooldownMin: "封禁冷却（分钟）", quotaCooldownMin: "额度冷却（分钟）", busyCooldownSec: "繁忙冷却（秒）", minPickGapMs: "选取间隔（毫秒）", idleWeightPerHour: "每小时空闲权重", idleWeightMax: "最大空闲权重", weightBalFactor: "余额权重系数", weightSuccFactor: "成功率权重系数" };
const KEY_FIELDS = [
  { key: "models", label: "允许模型", type: "list" }, { key: "quota", label: "Token 总额", type: "number" },
  { key: "expiresAt", label: "到期时间", type: "text" }, { key: "ipAllow", label: "IP 白名单", type: "list" },
];
const keyView = (key) => ({ nativeId: String(key.id), name: key.name, masked: key.prefix ? `${key.prefix}••••••••` : "••••••••", enabled: key.enabled,
  builtin: false, createdAt: key.createdAt, lastUsedAt: key.lastUsedAt, usage: { requests: key.requests ?? 0, tokens: key.usedTokens ?? 0 },
  limits: { models: key.models ?? [], quota: key.quotaTokens ?? 0, expiresAt: iso(key.expiresAt), ipAllow: key.ipAllowlist ?? [] } });
const keyInput = (input) => {
  const values = { ...input.limits, ...input }, body = {};
  for (const key of ["name", "enabled", "models", "realm", "note"]) if (values[key] !== undefined) body[key] = values[key];
  if (values.quota !== undefined) body.quotaTokens = values.quota;
  if (values.ipAllow !== undefined) body.ipAllowlist = values.ipAllow;
  if (values.expiresAt !== undefined) {
    if (values.expiresAt && !iso(values.expiresAt)) throw new InputError("到期时间无效");
    body.expiresInDays = values.expiresAt ? Math.max(0.00001, (Date.parse(values.expiresAt) - Date.now()) / 86400000) : 0;
    if (values.expiresAt && Date.parse(values.expiresAt) <= Date.now()) throw new InputError("到期时间必须晚于现在");
  }
  return body;
};
export function createZcodeConsole(client) {
  const read = async (path, options) => {
    const r = await client.request(path, options);
    if (!r.ok) throw new AdapterError(`ZCode 返回 HTTP ${r.status}`, { status: r.status >= 500 ? 502 : r.status, code: r.status === 404 ? "capability_unsupported" : "upstream_error" });
    if (!r.body || typeof r.body !== "object") throw new AdapterError("ZCode 返回的数据格式不正确", { code: "upstream_shape" });
    return r.body;
  };
  const probe = async (path) => {
    const r = await client.request(path);
    if ([404, 405, 501].includes(r.status)) return false;
    if (!r.ok) throw new AdapterError(`ZCode 返回 HTTP ${r.status}`, { code: "upstream_error" });
    return typeof r.body === "object" && r.body !== null;
  };
  // Old releases have a bounded in-memory log feed and no durable detail ID.
  // Read complete pages before panel filtering, then keep a stable local snapshot.
  const snapshots = new Map();
  const remember = (rows) => {
    for (const row of rows) snapshots.set(String(row.id), row);
    while (snapshots.size > 10000) snapshots.delete(snapshots.keys().next().value);
  };
  const api = {
    async capabilities() {
      const [keys, models, logs] = await Promise.all([probe("/keys"), probe("/api/models"), probe("/api/logs?limit=1")]);
      return { accounts: { add: ["oauth"], batch: ["enable", "disable", "probe", "tags"] },
        keys: { create: keys, update: keys, delete: keys, reveal: false, rotate: false, resetUsage: keys, fields: keys ? KEY_FIELDS : [] },
        models: { toggle: false, list: models }, logs: { kinds: logs ? ["request"] : [], filters: logs ? ["q", "result"] : [], pagination: "offset", detail: "snapshot" }, usage: { extras: ["token-cache"] } };
    },
    async listKeys() {
      const body = await read("/keys");
      const items = (body.keys ?? []).map(keyView);
      if (body.masterKeyEnabled) items.unshift({ nativeId: "master", name: "主密钥", masked: "••••••••", enabled: true, builtin: true, limits: {}, usage: null });
      return items;
    },
    async createKey(input) { const body = await read("/keys", { method: "POST", body: keyInput(input) }); return { item: keyView(body.key), secret: body.secret }; },
    async updateKey(id, input) {
      if (id === "master") return unsupported("修改主密钥");
      const body = await read(`/keys/${encodeURIComponent(id)}/update`, { method: "POST", body: keyInput(input) }); return { item: keyView(body.key) };
    },
    async deleteKey(id) { if (id === "master") return unsupported("删除主密钥"); return read(`/keys/${encodeURIComponent(id)}/delete`, { method: "POST", body: {} }); },
    async keyAction(id, action) {
      if (id === "master" || action !== "reset-usage") return unsupported("此密钥操作");
      const body = await read(`/keys/${encodeURIComponent(id)}/reset`, { method: "POST", body: {} }); return { item: keyView(body.key) };
    },
    async listModels() { const body = await read("/api/models"); return (body.models ?? []).map((m) => ({ nativeId: m.id, model: m.id, enabled: null, display: [field("eligible", "可用账号", m.eligibleAccounts?.length ?? 0)], actions: [] })); },
    async modelAction() { return unsupported("修改模型"); },
    async listLogs(query = {}) {
      if (query.kind === "system") return unsupported("系统事件");
      let offset = Number(query.cursor || 0);
      if (!Number.isSafeInteger(offset) || offset < 0) throw new InputError("日志游标无效");
      const result = [], limit = query.limit || 50;
      let more = true;
      // Stop only after filling the page or exhausting the source. Filters must
      // never cause an empty early page to hide later matching records.
      while (result.length < limit && more) {
        const body = await read("/api/logs", { query: { limit: Math.min(500, limit - result.length), offset, q: query.q, outcome: query.result === "error" ? "failure" : query.result } });
        const rows = body.logs ?? []; remember(rows);
        offset += rows.length; more = rows.length > 0 && offset < Number(body.total ?? offset);
        for (const row of rows) {
          const normalized = normalizeLog("zcode", row);
          if (query.key) return unsupported("按密钥筛选旧版日志");
          if (matchesLog(normalized, query)) result.push({ ...normalized, id: row.id });
        }
      }
      return { items: result, nextCursor: more ? String(offset) : null };
    },
    async getLog(id) {
      const raw = snapshots.get(id);
      if (!raw) throw new InputError("此版本无持久日志详情，请刷新日志列表后重试", 404);
      return { item: { ...normalizeLog("zcode", raw), id }, display: [], raw: redact(raw) };
    },
    async usage(query = {}) {
      // Exact arbitrary time windows are computed from paginated request rows.
      const rows = []; let cursor;
      do { const page = await api.listLogs({ ...query, limit: 200, cursor }); rows.push(...page.items); cursor = page.nextCursor; } while (cursor);
      const series = new Map(), byModel = new Map(), byKey = new Map(), byAccount = new Map();
      const bump = (map, key, row) => { const v = map.get(key) ?? { name: key, requests: 0, inputTokens: 0, outputTokens: 0 }; v.requests++; v.inputTokens += row.inputTokens; v.outputTokens += row.outputTokens; map.set(key, v); };
      for (const row of rows) {
        const bucket = usageBucket(row.at, query.bucket);
        if (bucket) bump(series, bucket, row);
        bump(byModel, row.model ?? "未知", row); bump(byAccount, row.account ?? "未知", row); bump(byKey, row.key ?? "未知", row);
      }
      return { series: [...series.values()].map(({ name, ...v }) => ({ bucket: name, ...v })), byModel: [...byModel.values()], byKey: [...byKey.values()], byAccount: [...byAccount.values()], extras: { limitedToRetainedLogs: true, keyAttributionAvailable: false } };
    },
    async settings() {
      const overview = await read("/api/overview"), settings = overview.settings ?? {};
      const groups = [{ id: "pool", title: "调度与冷却", fields: Object.entries(POOL).filter(([key]) => key in settings).map(([key, label]) => ({ key, label, type: "number", value: settings[key], ...(settings.limits?.[key] ?? {}) })) }];
      const security = await read("/security");
      const s = security.security ?? security;
      groups.push({ id: "security", title: "IP 管控", fields: [ { key: "enabled", label: "启用 IP 管控", type: "bool", value: s.enabled }, { key: "mode", label: "规则模式", type: "select", value: s.mode, options: [{ value: "blacklist", label: "黑名单" }, { value: "whitelist", label: "白名单" }] } ] });
      return { groups, embeds: ["claim-automation", "ip-rules"] };
    },
    async saveSettings(group, values) {
      if (!values || typeof values !== "object" || Array.isArray(values)) throw new InputError("设置格式无效");
      const allowed = group === "pool" ? Object.keys(POOL) : group === "security" ? ["enabled", "mode"] : [];
      if (!allowed.length || Object.keys(values).some((key) => !allowed.includes(key))) throw new InputError("不支持的设置字段");
      return read(group === "pool" ? "/api/settings" : "/security", { method: group === "pool" ? "PATCH" : "POST", body: values });
    },
  };
  return api;
}

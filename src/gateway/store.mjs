import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { BlockList, isIP } from "node:net";
import { InputError } from "../http.mjs";
import { filters, iso, number, usageBucket } from "../console-data.mjs";

const hash = (value) => createHash("sha256").update(value).digest();
const fail = (message, status, code) => { throw new InputError(message, status, { code }); };
const strings = (value, label) => {
  if (!Array.isArray(value) || value.length > 500 || value.some((v) => typeof v !== "string" || !v.trim() || v.length > 500)) throw new InputError(`${label}须为字符串列表`);
  return [...new Set(value.map((v) => v.trim()))];
};
function ipRules(values) {
  const block = new BlockList();
  for (const value of values) {
    const [address, prefix, extra] = value.split("/"), family = isIP(address);
    if (!family || extra !== undefined) throw new InputError("IP 白名单格式无效");
    if (prefix === undefined) block.addAddress(address, family === 4 ? "ipv4" : "ipv6");
    else {
      const size = Number(prefix);
      if (!/^\d+$/.test(prefix) || size < 0 || size > (family === 4 ? 32 : 128)) throw new InputError("IP 网段格式无效");
      block.addSubnet(address, size, family === 4 ? "ipv4" : "ipv6");
    }
  }
  return block;
}
const SCHEMA = `CREATE TABLE gateway_keys (
  id TEXT PRIMARY KEY, hash BLOB NOT NULL UNIQUE, prefix TEXT NOT NULL, suffix TEXT NOT NULL,
  name TEXT NOT NULL, channels TEXT NOT NULL, enabled INTEGER NOT NULL, limits TEXT NOT NULL,
  created_at TEXT NOT NULL, last_used_at TEXT, requests INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0, output_tokens INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE gateway_settings (id TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE gateway_credentials (system TEXT PRIMARY KEY, secret TEXT NOT NULL);
CREATE TABLE gateway_logs (
  id TEXT PRIMARY KEY, at TEXT NOT NULL, key_id TEXT, key_name TEXT, system TEXT,
  model TEXT, status INTEGER NOT NULL, duration_ms INTEGER NOT NULL, input_tokens INTEGER,
  output_tokens INTEGER, stream INTEGER NOT NULL, request_id TEXT NOT NULL
);
CREATE INDEX gateway_logs_at ON gateway_logs(at DESC, id DESC);
CREATE INDEX gateway_logs_key_at ON gateway_logs(key_id, at DESC);
CREATE INDEX gateway_logs_system_at ON gateway_logs(system, at DESC);`;

export class GatewayStore {
  constructor(panelStore, systems) {
    this.panel = panelStore; this.db = panelStore.db; this.systems = systems; this.active = new Map();
    this.panel.transaction(() => {
      this.db.exec("CREATE TABLE IF NOT EXISTS gateway_schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)");
      const versions = this.db.prepare("SELECT version FROM gateway_schema_version ORDER BY version").all();
      if (versions.length > 1 || versions.some((v) => v.version !== 1)) throw new Error("Unsupported gateway database schema");
      if (!versions.length) { this.db.exec(SCHEMA); this.db.prepare("INSERT INTO gateway_schema_version VALUES (1, ?)").run(new Date().toISOString()); }
    });
    this.prune();
    this.timer = setInterval(() => { try { this.prune(); } catch { /* Next run retries; request writes still fail loudly. */ } }, 3600000).unref();
  }
  close() { clearInterval(this.timer); }
  view(row) {
    return { id: `unified:${row.id}`, via: "unified", system: null, channels: JSON.parse(row.channels), name: row.name,
      masked: `${row.prefix}••••••••${row.suffix}`, enabled: Boolean(row.enabled), builtin: false, createdAt: row.created_at,
      lastUsedAt: row.last_used_at, usage: { requests: row.requests, inputTokens: row.input_tokens, outputTokens: row.output_tokens, tokens: row.input_tokens + row.output_tokens }, limits: JSON.parse(row.limits) };
  }
  listKeys() { return this.db.prepare("SELECT * FROM gateway_keys ORDER BY created_at DESC, id").all().map((r) => this.view(r)); }
  validate(input, previous = {}) {
    const name = input.name === undefined ? previous.name : input.name;
    if (typeof name !== "string" || !name.trim() || name.length > 200) throw new InputError("请填写密钥名称", 400, { param: "name" });
    const channels = input.channels ?? previous.channels;
    if (channels !== "*") {
      strings(channels, "可用渠道");
      if (!channels.length || channels.some((system) => !this.systems.includes(system))) throw new InputError("请选择有效的可用渠道");
    }
    const supplied = { ...input.limits, ...input };
    const limits = { ...(previous.limits ?? {}) };
    for (const key of ["models", "ipAllow"]) if (supplied[key] !== undefined) limits[key] = strings(supplied[key], key === "models" ? "模型" : "IP 白名单");
    if (limits.ipAllow?.length) ipRules(limits.ipAllow);
    if (supplied.expiresAt !== undefined) {
      if (supplied.expiresAt && !iso(supplied.expiresAt)) throw new InputError("到期时间无效");
      limits.expiresAt = iso(supplied.expiresAt);
    }
    if (supplied.quota !== undefined) {
      const quota = supplied.quota;
      if (typeof quota === "number" && Number.isSafeInteger(quota) && quota >= 0) limits.quota = quota;
      else if (quota && typeof quota === "object" && !Array.isArray(quota) && Object.keys(quota).every((k) => ["tokens", "requests"].includes(k)) && Object.values(quota).every((v) => Number.isSafeInteger(v) && v >= 0)) limits.quota = quota;
      else throw new InputError("额度须为非负整数或请求与 Token 额度");
    }
    if (input.enabled !== undefined && typeof input.enabled !== "boolean") throw new InputError("密钥状态无效");
    return { name: name.trim(), channels, limits, enabled: input.enabled ?? previous.enabled ?? true };
  }
  createKey(input) {
    const value = this.validate(input), id = randomUUID(), secret = `sk-p2a-${randomBytes(32).toString("base64url")}`;
    this.panel.transaction(() => this.db.prepare("INSERT INTO gateway_keys (id, hash, prefix, suffix, name, channels, enabled, limits, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(id, hash(secret), secret.slice(0, 11), secret.slice(-4), value.name, JSON.stringify(value.channels), Number(value.enabled), JSON.stringify(value.limits), new Date().toISOString()));
    return { item: this.view(this.db.prepare("SELECT * FROM gateway_keys WHERE id = ?").get(id)), secret };
  }
  keyOperation(id, operation, input = {}) {
    return this.panel.transaction(() => {
      const row = this.db.prepare("SELECT * FROM gateway_keys WHERE id = ?").get(id);
      if (!row) throw new InputError("密钥不存在", 404);
      let secret;
      if (operation === "delete") { this.db.prepare("DELETE FROM gateway_keys WHERE id = ?").run(id); return { ok: true }; }
      if (operation === "update") {
        const value = this.validate(input, this.view(row));
        this.db.prepare("UPDATE gateway_keys SET name=?, channels=?, enabled=?, limits=? WHERE id=?").run(value.name, JSON.stringify(value.channels), Number(value.enabled), JSON.stringify(value.limits), id);
      } else if (operation === "reset-usage") this.db.prepare("UPDATE gateway_keys SET requests=0, input_tokens=0, output_tokens=0 WHERE id=?").run(id);
      else if (operation === "rotate") {
        secret = `sk-p2a-${randomBytes(32).toString("base64url")}`;
        this.db.prepare("UPDATE gateway_keys SET hash=?, prefix=?, suffix=? WHERE id=?").run(hash(secret), secret.slice(0, 11), secret.slice(-4), id);
      } else throw new InputError("此密钥操作不受支持", 501);
      return { item: this.view(this.db.prepare("SELECT * FROM gateway_keys WHERE id=?").get(id)), ...(secret ? { secret } : {}) };
    });
  }
  authenticate(secret, ip) {
    if (!secret || typeof secret !== "string" || secret.length > 1024) fail("尚未配置 API 密钥或未提供有效密钥", 401, "invalid_api_key");
    const digest = hash(secret);
    let found;
    // Compare all fixed-length digests; do not expose a prefix lookup oracle.
    for (const row of this.db.prepare("SELECT * FROM gateway_keys").all()) if (timingSafeEqual(digest, row.hash)) found = row;
    if (!found || !found.enabled) fail("API 密钥无效或已停用", 401, "invalid_api_key");
    const item = this.view(found);
    if (item.limits.expiresAt && item.limits.expiresAt <= new Date().toISOString()) fail("API 密钥已过期", 401, "invalid_api_key");
    if (item.limits.ipAllow?.length) {
      const address = String(ip || "").replace(/^::ffff:/, ""), family = isIP(address);
      if (!family || !ipRules(item.limits.ipAllow).check(address, family === 4 ? "ipv4" : "ipv6")) fail("来源 IP 不在密钥白名单内", 403, "ip_not_allowed");
    }
    return { ...item, nativeId: found.id };
  }
  reserve(item) {
    const row = this.db.prepare("SELECT * FROM gateway_keys WHERE id=?").get(item.nativeId);
    if (!row || !row.enabled) fail("API 密钥无效或已停用", 401, "invalid_api_key");
    const quota = JSON.parse(row.limits).quota, tokenLimit = typeof quota === "number" ? quota : quota?.tokens, requestLimit = quota?.requests;
    const active = this.active.get(item.nativeId) || 0;
    if (tokenLimit > 0 && row.input_tokens + row.output_tokens >= tokenLimit || requestLimit > 0 && row.requests + active >= requestLimit) fail("API 密钥额度已用尽", 429, "quota_exceeded");
    this.active.set(item.nativeId, active + 1);
    let released = false;
    return () => { if (!released) { released = true; this.active.set(item.nativeId, Math.max(0, (this.active.get(item.nativeId) || 0) - 1)); } };
  }
  getSetting(id, fallback) { const row = this.db.prepare("SELECT value FROM gateway_settings WHERE id=?").get(id); return row ? JSON.parse(row.value) : fallback; }
  saveSetting(id, value) { this.panel.transaction(() => this.db.prepare("INSERT INTO gateway_settings VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET value=excluded.value").run(id, JSON.stringify(value))); }
  routing() {
    const saved = this.getSetting("routing", {}), order = [...(saved.order ?? []).filter((s) => this.systems.includes(s)), ...this.systems.filter((s) => !saved.order?.includes(s))];
    return { order, enabled: Object.fromEntries(this.systems.map((s) => [s, saved.enabled?.[s] !== false])), failover: saved.failover !== false };
  }
  saveRouting(input) {
    const previous = this.routing(), value = { ...previous, ...input };
    if (!Array.isArray(value.order) || value.order.length !== this.systems.length || new Set(value.order).size !== this.systems.length || value.order.some((s) => !this.systems.includes(s))) throw new InputError("渠道优先级须包含全部渠道且不能重复");
    if (!value.enabled || typeof value.enabled !== "object" || Array.isArray(value.enabled) || Object.entries(value.enabled).some(([s, v]) => !this.systems.includes(s) || typeof v !== "boolean") || typeof value.failover !== "boolean") throw new InputError("路由设置格式无效");
    value.enabled = { ...previous.enabled, ...value.enabled }; this.saveSetting("routing", value); return this.routing();
  }
  credential(system) { const row = this.db.prepare("SELECT secret FROM gateway_credentials WHERE system=?").get(system); return row ? JSON.parse(this.panel.decrypt(row.secret)) : null; }
  saveCredential(system, value) {
    if (!value || typeof value.secret !== "string" || !value.secret) throw new InputError("渠道未返回可用的推理凭据", 502);
    const previous = this.credential(system);
    const retired = [...(previous?.retired ?? [])];
    if (previous && !previous.shared && previous.id !== value.id) retired.push({ id: previous.id, name: previous.name });
    value = { ...value, retired };
    this.panel.transaction(() => this.db.prepare("INSERT INTO gateway_credentials VALUES (?, ?) ON CONFLICT(system) DO UPDATE SET secret=excluded.secret").run(system, this.panel.encrypt(JSON.stringify(value))));
  }
  clearCredential(system) { this.panel.transaction(() => this.db.prepare("DELETE FROM gateway_credentials WHERE system=?").run(system)); }
  internalKeyIds(system) { const c = this.credential(system); return c ? [...(c.retired ?? []), ...(c.shared ? [] : [c])].map((v) => v.id).filter(Boolean).map(String) : []; }
  internalKeys(system) { const c = this.credential(system); return c ? [...(c.retired ?? []), ...(c.shared ? [] : [c])].flatMap((v) => [v.id, v.name]).filter(Boolean).map(String) : []; }
  isInternalKey(system, key) { return key != null && this.internalKeys(system).includes(String(key)); }
  record(record, key) {
    const at = new Date().toISOString(), id = randomUUID();
    this.panel.transaction(() => {
      this.db.prepare("INSERT INTO gateway_logs VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, at, key?.nativeId ?? null, key?.name ?? null, record.system ?? null, record.model ?? null, record.status, Math.max(0, Math.round(record.durationMs)), record.inputTokens ?? null, record.outputTokens ?? null, Number(record.stream === true), record.requestId);
      if (key) this.db.prepare("UPDATE gateway_keys SET requests=requests+1, input_tokens=input_tokens+?, output_tokens=output_tokens+?, last_used_at=? WHERE id=?").run(number(record.inputTokens), number(record.outputTokens), at, key.nativeId);
    });
  }
  retentionDays() { return this.getSetting("retentionDays", 30); }
  setRetentionDays(value) { if (!Number.isInteger(value) || value < 1 || value > 3650) throw new InputError("日志保留天数须为 1–3650"); this.saveSetting("retentionDays", value); this.prune(); return value; }
  prune() { this.panel.transaction(() => this.db.prepare("DELETE FROM gateway_logs WHERE at < ?").run(new Date(Date.now() - this.retentionDays() * 86400000).toISOString())); }
  logView(row) { return { id: `unified:${row.id}`, via: "unified", system: row.system, at: row.at, model: row.model, account: null, key: row.key_name, status: row.status, durationMs: row.duration_ms, inputTokens: row.input_tokens, outputTokens: row.output_tokens, stream: Boolean(row.stream), requestId: row.request_id }; }
  where(input) {
    const query = filters(input), terms = [], args = [];
    for (const [key, column, op] of [["system", "system", "="], ["from", "at", ">="], ["to", "at", "<="], ["model", "model", "="], ["key", "key_name", "="]]) if (query[key]) { terms.push(`${column} ${op} ?`); args.push(query[key]); }
    if (query.result === "success") terms.push("status < 400");
    if (["failure", "error"].includes(query.result)) terms.push("status >= 400");
    if (query.q) { terms.push("(model LIKE ? OR key_name LIKE ? OR system LIKE ?)"); args.push(...Array(3).fill(`%${query.q}%`)); }
    if (query.account) terms.push("0=1");
    return { query, terms, args };
  }
  listLogs(input = {}) {
    const { query, terms, args } = this.where(input);
    if (query.cursor) {
      let cursor; try { cursor = JSON.parse(Buffer.from(query.cursor, "base64url").toString()); } catch { throw new InputError("日志游标无效"); }
      if (!iso(cursor.at) || typeof cursor.id !== "string") throw new InputError("日志游标无效");
      terms.push("(at < ? OR (at = ? AND id < ?))"); args.push(cursor.at, cursor.at, cursor.id);
    }
    const rows = this.db.prepare(`SELECT * FROM gateway_logs ${terms.length ? `WHERE ${terms.join(" AND ")}` : ""} ORDER BY at DESC, id DESC LIMIT ?`).all(...args, query.limit + 1);
    const more = rows.length > query.limit, page = rows.slice(0, query.limit), last = page.at(-1);
    return { items: page.map((r) => this.logView(r)), nextCursor: more ? Buffer.from(JSON.stringify({ at: last.at, id: last.id })).toString("base64url") : null };
  }
  getLog(id) { const row = this.db.prepare("SELECT * FROM gateway_logs WHERE id=?").get(id); if (!row) throw new InputError("日志不存在", 404); const item = this.logView(row); return { item, display: [], raw: item }; }
  usage(input = {}) {
    const { terms, args, query } = this.where(input), where = terms.length ? `WHERE ${terms.join(" AND ")}` : "";
    const sums = "COUNT(*) AS requests, COALESCE(SUM(input_tokens),0) AS inputTokens, COALESCE(SUM(output_tokens),0) AS outputTokens";
    const bucketExpr = query.bucket === "hour" ? "substr(at,1,13)" : "date(at,'+8 hours')";
    const series = this.db.prepare(`SELECT ${bucketExpr} AS bucket, system, ${sums} FROM gateway_logs ${where} GROUP BY bucket,system ORDER BY bucket`).all(...args).map((v) => ({ ...v, bucket: usageBucket(v.bucket, query.bucket), via: "unified" }));
    const top = (column) => this.db.prepare(`SELECT ${column} AS name, system, ${sums} FROM gateway_logs ${where} GROUP BY ${column},system ORDER BY requests DESC LIMIT 100`).all(...args).map((v) => ({ ...v, via: "unified" }));
    return { series, byKey: top("key_name"), byModel: top("model"), byAccount: [] };
  }
}

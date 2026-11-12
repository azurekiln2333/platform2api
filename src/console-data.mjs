import { InputError } from "./http.mjs";
import { AdapterError } from "./adapters/client.mjs";

// Normalization belongs at the management boundary, never in individual pages.
const sensitive = /^(authorization|proxy-authorization|cookie|set-cookie|password|secrets?|clientSecret|client_secret|accessToken|access_token|refreshToken|refresh_token|registrationToken|registration_token|id_token|token|jwt|zcodejwttoken|zaiAccessToken|apiKey|api_key|x-api-key|x-auth-token|proxyKey|gatewayKey|codingPlanApiKey|pat|hash|keyHash|key_hash)$/i;
export const redactText = (value) => String(value)
  .replace(/\b(Bearer|Basic)\s+[^\s"',;]+/gi, "$1 [REDACTED]")
  .replace(/([?&](?:token|key|secret|code|api_key|access_token)=)[^&#\s]*/gi, "$1[REDACTED]");
export function redact(value, depth = 0) {
  if (depth > 30) return "[TRUNCATED]";
  if (Array.isArray(value)) return value.map((entry) => redact(entry, depth + 1));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, entry]) =>
    [key, sensitive.test(key) || (/headers/i.test(key) && typeof entry === "string") ? "[REDACTED]" : redact(entry, depth + 1)]));
  return typeof value === "string" ? redactText(value) : value;
}
export const number = (value, fallback = 0) => Number.isFinite(Number(value)) ? Number(value) : fallback;
export const iso = (value) => {
  if (value === null || value === undefined || value === "" || value === 0) return null;
  const time = typeof value === "number" ? value : Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
};
// Console calendars follow the existing CNB/ZCode UTC+8 day boundary. Keep
// bucket IDs as complete ISO instants so every chart groups the same period.
export const consoleDayStart = (at = Date.now()) => Math.floor((at + 8 * 3600000) / 86400000) * 86400000 - 8 * 3600000;
export const usageBucket = (value, size = "day") => {
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}$/.test(value)) value += "T00:00:00+08:00";
  if (typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}$/.test(value)) value += ":00:00Z";
  const at = typeof value === "number" ? value : Date.parse(value);
  if (!Number.isFinite(at)) return null;
  return new Date(size === "hour" ? Math.floor(at / 3600000) * 3600000 : consoleDayStart(at)).toISOString();
};
export const unsupported = (feature) => { throw new InputError(`此渠道暂不支持${feature}`, 501, { code: "capability_unsupported" }); };
export function method(adapter, name) {
  const owner = typeof adapter.console?.[name] === "function" ? adapter.console : adapter;
  if (typeof owner[name] !== "function") return () => unsupported(name);
  return owner[name].bind(owner);
}
export function entries(value, ...keys) {
  if (Array.isArray(value)) return value;
  for (const key of ["items", ...keys]) if (Array.isArray(value?.[key])) return value[key];
  throw new AdapterError("渠道返回的列表格式不正确", { code: "upstream_shape" });
}
// `extra` carries contract extras such as `{ href }` for `kind: "link"`
// (ui-fixes.md §3) without every caller spelling out the whole object.
export const descriptor = (key, label, value, kind = "text", extra = null) => ({ key, label, value: value ?? null, kind, ...(extra && typeof extra === "object" ? extra : {}) });
export function nativeId(value) {
  const id = String(value ?? "");
  if (!id || id.length > 500 || /[\x00-\x1f\x7f]/.test(id)) throw new InputError("条目 ID 格式不正确");
  return id;
}
export function splitId(value, registry, { unified = false } = {}) {
  const at = value.indexOf(":");
  const system = value.slice(0, at), id = value.slice(at + 1);
  if (at < 1 || (!registry.has(system) && !(unified && system === "unified"))) throw new InputError("渠道或条目 ID 无效", 400);
  return { system, nativeId: nativeId(id) };
}
export function normalizeKey(system, item) {
  const id = nativeId(item.nativeId ?? item.id);
  return {
    id: `${system}:${id}`, nativeId: id, system, via: "direct", channels: [system],
    name: String(item.name ?? item.label ?? id), masked: String(item.masked ?? item.maskedKey ?? item.masked_key ?? "••••••••"),
    enabled: item.enabled !== false, builtin: item.builtin === true, createdAt: iso(item.createdAt ?? item.created_at),
    lastUsedAt: iso(item.lastUsedAt ?? item.last_used_at), usage: redact(item.usage ?? null), limits: redact(item.limits ?? {}),
    ...(item.revision !== undefined ? { revision: item.revision } : {}),
  };
}
export function normalizeModel(system, item) {
  const model = String(item.model ?? item.id ?? item.name ?? "");
  return { id: `${system}:${nativeId(item.nativeId ?? item.id ?? model)}`, system, model,
    enabled: typeof item.enabled === "boolean" ? item.enabled : null, display: redact(item.display ?? []), actions: redact(item.actions ?? []),
    ...(item.revision !== undefined ? { revision: item.revision } : {}) };
}
export function normalizeLog(system, item) {
  return { id: `${system}:${nativeId(item.nativeId ?? item.id)}`, system, via: item.via ?? "direct",
    at: iso(item.at ?? item.timestamp ?? item.t), model: item.model ?? null, account: item.account ?? item.accountId ?? null,
    key: item.key ?? item.keyName ?? null, status: number(item.status, item.ok === false ? 502 : 200),
    durationMs: number(item.durationMs ?? item.ms), inputTokens: number(item.inputTokens ?? item.tokenUsage?.input ?? item.in),
    outputTokens: number(item.outputTokens ?? item.tokenUsage?.output ?? item.out), stream: item.stream === true,
    ...(item.kind ? { kind: item.kind } : {}), ...(item.eventKind ? { eventKind: item.eventKind } : {}),
    ...(item.action ? { action: redactText(item.action) } : {}), ...(item.message ? { message: redactText(item.message) } : {}),
    ...(item.error || item.err ? { error: redactText(item.error ?? item.err) } : {}) };
}
export function filters(search) {
  const result = Object.fromEntries(search instanceof URLSearchParams ? search : Object.entries(search ?? {}));
  for (const key of ["from", "to"]) {
    if (result[key] && !iso(result[key])) throw new InputError("时间范围无效", 400, { param: key });
    if (result[key]) result[key] = iso(result[key]);
  }
  if (result.from && result.to && result.from > result.to) throw new InputError("开始时间不能晚于结束时间");
  if (result.result && !["all", "success", "failure", "error"].includes(result.result)) throw new InputError("结果筛选无效");
  if (result.via && !["all", "direct", "unified"].includes(result.via)) throw new InputError("入口筛选无效");
  if (result.kind && !["request", "system"].includes(result.kind)) throw new InputError("日志类型无效");
  const limit = result.limit === undefined ? 50 : Number(result.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 200) throw new InputError("每页数量须为 1–200");
  return { ...result, limit };
}
export function matchesLog(row, query) {
  const at = iso(row.at);
  if (query.from && (!at || at < query.from) || query.to && (!at || at > query.to)) return false;
  if (query.result === "success" && row.status >= 400) return false;
  if (["failure", "error"].includes(query.result) && row.status < 400) return false;
  for (const key of ["model", "account", "key"]) if (query[key] && String(row[key] ?? "") !== String(query[key]).replace(`${row.system}:`, "")) return false;
  return !query.q || JSON.stringify(row).toLowerCase().includes(String(query.q).toLowerCase());
}

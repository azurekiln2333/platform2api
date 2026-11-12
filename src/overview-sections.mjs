import { consoleDayStart, iso, number, redactText, usageBucket } from "./console-data.mjs";

// Per-channel overview blocks (ui-fixes.md §3 `GET /api/overview/:system`).
// The console renders by `kind` only, so a new channel becomes visible by
// returning blocks; nothing here knows an individual vendor's page layout.
export const SECTION_KINDS = Object.freeze(["stats", "quotaList", "series", "table"]);
export const SECTION_TONES = Object.freeze(["ok", "warn", "error", "muted"]);
export const COLUMN_KINDS = Object.freeze(["text", "mono", "time", "badge", "bool", "link"]);

const LIMITS = { items: 200, buckets: 24 * 8, rows: 200, columns: 24, label: 120, cell: 300 };

const text = (value) => typeof value === "string" ? redactText(value).slice(0, LIMITS.cell) : "";
const label = (value) => text(value).slice(0, LIMITS.label) || "";
const tone = (value) => (SECTION_TONES.includes(value) ? value : undefined);
const finite = (value) => (typeof value === "number" && Number.isFinite(value) ? value : null);
const count = (value) => {
  if (typeof value === "boolean") return value ? "是" : "否";
  if (typeof value === "string") return text(value);
  const numeric = finite(value);
  return numeric === null ? null : numeric;
};
const hint = (value) => (value === undefined || value === null ? undefined : text(value) || undefined);
const withTone = (item, value) => (value ? { ...item, tone: value } : item);

export const statsSection = (id, title, items) => ({ kind: "stats", id, title, items });
export const quotaListSection = (id, title, items) => ({ kind: "quotaList", id, title, items });
export const seriesSection = (id, title, unit, buckets) => ({ kind: "series", id, title, unit, buckets });
export const tableSection = (id, title, columns, rows) => ({ kind: "table", id, title, columns, rows });

/**
 * One `stats` item; `value` stays a raw scalar so the console formats it.
 * An unknown metric is omitted rather than shown as a placeholder the console
 * would have to interpret.
 */
export const stat = (itemLabel, value, itemHint, itemTone) => {
  const normalized = count(value);
  if (normalized === null || normalized === "") return null;
  return withTone({ label: label(itemLabel), value: normalized, ...(itemHint ? { hint: hint(itemHint) } : {}) }, tone(itemTone));
};

export const quotaItem = (id, itemLabel, quota, status) => {
  if (!quota || typeof quota !== "object") return null;
  const total = finite(quota.total);
  const used = finite(quota.used);
  let remaining = finite(quota.remaining);
  if (remaining === null && total !== null && used !== null) remaining = Math.max(0, total - used);
  if (total === null && remaining === null) return null;
  return {
    id: String(id ?? itemLabel),
    label: label(itemLabel),
    remaining,
    total,
    unit: typeof quota.unit === "string" ? text(quota.unit) : "",
    ...(tone(status) ? { status: tone(status) } : {}),
  };
};

const stateOf = (row) => {
  if (!row) return "other";
  if (row.enabled === false || row.status === "disabled" || row.disabled === true) return "disabled";
  if (["cooling", "cooldown"].includes(row.status)) return "cooling";
  if (["ok", "healthy", "ready"].includes(row.status)) return "ok";
  if (["error", "offline", "unhealthy", "expired"].includes(row.status)) return "error";
  return "other";
};

const STATE_LABELS = { ok: "正常", error: "异常", cooling: "冷却中", disabled: "已停用", other: "未就绪" };

/** Today's hourly buckets in the console's UTC+8 day, from any adapter format. */
export function todayHourlySeries(hourly) {
  const dayStart = consoleDayStart(), now = Date.now(), buckets = new Map();
  for (const row of Array.isArray(hourly) ? hourly : []) {
    const hour = usageBucket(row?.hour ?? row?.at ?? row?.t, "hour");
    if (!hour || Date.parse(hour) < dayStart || Date.parse(hour) > now) continue;
    const current = buckets.get(hour) ?? { t: hour, values: {} };
    const requests = number(row.requests ?? row.count);
    current.values.请求 = number(current.values.请求) + requests;
    if (row.errors !== undefined) current.values.失败 = number(current.values.失败) + number(row.errors);
    buckets.set(hour, current);
  }
  return [...buckets.values()].sort((a, b) => a.t.localeCompare(b.t));
}

/**
 * Channel-agnostic fallback: every adapter already returns a flat overview
 * payload plus its account list, so a channel without its own block builder
 * still gets a usable detailed overview.
 */
export function genericSections({ overview = {}, accounts = [] } = {}) {
  const rows = Array.isArray(accounts) ? accounts : [];
  const sections = [];
  const states = { ok: 0, error: 0, cooling: 0, disabled: 0, other: 0 };
  for (const row of rows) states[stateOf(row)]++;
  const stats = overview.stats && typeof overview.stats === "object" ? overview.stats : {};
  const accountsSummary = overview.accounts && typeof overview.accounts === "object" ? overview.accounts : {};

  const accountItems = [
    stat("账号总数", finite(accountsSummary.total) ?? rows.length),
    stat("可用账号", finite(accountsSummary.ok ?? accountsSummary.ready ?? states.ok), "启用、探测通过且未在冷却中", states.ok ? "ok" : "muted"),
    stat("异常账号", states.error, "需要检查凭据或工作区状态", states.error ? "error" : undefined),
    stat("冷却中", states.cooling, "到冷却时间后自动重试", states.cooling ? "warn" : undefined),
    stat("已停用", states.disabled, undefined, states.disabled ? "muted" : undefined),
    rows.length ? stat("可用比例", Math.round((states.ok / rows.length) * 1000) / 10, "%") : null,
  ].filter(Boolean);
  if (accountItems.length) sections.push(statsSection("accounts", "账号与运行状态", accountItems));

  const todayItems = [
    stat("今日请求", overview.requestsToday ?? stats.requests ?? null),
    stat("今日 Token", overview.tokensToday ?? stats.tokenUsage?.today?.total ?? null),
    stat("今日失败", overview.errorsToday ?? stats.errors ?? null),
    overview.partial ? stat("统计完整性", "不完整", "今日统计不完整，仅显示渠道可提供的数据", "warn") : null,
  ].filter(Boolean);
  if (todayItems.length) sections.push(statsSection("today", "今日用量", todayItems));

  const quota = overview.quota && typeof overview.quota === "object" ? overview.quota : null;
  const quotaItems = quota ? [
    stat("剩余额度", finite(quota.remaining), quota.unit ? `单位：${text(quota.unit)}` : undefined),
    stat("总额度", finite(quota.total), quota.unit ? `单位：${text(quota.unit)}` : undefined),
    stat("已使用", finite(quota.used), quota.unit ? `单位：${text(quota.unit)}` : undefined),
    stat("额度同步", iso(quota.syncedAt), undefined, quota.syncedAt ? undefined : "muted"),
  ].filter(Boolean) : [];
  if (quotaItems.length) sections.push(statsSection("quota", "额度总览", quotaItems));

  const quotaRows = rows
    .map((row) => quotaItem(row.nativeId ?? row.label, row.label ?? row.primary, row.quota,
      stateOf(row) === "ok" ? "ok" : stateOf(row) === "error" ? "error" : stateOf(row) === "cooling" ? "warn" : "muted"))
    .filter(Boolean);
  if (quotaRows.length) sections.push(quotaListSection("account-quota", "各账号额度", quotaRows));

  const buckets = todayHourlySeries(overview.hourly);
  if (buckets.length) sections.push(seriesSection("hourly", "今日每小时请求", "次", buckets));

  const attention = rows
    .filter((row) => ["error", "cooling", "other"].includes(stateOf(row)))
    .map((row) => ({
      账号: String(row.label ?? row.primary ?? row.nativeId ?? ""),
      状态: STATE_LABELS[stateOf(row)],
      说明: row.lastError ?? row.detail ?? row.error ?? "",
    }));
  if (attention.length)
    sections.push(tableSection("attention", "需要关注", [
      { key: "账号", label: "账号", kind: "text" },
      { key: "状态", label: "状态", kind: "badge" },
      { key: "说明", label: "说明", kind: "text" },
    ], attention));

  return sections;
}

/**
 * Coerces adapter-declared blocks into the documented contract, dropping
 * anything malformed instead of failing the whole channel.
 */
export function normalizeSections(input) {
  if (!Array.isArray(input)) return [];
  const sections = [];
  const seen = new Set();
  for (const candidate of input) {
    if (!candidate || typeof candidate !== "object" || !SECTION_KINDS.includes(candidate.kind)) continue;
    const title = label(candidate.title);
    if (!title) continue;
    const id = label(candidate.id) || `${candidate.kind}-${sections.length + 1}`;
    if (seen.has(id)) continue;
    const section = { kind: candidate.kind, id, title };
    if (candidate.kind === "stats") {
      const items = (Array.isArray(candidate.items) ? candidate.items : []).slice(0, LIMITS.items)
        .map((item) => item && typeof item === "object"
          ? withTone({ label: label(item.label), value: count(item.value), ...(item.hint ? { hint: hint(item.hint) } : {}) }, tone(item.tone))
          : null)
        .filter((item) => item && item.label && item.value !== null);
      if (!items.length) continue;
      section.items = items;
    } else if (candidate.kind === "quotaList") {
      const items = (Array.isArray(candidate.items) ? candidate.items : []).slice(0, LIMITS.items)
        .map((item) => (item && typeof item === "object"
          ? {
            id: String(item.id ?? item.label ?? ""),
            label: label(item.label),
            remaining: finite(item.remaining),
            total: finite(item.total),
            unit: typeof item.unit === "string" ? text(item.unit) : "",
            ...(tone(item.status) ? { status: tone(item.status) } : {}),
          }
          : null))
        .filter((item) => item && item.label);
      if (!items.length) continue;
      section.items = items;
    } else if (candidate.kind === "series") {
      const buckets = (Array.isArray(candidate.buckets) ? candidate.buckets : []).slice(0, LIMITS.buckets)
        .map((bucket) => {
          const t = bucket && typeof bucket === "object" ? iso(bucket.t) : null;
          if (!t) return null;
          const values = {};
          for (const [name, value] of Object.entries(bucket.values ?? {}).slice(0, LIMITS.columns)) {
            const numeric = finite(value);
            if (numeric !== null) values[text(name).slice(0, 40)] = numeric;
          }
          return { t, values };
        })
        .filter(Boolean);
      if (!buckets.length) continue;
      section.unit = typeof candidate.unit === "string" ? text(candidate.unit) : "";
      section.buckets = buckets;
    } else {
      const columns = (Array.isArray(candidate.columns) ? candidate.columns : []).slice(0, LIMITS.columns)
        .map((column) => (column && typeof column === "object" && column.key
          ? { key: String(column.key), label: label(column.label) || String(column.key), ...(COLUMN_KINDS.includes(column.kind) ? { kind: column.kind } : {}) }
          : null))
        .filter(Boolean);
      if (!columns.length) continue;
      section.columns = columns;
      section.rows = (Array.isArray(candidate.rows) ? candidate.rows : []).slice(0, LIMITS.rows)
        .map((row) => {
          if (!row || typeof row !== "object") return null;
          const normalized = {};
          for (const column of columns) normalized[column.key] = count(row[column.key]);
          return normalized;
        })
        .filter(Boolean);
    }
    seen.add(id);
    sections.push(section);
  }
  return sections;
}
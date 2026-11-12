import { createHash } from "node:crypto";
import { AdapterError } from "./client.mjs";
import { InputError } from "../http.mjs";
import { consoleDayStart, descriptor, entries, filters, iso, matchesLog, normalizeLog, number, redact, unsupported, usageBucket } from "../console-data.mjs";
import { quotaListSection, seriesSection, stat, statsSection, tableSection, todayHourlySeries } from "../overview-sections.mjs";

const SYSTEM = "cnb";
const DAY_MS = 86400000;
// Channel-level operations (ui-fixes.md §3). The panel validates the declared
// id; CNB has no native batch wake, so it fans out per account.
export const CNB_CHANNEL_ACTIONS = Object.freeze([
  Object.freeze({ id: "wake-all", label: "唤醒全部工作区", accountAction: "wake" }),
]);
const PUBLIC_CHANNEL_ACTIONS = CNB_CHANNEL_ACTIONS.map(({ id, label }) => ({ id, label }));
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
      accounts: { add: accounts ? ["credentials"] : [], batch: accounts ? ["enable", "disable", "probe", "tags", "delete"] : [],
        channelActions: PUBLIC_CHANNEL_ACTIONS.map((entry) => ({ ...entry })) },
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

  // ---- Per-channel detail blocks (ui-fixes.md F12 / §3) -------------------
  // Everything below reads the CNB service's local panel state only: no probe,
  // no quota sync. `/api/credits/rates` and `/api/usage/history` are local
  // aggregations, and `/api/usage/comparison` (which would describe workspace
  // usage) is deliberately not polled.
  const cnbState = (account) => {
    if (!account) return "unknown";
    if (account.enabled === false) return "disabled";
    if (account.quotaProtection?.suspended) return "quota";
    if (account.cooldownUntil && Date.parse(account.cooldownUntil) > Date.now()) return "cooling";
    if (account.status === "healthy" && account.endpoint) return "healthy";
    if (account.status === "unhealthy") return "offline";
    return "pending";
  };
  const STATE_LABELS = { healthy: "正常", offline: "异常", pending: "未就绪", cooling: "冷却中", quota: "额度暂停", disabled: "已停用", unknown: "未知" };
  const STATE_TONES = { healthy: "ok", offline: "error", pending: "muted", cooling: "warn", quota: "warn", disabled: "muted", unknown: "muted" };
  const accountQuota = (account) => {
    const credits = account?.quota?.credits;
    if (!credits || !Number.isFinite(Number(credits.total))) return null;
    const total = Number(credits.total) || 0, used = Number(credits.used) || 0, freeze = Number(credits.freeze) || 0;
    return { unit: "credits", total, used, freeze, remaining: Math.max(0, total - used - freeze) };
  };
  const percent = (value) => (value === null || value === undefined ? null : Math.round(value * 10) / 10);

  async function overviewSections() {
    const data = await serviceJson("/api/overview");
    const [history, rates] = await Promise.all([
      optional("/api/usage/history", { query: { days: 7 } }),
      optional("/api/credits/rates", { query: { window: "24h" } }),
    ]);
    const accounts = Array.isArray(data.accounts) ? data.accounts : [];
    const stats = data.stats && typeof data.stats === "object" ? data.stats : {};
    const states = { healthy: 0, offline: 0, pending: 0, cooling: 0, quota: 0, disabled: 0 };
    for (const account of accounts) states[cnbState(account)] = (states[cnbState(account)] || 0) + 1;
    const total = Number.isFinite(stats.total) ? stats.total : accounts.length;
    const ready = Number.isFinite(stats.ready) ? stats.ready : states.healthy;
    const syncedAt = accounts.map((account) => account?.quota?.syncedAt).filter(Boolean).sort().at(-1) ?? null;
    const quotas = accounts.map(accountQuota).filter(Boolean);
    const totalCredits = quotas.reduce((sum, quota) => sum + quota.total, 0);
    const usedCredits = quotas.reduce((sum, quota) => sum + quota.used, 0);
    const freezeCredits = quotas.reduce((sum, quota) => sum + quota.freeze, 0);
    const sections = [];

    sections.push(statsSection("accounts", "账号与工作区", [
      stat("账号总数", total),
      stat("可用工作区", ready, "启用、探活通过且未在冷却中", ready ? "ok" : "muted"),
      stat("可用比例", total ? percent((ready / total) * 100) : null, "%"),
      stat("冷却中", states.cooling, "到冷却时间后自动重试", states.cooling ? "warn" : undefined),
      stat("额度保护暂停", states.quota, "额度低于保护阈值", states.quota ? "warn" : undefined),
      stat("异常工作区", states.offline, "探活未通过，需人工检查", states.offline ? "error" : undefined),
      stat("未就绪", states.pending, "尚未完成首次探活"),
      stat("已停用", states.disabled, undefined, states.disabled ? "muted" : undefined),
    ].filter(Boolean)));

    sections.push(statsSection("today", "今日请求", [
      stat("今日请求", stats.requests, "按 UTC+8 自然日统计"),
      stat("今日失败", stats.errors, undefined, stats.errors ? "error" : undefined),
      stat("请求成功率", percent(stats.successRate), "%"),
      stat("平均耗时", stats.averageDurationMs, "含完整流式响应时长（毫秒）"),
      stat("进行中", stats.activeRequests, "正在处理的请求"),
    ].filter(Boolean)));

    const tokens = stats.tokenUsage?.today ?? null;
    if (tokens)
      sections.push(statsSection("tokens", "今日 Token 用量", [
        stat("Tokens 合计", tokens.total, "输入 + 输出，缓存已含在输入中"),
        stat("输入", tokens.input), stat("输出", tokens.output),
        stat("缓存读取", tokens.cacheRead), stat("缓存写入", tokens.cacheWrite),
        stat("已上报请求", tokens.reportedRequests),
        stat("未上报请求", tokens.missingRequests, undefined, tokens.missingRequests ? "warn" : undefined),
        stat("字段不完整", tokens.partialRequests, undefined, tokens.partialRequests ? "warn" : undefined),
      ].filter(Boolean)));

    sections.push(statsSection("quota", "Credits 额度", [
      stat("剩余 Credits", Number.isFinite(stats.remainingCredits) ? stats.remainingCredits : quotas.reduce((sum, quota) => sum + quota.remaining, 0) || null, "已扣除使用与冻结额度"),
      stat("总额度", quotas.length ? totalCredits : null, "同组织不重复累计"),
      stat("已使用", quotas.length ? usedCredits : null),
      stat("冻结额度", quotas.length ? freezeCredits : null, "尚未结算的占用"),
      stat("已同步组织", stats.quotaOrganizations ?? (quotas.length || null), "个"),
      stat("额度同步", syncedAt, "额度上次成功更新的时间"),
    ].filter(Boolean)));

    const overall = rates?.overall ?? null;
    if (overall)
      sections.push(statsSection("credit-rate", "Credits 单价", [
        stat("账单估算单价", overall.billing?.rate, "Credits / 百万 tokens"),
        stat("工作区上报单价", overall.reported?.rate, "Credits / 百万 tokens"),
        stat("偏差", overall.deviation === null || overall.deviation === undefined ? null : percent(overall.deviation * 100), "% （上报 − 账单）"),
        stat("剩余额度可换", overall.tokensLeft, "按当前单价估算的 Tokens"),
        stat("统计窗口", overall.windowStart ? `自 ${iso(overall.windowStart)}` : null),
        stat("参与估算组织", overall.organizations, "个"),
      ].filter(Boolean)));

    const quotaRows = accounts.map((account) => {
      const quota = accountQuota(account);
      if (!quota) return null;
      return { id: String(account.id ?? account.name ?? ""), label: String(account.name ?? account.id ?? ""), ...quota, status: STATE_TONES[cnbState(account)] };
    }).filter(Boolean);
    if (quotaRows.length) sections.push(quotaListSection("account-quota", "各账号额度", quotaRows));

    const buckets = todayHourlySeries(data.hourly);
    if (buckets.length) sections.push(seriesSection("hourly", "今日每小时请求", "次", buckets));

    const attention = accounts
      .filter((account) => ["offline", "pending", "cooling", "quota"].includes(cnbState(account)))
      .map((account) => ({
        账号: String(account.name ?? account.id ?? ""),
        状态: STATE_LABELS[cnbState(account)],
        最近错误: redact(account.lastError) || "",
        最近探活: iso(account.lastProbeAt ?? account.checkedAt) ?? "",
        冷却至: iso(account.cooldownUntil) ?? "",
      }));
    if (attention.length)
      sections.push(tableSection("attention", "最近失败与异常", [
        { key: "账号", label: "账号", kind: "text" },
        { key: "状态", label: "状态", kind: "badge" },
        { key: "最近错误", label: "最近错误", kind: "text" },
        { key: "最近探活", label: "最近探活", kind: "time" },
        { key: "冷却至", label: "冷却至", kind: "time" },
      ], attention));

    const days = Array.isArray(history?.days) ? history.days.slice(-7) : [];
    if (days.length)
      sections.push(tableSection("history", "最近 7 天用量", [
        { key: "日期", label: "日期" },
        { key: "请求", label: "请求" },
        { key: "失败", label: "失败" },
        { key: "输入", label: "输入 Tokens" },
        { key: "输出", label: "输出 Tokens" },
        { key: "缓存读取", label: "缓存读取" },
        { key: "缓存写入", label: "缓存写入" },
      ], days.map((row) => ({
        日期: String(row.date ?? ""),
        请求: number(row.requests), 失败: number(row.errors),
        输入: number(row.tokenUsage?.input), 输出: number(row.tokenUsage?.output),
        缓存读取: number(row.tokenUsage?.cacheRead), 缓存写入: number(row.tokenUsage?.cacheWrite),
      }))));

    return sections;
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

  return { capabilities, overviewSections, listKeys, listModels, listLogs, getLog, usage, settings, saveSettings,
    createKey: async () => unsupported("创建多个网关密钥"), updateKey: async () => unsupported("修改内置网关密钥"),
    deleteKey: async () => unsupported("删除内置网关密钥"), keyAction: async () => unsupported("该密钥操作"),
    modelAction: async () => unsupported("修改全局模型状态"),
  };
}

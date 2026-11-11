import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { InputError } from "./http.mjs";
import { CHANNELS } from "./channels.mjs";
import { describeError, buildOverview } from "./overview.mjs";
import { consoleDayStart, entries, filters, matchesLog, method, normalizeKey, normalizeModel, normalizeLog, number, redact, splitId, unsupported, usageBucket } from "./console-data.mjs";

const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const EMPTY_CAPABILITIES = { accounts: { add: [], batch: [] }, keys: { create: false, update: false, delete: false, reveal: false, rotate: false, resetUsage: false, fields: [] }, models: { toggle: false }, logs: { kinds: [], filters: [] }, usage: { extras: [] } };
const errorOf = (system, error) => ({ system, ...redact(describeError(error)) });
const states = (account) => account.enabled === false || account.status === "disabled" ? "disabled" : ["ready", "healthy", "ok"].includes(account.status) ? "ok" : "error";

export function createConsole({ getRegistry, configurations, store, gatewayStore, origin }) {
  const cursors = new Map();
  const keySnapshots = new Map();
  const rememberKey = (system, item) => {
    const normalized = normalizeKey(system, item);
    keySnapshots.set(normalized.id, normalized);
    return normalized;
  };
  const isPrivateKey = (system, id) => gatewayStore.internalKeyIds(system).includes(String(id));
  const targets = (registry, system) => {
    if (system && !registry.has(system)) throw new InputError("渠道参数不受支持", 400, { param: "system" });
    return system ? [system] : registry.systems();
  };
  async function aggregate(system, work) {
    const registry = await getRegistry(), items = [], errors = [];
    await Promise.all(targets(registry, system).map(async (name) => {
      try { items.push(...await work(registry.get(name), name)); }
      catch (error) { errors.push(errorOf(name, error)); }
    }));
    return { items, errors };
  }
  async function capabilities(adapter) {
    const owner = adapter.console ?? adapter;
    const value = typeof owner.capabilities === "function" ? await owner.capabilities() : owner.capabilities;
    return { ...structuredClone(EMPTY_CAPABILITIES), ...value, keys: { ...EMPTY_CAPABILITIES.keys, ...value?.keys, reveal: false } };
  }
  async function channels(req) {
    const registry = await getRegistry();
    return Promise.all(registry.systems().map(async (system) => {
      const adapter = registry.get(system), config = configurations.find((v) => v.system === system) ?? CHANNELS.find((v) => v.system === system) ?? {};
      const results = await Promise.allSettled([adapter.health(), capabilities(adapter), Promise.resolve().then(() => typeof adapter.inference === "function" ? adapter.inference() : { url: adapter.baseUrl, routes: [] })]);
      const [probe, caps, inference] = results;
      const errors = results.filter((r) => r.status === "rejected").map((r) => errorOf(system, r.reason));
      const health = probe.status === "fulfilled" ? probe.value?.status ?? "unknown" : "down";
      const info = inference.status === "fulfilled" ? inference.value : { url: "", routes: [] };
      const inferenceUrl = config.publicUrl || info.publicUrl || info.url || adapter.baseUrl || config.baseUrl || "";
      return { system, label: config.label ?? system, color: config.color ?? "#64748b", health,
        detail: probe.status === "fulfilled" ? probe.value?.detail ?? "" : errors[0]?.message,
        inferenceUrl, inference: { ...info, url: inferenceUrl },
        unifiedUrl: `${origin(req)}/v1`, capabilities: caps.status === "fulfilled" ? caps.value : structuredClone(EMPTY_CAPABILITIES), ...(errors.length ? { errors } : {}) };
    }));
  }
  async function keys(query = {}) {
    query = filters(query);
    const registry = await getRegistry(); targets(registry, query.system);
    const direct = query.via === "unified" ? { items: [], errors: [] } : await aggregate(query.system, async (adapter, system) => entries(await method(adapter, "listKeys")(), "keys")
      .filter((item) => !isPrivateKey(system, item.nativeId ?? item.id)).map((item) => rememberKey(system, item)));
    const unified = query.via === "direct" ? [] : gatewayStore.listKeys().filter((key) => !query.system || key.channels === "*" || key.channels.includes(query.system));
    return { items: [...unified, ...direct.items].sort((a, b) => Number(b.builtin) - Number(a.builtin) || a.name.localeCompare(b.name)), errors: direct.errors };
  }
  async function createKey(input) {
    if (input.via === "unified") return gatewayStore.createKey(input);
    if (input.via && input.via !== "direct") throw new InputError("使用地址无效");
    const registry = await getRegistry();
    if (!input.system || !registry.has(input.system)) throw new InputError("请先选择渠道", 400, { param: "system" });
    const adapter = registry.get(input.system), caps = await capabilities(adapter);
    if (!caps.keys.create) return unsupported("新建密钥");
    if (typeof input.name !== "string" || !input.name.trim() || input.name.length > 200) throw new InputError("请填写密钥名称", 400, { param: "name" });
    const result = await method(adapter, "createKey")(input);
    if (typeof result.secret !== "string" || !result.secret) throw new InputError("渠道未返回新密钥，请刷新列表核对创建结果", 502);
    return { item: rememberKey(input.system, result.item), secret: result.secret };
  }
  async function keyOperation(id, operation, input = {}) {
    const registry = await getRegistry(), { system, nativeId } = splitId(id, registry, { unified: true });
    if (operation === "reveal") return unsupported("再次查看完整密钥");
    if (system === "unified") return gatewayStore.keyOperation(nativeId, operation, input);
    if (isPrivateKey(system, nativeId)) throw new InputError("密钥不存在", 404);
    const adapter = registry.get(system), caps = await capabilities(adapter);
    const capability = { update: "update", delete: "delete", rotate: "rotate", "reset-usage": "resetUsage" }[operation];
    if (!capability || !caps.keys[capability]) return unsupported("此密钥操作");
    // Preserve the revision the caller read. Refreshing immediately before a
    // mutation would silently overwrite edits made from another console.
    if (!keySnapshots.has(id)) for (const row of entries(await method(adapter, "listKeys")(), "keys")) rememberKey(system, row);
    const existing = keySnapshots.get(id);
    if (!existing) throw new InputError("密钥不存在", 404);
    if (existing.builtin && operation === "delete") throw new InputError("内置密钥不可删除");
    if (Number.isInteger(existing.revision)) input = { revision: existing.revision, ...input };
    const result = operation === "update" ? await method(adapter, "updateKey")(nativeId, input) : operation === "delete" ? await method(adapter, "deleteKey")(nativeId, input) : await method(adapter, "keyAction")(nativeId, operation, input);
    if (operation === "delete") keySnapshots.delete(id);
    return { ...redact(result), ...(result?.item ? { item: rememberKey(system, result.item) } : {}), ...(operation === "rotate" && result?.secret ? { secret: result.secret } : {}) };
  }
  const models = (query = {}) => aggregate(query.system, async (adapter, system) => entries(await method(adapter, "listModels")(), "models").map((item) => normalizeModel(system, item)));
  async function overview() {
    const registry = await getRegistry(), legacy = await buildOverview(registry);
    const totals = { accounts: { total: 0, ok: 0, error: 0, disabled: 0 }, requestsToday: 0, tokensToday: 0, errorsToday: 0 };
    const hourly = new Map(), attention = [], errors = [], dayStart = consoleDayStart(), now = Date.now();
    const summaries = await Promise.all(registry.systems().map(async (system) => {
      const section = legacy[system], adapter = registry.get(system);
      const accounts = { total: number(section.accounts?.total), ok: number(section.accounts?.ok ?? section.accounts?.ready), error: 0, disabled: number(section.accounts?.disabled) };
      try {
        const rows = await adapter.listAccounts();
        accounts.total = rows.length; accounts.ok = 0; accounts.error = 0; accounts.disabled = 0;
        for (const row of rows) {
          const state = states(row); accounts[state]++;
          if (state === "error") attention.push({ system, kind: "account", message: `${row.label || row.nativeId} 需要检查`, link: `#accounts?system=${system}&status=error` });
        }
      } catch (error) { errors.push(errorOf(system, error)); }
      if (!gatewayStore.listKeys().some((row) => row.enabled && (row.channels === "*" || row.channels.includes(system)) && (!row.limits?.expiresAt || Date.parse(row.limits.expiresAt) > Date.now())))
        attention.push({ system, kind: "key", message: "尚无允许此渠道的统一密钥", link: `#keys?system=${system}&via=unified` });
      const metric = (label) => Array.isArray(section.usage) ? section.usage.find((v) => v.label === label)?.value : null;
      const requestsToday = number(section.requestsToday ?? section.stats?.requests ?? section.requests ?? metric("今日请求"));
      const tokensToday = number(section.tokensToday ?? section.stats?.tokenUsage?.today?.total ?? section.tokenUsage?.today?.total ?? section.tokens);
      const errorsToday = number(section.errorsToday ?? section.stats?.errors ?? section.errors ?? metric("今日错误"));
      if (section.partial) { totals.partial = true; errors.push({ system, message: "今日统计不完整，仅显示渠道可提供的数据", code: "usage_partial" }); }
      for (const key of Object.keys(accounts)) totals.accounts[key] += accounts[key];
      totals.requestsToday += requestsToday; totals.tokensToday += tokensToday; totals.errorsToday += errorsToday;
      for (const bucket of section.hourly ?? []) {
        const hour = usageBucket(bucket.hour ?? bucket.at, "hour");
        if (!hour || Date.parse(hour) < dayStart || Date.parse(hour) > now) continue;
        const row = hourly.get(hour) ?? { hour, ...Object.fromEntries(registry.systems().map((s) => [s, 0])) };
        row[system] += number(bucket.requests ?? bucket.count); hourly.set(hour, row);
      }
      if (section.quota?.total && section.quota.remaining / section.quota.total < 0.1) attention.push({ system, kind: "quota", message: "额度即将用尽", link: `#accounts?system=${system}` });
      if (section.error) errors.push({ system, ...section.error });
      return { ...section, accounts, quota: section.quota ?? null,
        requestsToday: section.partial && section.requestsToday === null ? null : requestsToday,
        tokensToday: section.partial && section.tokensToday === null ? null : tokensToday,
        errorsToday: section.partial && section.errorsToday === null ? null : errorsToday };
    }));
    return { ...redact(legacy), totals, channels: summaries, hourly: [...hourly.values()].sort((a, b) => a.hour.localeCompare(b.hour)), attention, errors, timezone: "Asia/Shanghai" };
  }
  async function logs(input) {
    const query = filters(input), registry = await getRegistry(), selected = targets(registry, query.system);
    const signature = JSON.stringify(Object.entries(query).filter(([key]) => key !== "cursor").sort());
    let state;
    if (query.cursor) {
      const saved = cursors.get(query.cursor);
      if (!saved || saved.expires < Date.now()) throw new InputError("日志游标已过期，请刷新", 410, { code: "cursor_expired" });
      if (saved.signature !== signature) throw new InputError("筛选已改变，请从第一页加载");
      state = structuredClone(saved.state);
    } else {
      state = Object.fromEntries((query.via === "unified" ? [] : selected).map((system) => [system, { pending: [], cursor: null, started: false, done: false }]));
      if (query.kind !== "system" && query.via !== "direct") state.unified = { pending: [], cursor: null, started: false, done: false };
    }
    const errors = [], failed = new Set(), items = [];
    const fill = async (system, source) => {
      if (source.done || source.pending.length || failed.has(system)) return;
      try {
        const adapter = system === "unified" ? null : registry.get(system);
        let scans = 0;
        while (!source.done && !source.pending.length && scans++ < 100) {
          const page = system === "unified" ? gatewayStore.listLogs({ ...query, cursor: source.cursor, limit: query.limit }) : await method(adapter, "listLogs")({ ...query, cursor: source.cursor, limit: query.limit });
          const rows = entries(page, "logs");
          const next = page.nextCursor ?? page.next_cursor ?? null;
          if (next !== null && next === source.cursor) throw new InputError("渠道日志游标未推进", 502);
          source.cursor = next; source.started = true; source.done = next === null;
          source.pending = rows.map((row) => system === "unified" ? row : normalizeLog(system, row))
            .filter((row) => matchesLog(row, query) && (system === "unified" || !gatewayStore.isInternalKey(system, row.key)))
            .sort((a, b) => String(b.at).localeCompare(String(a.at)) || b.id.localeCompare(a.id));
        }
        if (!source.done && !source.pending.length) throw new InputError("日志筛选扫描量过大，请缩小时间范围", 422);
      } catch (error) { failed.add(system); errors.push(errorOf(system, error)); }
    };
    while (items.length < query.limit) {
      await Promise.all(Object.entries(state).map(([system, source]) => fill(system, source)));
      const available = Object.entries(state).filter(([, source]) => source.pending.length).sort((a, b) => String(b[1].pending[0].at).localeCompare(String(a[1].pending[0].at)) || b[1].pending[0].id.localeCompare(a[1].pending[0].id));
      if (!available.length) break;
      items.push(available[0][1].pending.shift());
    }
    let nextCursor = null;
    if (Object.values(state).some((v) => v.pending.length || !v.done)) {
      nextCursor = randomUUID();
      for (const [id, cursor] of cursors) if (cursor.expires < Date.now()) cursors.delete(id);
      while (cursors.size >= 500) cursors.delete(cursors.keys().next().value);
      cursors.set(nextCursor, { signature, state, expires: Date.now() + 15 * 60 * 1000 });
    }
    return { items: redact(items), nextCursor, errors };
  }
  async function logDetail(id) {
    const registry = await getRegistry(), parts = splitId(id, registry, { unified: true });
    if (parts.system === "unified") return gatewayStore.getLog(parts.nativeId);
    const result = await method(registry.get(parts.system), "getLog")(parts.nativeId);
    return { item: normalizeLog(parts.system, result.item), display: redact(result.display ?? []), raw: redact(result.raw ?? result.item) };
  }
  async function usage(input) {
    const query = filters(input), registry = await getRegistry(); targets(registry, query.system);
    if (query.bucket && !["hour", "day"].includes(query.bucket)) throw new InputError("统计间隔无效");
    const result = { series: [], byModel: [], byKey: [], byAccount: [], extras: {}, errors: [] };
    const needsUnified = new Set();
    if (query.via !== "unified") await Promise.all(targets(registry, query.system).map(async (system) => {
      try {
        const data = await method(registry.get(system), "usage")({ ...query, excludeKeys: gatewayStore.internalKeys(system) });
        if (data.excludesInternalKeys === true) needsUnified.add(system);
        for (const key of ["series", "byModel", "byKey", "byAccount"]) result[key].push(...(data[key] ?? []).filter((row) => key !== "byKey" || !gatewayStore.isInternalKey(system, row.name ?? row.key ?? row.id)).map((row) => ({ ...redact(row), ...(key === "series" ? { bucket: usageBucket(row.bucket, query.bucket) } : {}), system, via: "direct" })));
        result.extras[system] = redact(data.extras ?? {});
      } catch (error) { result.errors.push(errorOf(system, error)); needsUnified.add(system); }
    }));
    const unified = gatewayStore.usage(query);
    if (query.via !== "direct") {
      // Native usage often counts forwarded requests already. Add our counters
      // only for channels that excluded their internal credentials (or failed).
      result.byKey.push(...unified.byKey);
      result.extras.unified = unified;
      for (const key of ["series", "byModel", "byAccount"]) result[key].push(...unified[key].filter((row) => query.via === "unified" || needsUnified.has(row.system)));
    }
    return result;
  }
  async function settings(req) {
    const registry = await getRegistry(), channelList = await channels(req), result = await aggregate(null, async (adapter, system) => [{ system, ...redact(await method(adapter, "settings")()) }]);
    return { version: VERSION, auth: store.viewSso(store.state.sso.callbackUrl || `${origin(req)}/api/auth/oidc/callback`),
      serviceUrls: store.serviceUrls(), ssoCallbackUrl: store.state.sso.callbackUrl || "",
      systems: configurations.map((config) => ({ system: config.system, url: store.serviceUrls()[config.system], tokenConfigured: Boolean(config.token), stub: registry.isStub(config.system) })),
      services: channelList.map((channel) => ({ system: channel.system, url: store.serviceUrls()[channel.system], health: channel.health, detail: channel.detail })),
      common: [{ id: "gateway-logs", title: "统一入口日志", fields: [{ key: "retentionDays", label: "保留天数", type: "number", min: 1, max: 3650, value: gatewayStore.retentionDays() }] }],
      channels: result.items, errors: result.errors, routing: gatewayStore.routing() };
  }
  async function saveSettings(system, input) {
    if (!input || typeof input.group !== "string" || !input.values || typeof input.values !== "object" || Array.isArray(input.values)) throw new InputError("设置格式无效");
    if (!system && input.group === "gateway-logs") return { ok: true, retentionDays: gatewayStore.setRetentionDays(input.values.retentionDays) };
    if (!system) throw new InputError("没有可跨渠道统一修改的同义设置组");
    const registry = await getRegistry(); targets(registry, system);
    return redact(await method(registry.get(system), "saveSettings")(input.group, input.values));
  }
  return { channels, keys, createKey, keyOperation, models, overview, logs, logDetail, usage, settings, saveSettings,
    invalidate: (system) => { for (const [id, key] of keySnapshots) if (key.system === system) keySnapshots.delete(id); cursors.clear(); } };
}

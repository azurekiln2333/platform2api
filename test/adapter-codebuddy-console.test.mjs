import test from "node:test";
import assert from "node:assert/strict";
import createAdapter from "../src/adapters/codebuddy.mjs";

const NOW = 1794355200;
const key = (id, overrides = {}) => ({ id, name: id, type: "standard", enabled: true, masked: "cb-123…7890", prefix: "cb-12345",
  created_at: NOW, last_used_at: NOW + 1, expires_at: null, ip_allow: null, rpm: null, models: null, version: 1, ...overrides });
const record = (id, started_at, overrides = {}) => ({ id, started_at, model: "m1", credential: "account-1", api_key: "key-1",
  status_code: 200, outcome: "success", input_tokens: 10, output_tokens: 5, streaming: true, duration_ms: 123, ...overrides });
const todayStart = Date.parse("2026-11-10T16:00:00Z") / 1000;
const hourly = (bucket, overrides = {}) => ({ bucket, requests: 0, error: 0, cancelled: 0,
  input_tokens: null, output_tokens: null, input_tokens_known: 0, output_tokens_known: 0, ...overrides });

// This fake follows app/admin_api.py, including versioned DELETE JSON bodies,
// epoch-second timestamps and independent event-kind cursors. It never opens a
// service data directory or contacts an upstream account.
function fixture({ missing = [], failure = null, legacyFilters = false } = {}) {
  const calls = [], rows = [key("key-1")];
  const logs = { request: [], runtime: [], admin: [], credit: [] };
  const state = { rows, logs, revision: 7, models: [{ id: "upstream/m1", public_id: "m1", enabled: true, region: "cn", custom: true }],
    settings: [
      { key: "audit_retention_days", type: "integer", value: 30, label: "保留天数", min: 1, max: 36500, mode: "hot", locked: false },
      { key: "stream_mode", type: "string", value: "compatible", label: "流式模式", choices: ["compatible", "realtime"], mode: "hot", locked: false },
      { key: "api_key", type: "secret", value: "never-return-key", label: "推理密钥", mode: "startup", locked: true },
      { key: "test_secret", type: "secret", value: "never-return-secret", label: "凭据", mode: "hot", locked: false },
      { key: "cooldown", type: "number", value: 60, label: "内部冷却", mode: "readonly", locked: true },
    ] };
  const reply = (status, body) => ({ ok: status >= 200 && status < 300, status, body });
  const client = { baseUrl: "http://127.0.0.1:8787", async request(path, options = {}) {
    const { method = "GET", body = {}, query = {} } = options;
    calls.push({ path, method, body: structuredClone(body), query: structuredClone(query) });
    if (failure?.path === path) return reply(failure.status, { detail: "upstream rejected" });
    if (missing.includes(path)) return reply(404, { detail: "not found" });
    if (path === "/admin/keys" && method === "GET") return reply(200, { external: state.external, items: structuredClone(rows) });
    if (path === "/admin/keys" && method === "POST") {
      if (rows.some((row) => row.name === body.name)) return reply(400, { detail: "name already exists" });
      const row = key(`new-${rows.length}`, { ...body }); rows.push(row);
      return reply(200, { ...row, secret: `cb-new-${row.id}` });
    }
    const keyPath = /^\/admin\/keys\/([^/]+)(?:\/(rotate|reveal))?$/.exec(path);
    if (keyPath) {
      const id = decodeURIComponent(keyPath[1]), row = rows.find((item) => item.id === id);
      if (!row) return reply(404, { detail: "missing key" });
      if (body.version !== row.version) return reply(409, { detail: "配置已更新" });
      if (method === "DELETE") { rows.splice(rows.indexOf(row), 1); return reply(200, { ok: true }); }
      if (keyPath[2] === "rotate") { row.version++; return reply(200, { ...row, secret: "cb-rotated" }); }
      if (method === "PATCH") { Object.assign(row, body, { version: row.version + 1 }); return reply(200, structuredClone(row)); }
    }
    if (path === "/admin/models" && method === "GET") return reply(200, { models: structuredClone(state.models), revision: state.revision });
    const modelPath = /^\/admin\/models\/(.+)$/.exec(path);
    if (modelPath) {
      if (body.revision !== state.revision) return reply(409, { detail: "配置已更新" });
      const id = decodeURIComponent(modelPath[1]), row = state.models.find((item) => item.id === id);
      if (!row) return reply(404, { detail: "not found" });
      state.revision++;
      if (method === "DELETE") { state.models.splice(state.models.indexOf(row), 1); return reply(200, { ok: true, revision: state.revision }); }
      Object.assign(row, body); return reply(200, { model: structuredClone(row), revision: state.revision });
    }
    if (path === "/admin/settings" && method === "GET") return reply(200, { items: structuredClone(state.settings), revision: state.revision });
    if (path === "/admin/settings" && method === "PATCH") {
      if (body.revision !== state.revision) return reply(409, { detail: "配置已更新" });
      for (const [name, value] of Object.entries(body.values)) state.settings.find((item) => item.key === name).value = value;
      return reply(200, { items: structuredClone(state.settings), revision: ++state.revision });
    }
    if (path === "/admin/logs") {
      let selected = [...logs[query.kind || "request"]].sort((a, b) => b.started_at - a.started_at || b.id.localeCompare(a.id));
      if (query.cursor) {
        const [at, id] = JSON.parse(query.cursor);
        selected = selected.filter((item) => item.started_at < at || (item.started_at === at && item.id < id));
      }
      if (query.model) selected = selected.filter((item) => item.model === query.model);
      if (query.credential) selected = selected.filter((item) => item.credential === query.credential);
      if (query.status) selected = selected.filter((item) => item.outcome === query.status);
      if (!legacyFilters) {
        if (query.key) selected = selected.filter((item) => item.api_key === query.key);
        if (query.from) selected = selected.filter((item) => item.started_at >= query.from);
        if (query.to) selected = selected.filter((item) => item.started_at <= query.to);
      }
      const page = selected.slice(0, query.limit || 50), last = page.at(-1);
      return reply(200, { items: structuredClone(page), next_cursor: selected.length > page.length ? JSON.stringify([last.started_at, last.id]) : null });
    }
    if (path.startsWith("/admin/logs/")) {
      const row = logs.request.find((item) => item.id === decodeURIComponent(path.slice(12)));
      return row ? reply(200, structuredClone(row)) : reply(404, { detail: "expired" });
    }
    if (path === "/admin/credentials") return reply(200, { credentials: state.accounts || [] });
    if (path === "/admin/dashboard") return reply(200, state.dashboard || {});
    throw new Error(`unexpected ${method} ${path}`);
  } };
  const adapter = createAdapter({ system: "codebuddy", client, baseUrl: client.baseUrl });
  return { api: adapter.console, adapter, state, calls };
}

test("CodeBuddy normalized keys keep seconds, restrictions and versions without returning secrets", async () => {
  const { api, state, calls } = fixture();
  state.external = { occupied: true };
  state.rows[0].secret = "must-not-list";
  state.rows.push(key("builtin", { type: "admin" }));
  const rows = await api.listKeys();
  assert.equal(rows[0].builtin, true);
  assert.equal(rows[1].createdAt, new Date(NOW * 1000).toISOString());
  assert.equal(rows[1].revision, 1);
  assert.ok(!JSON.stringify(rows).includes("must-not-list"));
  const created = await api.createKey({ name: "production", models: ["m1"], expiresAt: "2027-01-01T00:00:00Z", ipAllow: ["127.0.0.1"], rpm: 5 });
  assert.match(created.secret, /^cb-new/);
  assert.equal(created.item.secret, undefined);
  assert.equal(calls.at(-1).body.expires_at, 1798761600);
  assert.deepEqual(calls.at(-1).body.ip_allow, ["127.0.0.1"]);
  assert.equal(calls.at(-1).body.type, "standard");
  await assert.rejects(() => api.keyAction("key-1", "reveal"), { status: 501 });
  await assert.rejects(() => api.keyAction("key-1", "reset-usage"), { status: 501 });
  await assert.rejects(() => api.deleteKey("admin-external"), { status: 501 });
  await assert.rejects(() => api.deleteKey("builtin"), { status: 501 });
});

test("CodeBuddy empty model selections allow all models while omitted selections stay omitted", async () => {
  const { api, calls } = fixture();
  const created = await api.createKey({ name: "unrestricted", models: [] });
  assert.equal(calls.at(-1).body.models, null);
  assert.equal(created.item.limits.models, null);
  await api.createKey({ name: "native-default" });
  assert.equal(Object.hasOwn(calls.at(-1).body, "models"), false);
  await api.updateKey("key-1", { revision: 1, limits: { models: ["m1"] } });
  assert.deepEqual(calls.at(-1).body.models, ["m1"]);
  const updated = await api.updateKey("key-1", { revision: 2, limits: { models: [] } });
  assert.equal(calls.at(-1).body.models, null);
  assert.equal(updated.item.limits.models, null);
  await api.updateKey("key-1", { revision: 3, enabled: false });
  assert.equal(Object.hasOwn(calls.at(-1).body, "models"), false);
});

test("CodeBuddy writes preserve stale key versions and DELETE/rotate send version bodies", async () => {
  const { api, state, calls } = fixture();
  await api.listKeys(); state.rows[0].version = 2;
  await assert.rejects(() => api.updateKey("key-1", { enabled: false }), { status: 409, code: "revision_conflict" });
  assert.equal(calls.at(-1).body.version, 1);
  const saved = await api.updateKey("key-1", { enabled: false, revision: 2 });
  assert.equal(saved.item.revision, 3);
  const rotated = await api.keyAction("key-1", "rotate", { revision: 3 });
  assert.equal(rotated.secret, "cb-rotated");
  assert.equal(rotated.item.revision, 4);
  await api.deleteKey("key-1", { revision: 4 });
  assert.equal(calls.at(-1).method, "DELETE");
  assert.deepEqual(calls.at(-1).body, { version: 4 });
  await assert.rejects(() => fixture().api.updateKey("key-1", {}), { status: 409 });
});

test("CodeBuddy model writes preserve explicit null and fail on stale revisions", async () => {
  const { api, state, calls } = fixture();
  const rows = await api.listModels();
  assert.equal(rows[0].model, "m1");
  assert.equal(rows[0].revision, 7);
  const toggled = await api.modelAction(rows[0].id, "toggle", { revision: 7, enabled: false, region: null });
  assert.equal(toggled.item.enabled, false);
  assert.equal(calls.at(-1).body.region, null);
  assert.equal(calls.at(-1).path, "/admin/models/upstream%2Fm1");
  state.revision++;
  await assert.rejects(() => api.modelAction(rows[0].id, "update", { public_id: "new-name" }), { status: 409 });
  await api.modelAction(rows[0].id, "delete", { revision: state.revision });
  assert.deepEqual(calls.at(-1).body, { revision: 9 });
});

test("CodeBuddy model toggles preserve routes and credit overrides and edits can clear them", async () => {
  const { api, state, calls } = fixture();
  const id = "上游/模型";
  const routes = [{ upstream_id: "route-1", weight: 3, enabled: true, source: "manual" }];
  const credits = { "cn-cli": 1.25, "intl-work": 2 };
  Object.assign(state.models[0], { id, routes, credits_override: credits });
  await api.listModels();
  await api.modelAction(id, "toggle", { enabled: false, revision: 7 });
  assert.equal(calls.at(-1).path, `/admin/models/${encodeURIComponent(id)}`);
  assert.deepEqual(calls.at(-1).body.routes, routes);
  assert.deepEqual(calls.at(-1).body.credits_override, credits);
  const newRoutes = [{ upstream_id: "route-2", weight: 1, enabled: false, source: "manual" }];
  await api.modelAction(id, "update", { revision: 8, routes: newRoutes, credits_override: { "cn-work": 4 } });
  assert.deepEqual(calls.at(-1).body.routes, newRoutes);
  assert.deepEqual(calls.at(-1).body.credits_override, { "cn-work": 4 });
  await api.modelAction(id, "enable", { revision: 9 });
  assert.deepEqual(calls.at(-1).body.routes, newRoutes);
  assert.deepEqual(calls.at(-1).body.credits_override, { "cn-work": 4 });
  await api.modelAction(id, "update", { revision: 10, routes: null, credits_override: {} });
  assert.equal(calls.at(-1).body.routes, null);
  assert.deepEqual(calls.at(-1).body.credits_override, {});
  await api.modelAction(id, "update", { revision: 11, routes: [], credits_override: null });
  assert.deepEqual(calls.at(-1).body.routes, []);
  assert.equal(calls.at(-1).body.credits_override, null);
});

test("CodeBuddy legacy log filtering advances cursors without losing matches", async () => {
  const { api, state, calls } = fixture({ legacyFilters: true });
  state.logs.request = Array.from({ length: 12 }, (_, n) => record(`row-${n}`, NOW + 20 - n, { api_key: n % 2 ? "target" : "other" }));
  const query = { key: "target", from: new Date((NOW + 10) * 1000).toISOString(), to: new Date((NOW + 19) * 1000).toISOString(), limit: 2 };
  let cursor, collected = [];
  do { const page = await api.listLogs({ ...query, cursor }); collected.push(...page.items); cursor = page.nextCursor; } while (cursor);
  assert.deepEqual(collected.map((row) => row.id), ["row-1", "row-3", "row-5", "row-7", "row-9"]);
  assert.equal(collected[0].inputTokens, 10);
  assert.equal(collected[0].durationMs, 123);
  assert.equal(collected[0].stream, true);
  assert.equal(calls[0].query.from, NOW + 10);
  const first = await api.listLogs(query);
  await assert.rejects(() => api.listLogs({ ...query, key: "other", cursor: first.nextCursor }), { status: 400 });
});

test("CodeBuddy system-event pagination merges all native kinds and detail redacts credentials", async () => {
  const { api, state } = fixture();
  for (const [kind, times] of Object.entries({ runtime: [10, 6, 1], admin: [9, 7, 2], credit: [8, 5, 3] }))
    state.logs[kind] = times.map((n) => ({ id: `${kind}-${n}`, started_at: NOW + n, action: `${kind}.event`, details: { authorization: "Bearer secret", api_key: "hidden" } }));
  let cursor, collected = [];
  do { const page = await api.listLogs({ kind: "system", limit: 2, cursor }); collected.push(...page.items); cursor = page.nextCursor; } while (cursor);
  assert.equal(collected.length, 9);
  assert.equal(new Set(collected.map((row) => row.id)).size, 9);
  assert.deepEqual(collected.map((row) => Date.parse(row.at) / 1000 - NOW), [10, 9, 8, 7, 6, 5, 3, 2, 1]);
  const detail = await api.getLog(collected[0].id);
  assert.equal(detail.item.id, collected[0].id);
  assert.equal(detail.raw.details.authorization, "[REDACTED]");
  assert.equal(detail.raw.details.api_key, "[REDACTED]");
});

test("CodeBuddy request detail redacts secrets, cookies and bearer values recursively", async () => {
  const { api, state } = fixture();
  state.logs.request.push(record("request-1", NOW, { headers: { "set-cookie": "session=value", authorization: "Bearer test" },
    upstream: { access_token: "hidden", refreshToken: "hidden", api_key: "hidden" }, message: "failed Bearer abc-secret" }));
  const detail = await api.getLog("request-1");
  assert.equal(detail.item.key, "key-1");
  const raw = JSON.stringify(detail.raw);
  assert.ok(!raw.includes("abc-secret")); assert.ok(!raw.includes("session=value")); assert.ok(!raw.includes("hidden"));
  await assert.rejects(() => api.getLog("gone"), { status: 404 });
});

test("CodeBuddy usage respects time range, excludes internal keys and labels retention coverage", async () => {
  const { api, state } = fixture();
  state.logs.request = [record("a", NOW + 2), record("b", NOW + 3, { api_key: "internal" }), record("c", NOW - 100)];
  const data = await api.usage({ from: new Date(NOW * 1000).toISOString(), to: new Date((NOW + 5) * 1000).toISOString(), bucket: "hour", excludeKeys: ["internal"] });
  assert.equal(data.series.length, 1); assert.equal(data.series[0].requests, 1);
  assert.equal(data.series[0].bucket, new Date(Math.floor(NOW / 3600) * 3600000).toISOString());
  assert.equal(data.byKey[0].name, "key-1"); assert.equal(data.byAccount[0].name, "account-1");
  assert.equal(data.extras.coverage, "retained-request-logs");
  assert.equal(data.excludesInternalKeys, true);
});

test("CodeBuddy default usage covers the UTC+8 day and uses full ISO day buckets", async (t) => {
  const { api, state, calls } = fixture();
  t.mock.method(Date, "now", () => Date.parse("2026-11-11T00:30:00Z"));
  state.logs.request = [record("before", todayStart - 1), record("start", todayStart), record("later", todayStart + 8 * 3600)];
  const data = await api.usage();
  assert.equal(calls[0].query.from, todayStart);
  assert.equal(calls[0].query.to, Date.now() / 1000);
  assert.equal(data.series.length, 1);
  assert.equal(data.series[0].bucket, "2026-11-10T16:00:00.000Z");
  assert.equal(data.series[0].requests, 2);
  assert.equal(data.series[0].inputTokens, 20);
  assert.equal(data.series[0].outputTokens, 10);
  const range = await api.usage({ from: "2026-11-09T16:00:00Z", to: "2026-11-11T16:00:00Z" });
  assert.deepEqual(range.series.map((row) => [row.bucket, row.requests]), [["2026-11-10T16:00:00.000Z", 2], ["2026-11-09T16:00:00.000Z", 1]]);
});

test("CodeBuddy settings omit locked controls, blank secrets and retain optimistic conflicts", async () => {
  const { api, state, calls } = fixture();
  await assert.rejects(() => api.saveSettings("runtime", { audit_retention_days: 14 }), { status: 409 });
  const data = await api.settings();
  assert.equal(data.groups[0].revision, 7);
  const fields = data.groups[0].fields;
  assert.equal(fields.find((field) => field.key === "stream_mode").type, "select");
  assert.equal(fields.find((field) => field.key === "audit_retention_days").min, 1);
  assert.equal(fields.find((field) => field.key === "test_secret").value, "");
  assert.ok(!fields.some((field) => field.key === "api_key"));
  assert.ok(!JSON.stringify(data).includes("never-return"));
  state.revision = 8;
  await assert.rejects(() => api.saveSettings("runtime", { audit_retention_days: 14 }), { status: 409 });
  assert.equal(calls.at(-1).body.revision, 7);
  await api.saveSettings("runtime", { revision: 8, audit_retention_days: 14, test_secret: "" });
  assert.equal(calls.at(-1).body.values.test_secret, undefined);
  assert.equal(state.settings[0].value, 14);
  await assert.rejects(() => api.saveSettings("runtime", { api_key: "evil" }), { status: 400 });
});

test("CodeBuddy capabilities degrade on missing APIs while auth errors stay visible", async () => {
  const { api, calls } = fixture({ missing: ["/admin/keys", "/admin/logs"] });
  assert.deepEqual(api.keyManagement, { list: "/admin/keys", items: "items", prefix: "/admin/keys/", revealSuffix: "/reveal" });
  const caps = await api.capabilities();
  assert.equal(caps.keys.create, false); assert.equal(caps.keys.reveal, false); assert.equal(caps.keys.resetUsage, false);
  assert.equal(caps.models.toggle, true); assert.deepEqual(caps.logs.kinds, []);
  assert.ok(calls.every((call) => call.method === "GET"));
  await assert.rejects(() => fixture({ failure: { path: "/admin/keys", status: 401 } }).api.capabilities(), { code: "upstream_error" });
});

test("CodeBuddy internal credentials never adopt or rotate a user's same-name key", async () => {
  const { adapter, state, calls } = fixture();
  state.rows[0].name = "platform2api 统一入口";
  const [first, concurrent] = await Promise.all([adapter.ensureUpstreamCredential(), adapter.ensureUpstreamCredential()]);
  assert.equal(first.id, concurrent.id); assert.notEqual(first.id, "key-1");
  assert.match(first.name, /^platform2api 统一入口 /);
  assert.equal(state.rows[0].version, 1);
  const second = await adapter.ensureUpstreamCredential({ force: true, previous: first });
  assert.notEqual(first.id, second.id);
  assert.equal(calls.filter((call) => call.method === "POST").length, 2);
  assert.ok(!calls.some((call) => /rotate|reveal/.test(call.path)));
  assert.ok(adapter.inference().routes.includes("/v1/messages"));
  assert.ok(adapter.inference().routes.includes("/v1/images/edits"));
  assert.equal(adapter.inference().url, "http://127.0.0.1:8787");
});

test("CodeBuddy account descriptors use stable identity and never expose native credentials", async () => {
  const { adapter, state } = fixture();
  state.accounts = [{ id: "account-key", name: "file-name.json", profile: "cn-cli", uid: "uid1", enabled: true,
    refresh_token: "secret", accessToken: "other-secret", usage_stats: { last_request_at: NOW }, token_expires_at: NOW + 3600, auto_checkin: true,
    credits: { credits: 15, segments: [{ total: 20 }] } }];
  const [account] = await adapter.listAccounts();
  assert.equal(account.nativeId, "account-key");
  assert.equal(account.lastUsedAt, new Date(NOW * 1000).toISOString());
  assert.ok(account.display.some((field) => field.kind === "time"));
  assert.ok(!JSON.stringify(account).includes("other-secret"));
  assert.deepEqual(account.quota, { unit: "credits", total: 20, remaining: 15, used: 5, percent: 25 });
});

test("CodeBuddy overview derives today's UTC+8 counters from complete native hourly coverage", async (t) => {
  const { adapter, state, calls } = fixture();
  t.mock.method(Date, "now", () => Date.parse("2026-11-11T00:30:00Z"));
  const series = Array.from({ length: 9 }, (_, n) => hourly(todayStart + n * 3600));
  Object.assign(series[0], { requests: 2, input_tokens: 11, output_tokens: 12, error: 1, input_tokens_known: 2, output_tokens_known: 2 });
  Object.assign(series[8], { requests: 3, input_tokens: 21, output_tokens: 22, cancelled: 1, input_tokens_known: 3, output_tokens_known: 3 });
  state.dashboard = { summary: { requests: 999 }, range: { granularity: "hour", partial: false },
    series: [hourly(todayStart - 3600, { requests: 99 }), ...series.reverse(), hourly(todayStart + 9 * 3600, { requests: 99 })] };
  const overview = await adapter.overview();
  assert.deepEqual(calls[0].query, { days: 7, granularity: "hour" });
  assert.equal(overview.days, 1);
  assert.equal(overview.requests, 5);
  assert.equal(overview.requestsToday, 5); assert.equal(overview.tokensToday, 66); assert.equal(overview.errorsToday, 2);
  assert.equal(overview.partial, false);
  assert.deepEqual(overview.hourly.map((row) => row.requests), [2, 0, 0, 0, 0, 0, 0, 0, 3]);
  assert.equal(overview.hourly[0].hour, "2026-11-10T16:00:00.000Z");
  assert.equal(overview.hourly.at(-1).hour, "2026-11-11T00:00:00.000Z");
});

test("CodeBuddy overview treats native padded zero-request hours as known zero token usage", async (t) => {
  const { adapter, state } = fixture();
  t.mock.method(Date, "now", () => Date.parse("2026-11-10T16:15:00Z"));
  state.dashboard = { range: { granularity: "hour", partial: false }, series: [hourly(todayStart)] };
  const overview = await adapter.overview();
  assert.equal(overview.requestsToday, 0); assert.equal(overview.tokensToday, 0); assert.equal(overview.errorsToday, 0);
  assert.equal(overview.partial, false);
  assert.equal(overview.hourly[0].hour, "2026-11-10T16:00:00.000Z");
});

for (const [label, change, knownRequests] of [
  ["missing hour", (body) => body.series.splice(1, 1), false],
  ["native partial coverage", (body) => { body.range.partial = true; }, false],
  ["degraded storage", (body) => { body.degraded = true; }, false],
  ["non-hourly data", (body) => { body.range.granularity = "day"; }, false],
  ["duplicate hour", (body) => { body.series.push({ ...body.series[2] }); }, false],
  ["unknown token total", (body) => { body.series[2].input_tokens = null; }, true],
  ["partially known token total", (body) => { body.series[2].output_tokens_known = 1; }, true],
]) test(`CodeBuddy overview keeps ${label} explicitly incomplete`, async (t) => {
  const { adapter, state } = fixture();
  t.mock.method(Date, "now", () => Date.parse("2026-11-10T18:15:00Z"));
  state.dashboard = { range: { granularity: "hour", partial: false }, series: [hourly(todayStart), hourly(todayStart + 3600),
    hourly(todayStart + 7200, { requests: 2, input_tokens: 10, output_tokens: 5, input_tokens_known: 2, output_tokens_known: 2 })] };
  change(state.dashboard);
  const overview = await adapter.overview();
  assert.equal(overview.partial, true);
  assert.equal(overview.requestsToday, knownRequests ? 2 : null);
  assert.equal(overview.errorsToday, knownRequests ? 0 : null);
  assert.equal(overview.tokensToday, null);
  assert.match(overview.healthMessage, /不完整/);
});

test("CodeBuddy explicit overview periods retain native totals and granularity", async () => {
  const { adapter, state, calls } = fixture();
  state.dashboard = { summary: { requests: 123 }, storage: { db_bytes: 100 } };
  const overview = await adapter.overview({ days: 30, granularity: "day" });
  assert.deepEqual(calls[0].query, { days: 30, granularity: "day" });
  assert.equal(overview.days, 30);
  assert.equal(overview.requests, 123);
  assert.equal(overview.requestsToday, undefined);
  assert.equal(overview.partial, undefined);
  assert.deepEqual(overview.storage, { db_bytes: 100 });
});

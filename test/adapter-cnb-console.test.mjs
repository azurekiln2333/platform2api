import test from "node:test";
import assert from "node:assert/strict";
import createCnbAdapter from "../src/adapters/cnb.mjs";
import { AdapterError } from "../src/adapters/client.mjs";

const NOW = "2026-11-11T08:00:00.000Z";
const ID = "00000000-0000-4000-8000-000000000001";
const fixture = ({ missing = [], fail = {}, legacyLogs = false, logs: initialLogs, history: suppliedHistory, overview: suppliedOverview } = {}) => {
  const seen = [];
  const settings = { strategy: "weighted", sessionAffinity: true, maxAttempts: 3, cooldownSeconds: 60,
    healthIntervalSeconds: 60, connectTimeoutSeconds: 20, idleTimeoutSeconds: 300, dshCompat: true,
    claudeCodeCompat: true, quotaProtection: { enabled: true, thresholdPercent: 10 },
    inferenceProbe: { enabled: false, intervalMinutes: 30 }, requestOverrides: { operations: [] },
    upstreamHeaders: { "x-token": "private-header" }, registrationRelay: { enabled: false, servers: [] } };
  const auth = { ssoEnabled: false, keyLoginEnabled: true, providerName: "Company", issuer: "https://issuer.test",
    clientId: "client", clientSecret: "must-not-appear", hasClientSecret: true, scope: "openid email",
    allowedEmails: [], allowedSubjects: [], callbackUrl: "https://panel.test/api/auth/oidc/callback" };
  const logs = initialLogs ?? [{ id: ID, at: NOW, kind: "request", model: "claude-sonnet", accountId: "a1", accountName: "Account 1",
    status: 200, durationMs: 450, stream: true, tokenUsage: { input: 1200, output: 40 },
    requestDiagnostics: { headers: { Authorization: "Bearer request-secret", "x-api-key": "request-secret" }, accessToken: "access-secret" } }];
  const history = suppliedHistory ?? { range: { days: 7, from: "2026-11-05", to: "2026-11-11" },
    days: [{ date: "2026-11-10", requests: 2, tokenUsage: { input: 40, output: 5 } }, { date: "2026-11-11", requests: 3, tokenUsage: { input: 50, output: 6 } }],
    accounts: [{ accountId: "a1", name: "Account 1", requests: 5, tokenUsage: { input: 90, output: 11 } }] };
  const client = { async request(path, options = {}) {
    seen.push({ path, ...options });
    if (missing.includes(path)) return { ok: false, status: 404, body: { error: { message: "接口不存在" } } };
    if (fail[path]) return { ok: false, status: fail[path], body: { error: { message: "服务故障" } } };
    const reply = (body) => ({ ok: true, status: 200, body });
    if (path === "/health") return reply({ status: "ok", ready: 1 });
    if (path === "/api/access") return reply({ maskedKey: "gw-123••••••••5678", publicUrl: "https://cnb.test" });
    if (path === "/api/access/key") return reply({ key: "internal-gateway-secret" });
    if (path === "/api/accounts") return reply({ accounts: [{ id: "a1", name: "Account 1", status: "healthy", enabled: true,
      endpoint: "https://workspace.test", repo: "org/repo", quota: { credits: { total: 100, used: 20, freeze: 0 } },
      secrets: { proxyKey: "secret" }, registrationToken: "registration-secret", hasPat: true, lastUsedAt: NOW }] });
    if (path === "/api/accounts/a1") return reply({ account: { id: "a1", ...options.body } });
    if (path === "/api/models") return reply({ models: [{ id: "claude-sonnet", listed: true, eligibleAccounts: [{ id: "a1", name: "Account 1" }], configuredAccounts: [], discoveredAccounts: [] }] });
    if (path === "/api/logs/system") return reply({ logs: [{ id: "event1", at: NOW, kind: "probe", message: "探活完成" }], total: 1, offset: 0 });
    if (path === "/api/logs/requests") {
      const query = options.query ?? {};
      const matching = logs.filter((entry) => !query.outcome || (query.outcome === "success" ? entry.status < 400 : entry.status >= 400))
        .filter((entry) => !query.q || JSON.stringify(entry).toLowerCase().includes(String(query.q).toLowerCase()));
      const offset = Number(query.offset ?? 0), limit = Number(query.limit ?? 20);
      return reply(legacyLogs ? { logs: matching } : { logs: matching.slice(offset, offset + limit), total: matching.length, offset, limit });
    }
    if (path.startsWith("/api/logs/requests/")) return reply({ log: logs.find((row) => row.id === decodeURIComponent(path.split("/").at(-1))) });
    if (path === "/api/overview") return reply(suppliedOverview ?? { hourly: [{ at: NOW, requests: 3, tokenUsage: { input: 50, output: 6 } }], creditRates: { window: "24h" } });
    if (path === "/api/usage/history") return reply(history);
    if (path === "/api/credits/rates") return reply({ window: options.query?.window, rows: [{ accountId: "a1", rate: 5 }] });
    if (path === "/api/usage/comparison") return reply({ accounts: [{ accountId: "a1", measured: 4 }] });
    if (path === "/api/settings") {
      if (options.method === "PATCH") Object.assign(settings, options.body);
      return reply({ settings });
    }
    if (path === "/api/auth/settings") {
      if (options.method === "PATCH") Object.assign(auth, options.body);
      return reply(auth);
    }
    return { ok: false, status: 404, body: { error: { message: "接口不存在" } } };
  } };
  const adapter = createCnbAdapter({ client, baseUrl: "http://mock-cnb.invalid", token: "management-only" });
  return { adapter, api: adapter.console, seen, settings, auth };
};

test("CNB capabilities probe reads real endpoints and never reveal credentials", async () => {
  const { api, seen } = fixture();
  const value = await api.capabilities();
  assert.deepEqual(value.accounts.add, ["credentials"]);
  assert.equal(value.keys.create, false);
  assert.equal(value.keys.reveal, false);
  assert.equal(value.models.toggle, false);
  assert.deepEqual(value.logs.filters, ["result", "q"]);
  assert.equal(value.logs.pagination, "offset");
  assert.ok(seen.every((call) => !call.method || call.method === "GET"));
  assert.ok(!seen.some((call) => call.path === "/api/access/key"));
  const keys = await api.listKeys();
  assert.equal(keys[0].id, "builtin");
  assert.equal(keys[0].builtin, true);
  assert.equal(keys[0].masked, "gw-123••••••••5678");
  assert.equal(JSON.stringify(keys).includes("internal-gateway-secret"), false);
});

test("CNB unavailable legacy endpoints disable only their capability", async () => {
  const { api } = fixture({ missing: ["/api/access", "/api/models", "/api/logs/system", "/api/usage/history"] });
  const value = await api.capabilities();
  assert.equal(value.keys.list, false);
  assert.equal(value.models.list, false);
  assert.deepEqual(value.logs.kinds, ["request"]);
  assert.deepEqual(await api.listKeys(), []);
  assert.deepEqual(await api.listModels(), []);
});

test("CNB outage is surfaced instead of being misclassified as unsupported", async () => {
  const { api } = fixture({ fail: { "/api/access": 503 } });
  await assert.rejects(api.capabilities(), (error) => error instanceof AdapterError && error.status === 502);
});

test("CNB unsupported key/model mutations never call upstream", async () => {
  const { api, seen } = fixture();
  for (const action of [() => api.createKey({ name: "x" }), () => api.updateKey("builtin", {}), () => api.deleteKey("builtin"), () => api.keyAction("builtin", "reveal"), () => api.modelAction("m", "toggle")])
    await assert.rejects(action(), (error) => error.status === 501);
  assert.equal(seen.length, 0);
});

test("CNB accounts add descriptors and safe actions without leaking stored secrets", async () => {
  const { adapter } = fixture();
  const [account] = await adapter.listAccounts();
  assert.equal(account.primary, "org/repo");
  assert.equal(account.lastUsedAt, NOW);
  assert.ok(account.display.some((field) => field.key === "quota" && field.kind === "quota"));
  assert.ok(account.actions.some((action) => action.id === "probe"));
  assert.ok(!account.actions.some((action) => ["credentials", "pat"].includes(action.id)));
  assert.equal(account.raw.secrets, undefined);
  assert.equal(account.raw.registrationToken, undefined);
  assert.equal((await adapter.accountAction("a1", "disable")).account.enabled, false);
});

test("CNB models normalize native availability descriptors without inventing toggles", async () => {
  const { api } = fixture();
  const [model] = await api.listModels();
  assert.equal(model.model, "claude-sonnet");
  assert.equal(model.enabled, null);
  assert.deepEqual(model.actions, []);
  assert.equal(model.display.find((field) => field.key === "eligibleAccounts").value, 1);
});

test("CNB log cursor does not drop sparse-filter matches or page tails", async () => {
  const logs = Array.from({ length: 17 }, (_, i) => ({ id: `r${i}`, at: new Date(Date.parse(NOW) - i * 1000).toISOString(), model: i % 2 ? "other" : "wanted", accountId: "a1", status: 200 }));
  const { api, seen } = fixture({ logs });
  let cursor;
  const ids = [];
  do {
    const page = await api.listLogs({ limit: 3, model: "wanted", cursor });
    ids.push(...page.items.map((row) => row.id));
    cursor = page.nextCursor;
  } while (cursor);
  assert.deepEqual(ids, logs.filter((row) => row.model === "wanted").map((row) => row.id));
  assert.ok(seen.filter((call) => call.path === "/api/logs/requests").every((call) => call.query.limit === 3));
  const page = await api.listLogs({ limit: 3 });
  await assert.rejects(api.listLogs({ limit: 3, model: "changed", cursor: page.nextCursor }), /游标无效/);
});

test("CNB logs support legacy unpaginated payloads without looping or duplicates", async () => {
  const logs = Array.from({ length: 7 }, (_, i) => ({ id: `old${i}`, at: NOW, status: 200 }));
  const { api } = fixture({ legacyLogs: true, logs });
  const first = await api.listLogs({ limit: 3 });
  assert.equal(first.pagination, "snapshot");
  assert.match(first.warning, /旧版/);
  const second = await api.listLogs({ limit: 3, cursor: first.nextCursor });
  const third = await api.listLogs({ limit: 3, cursor: second.nextCursor });
  assert.equal(third.nextCursor, null);
  assert.deepEqual([...first.items, ...second.items, ...third.items].map((row) => row.id), logs.map((row) => row.id));
});

test("CNB logs normalize token counters and redact request detail headers", async () => {
  const { api } = fixture();
  const page = await api.listLogs({ from: "2026-11-11T00:00:00Z", to: "2026-11-11T23:59:59Z", account: "cnb:a1", result: "success" });
  assert.equal(page.items[0].inputTokens, 1200);
  assert.equal(page.items[0].outputTokens, 40);
  assert.equal(page.items[0].stream, true);
  assert.equal(page.items[0].key, null);
  const detail = await api.getLog(ID);
  assert.equal(detail.raw.requestDiagnostics.headers.Authorization, "[REDACTED]");
  assert.equal(detail.raw.requestDiagnostics.accessToken, "[REDACTED]");
  assert.ok(detail.display.some((field) => field.kind === "time"));
  const events = await api.listLogs({ kind: "system" });
  assert.equal((await api.getLog(events.items[0].id)).raw.message, "探活完成");
});

test("CNB usage preserves native units and never labels full-window ranking as a subrange", async () => {
  const { api } = fixture();
  const total = await api.usage();
  assert.equal(total.series.length, 2);
  assert.equal(total.byAccount[0].inputTokens, 90);
  assert.deepEqual(total.byModel, []);
  assert.deepEqual(total.byKey, []);
  assert.ok(total.extras["credit-rates"]);
  const range = await api.usage({ from: "2026-11-11T00:00:00+08:00", to: "2026-11-11T23:59:59.999+08:00" });
  assert.deepEqual(range.series.map((row) => row.bucket), ["2026-11-11"]);
  assert.deepEqual(range.byAccount, []);
  assert.match(range.extras.limitations.join(" "), /全窗口/);
});

test("CNB settings expose only present fields, preserve secret placeholders, and scope writes", async () => {
  const { api, seen, settings } = fixture();
  const result = await api.settings();
  assert.equal(result.groups.find((group) => group.id === "auth").fields.find((field) => field.key === "clientSecret").value, "");
  assert.equal(JSON.stringify(result).includes("must-not-appear"), false);
  assert.equal(JSON.stringify(result).includes("private-header"), false);
  assert.ok(result.embeds.includes("cnb-registration-relay"));
  await api.saveSettings("scheduling", { maxAttempts: 5 });
  assert.equal(settings.maxAttempts, 5);
  await api.saveSettings("auth", { clientSecret: "", providerName: "Updated" });
  assert.deepEqual(seen.filter((call) => call.path === "/api/auth/settings" && call.method === "PATCH").at(-1).body, { providerName: "Updated" });
  await assert.rejects(api.saveSettings("scheduling", { clientSecret: "injected" }), /不支持的设置项/);
  await assert.rejects(api.saveSettings("scheduling", { maxAttempts: 99 }), /格式不正确/);
});

test("CNB inference descriptor and internal credential bootstrap match actual routes", async () => {
  const { adapter, seen } = fixture();
  assert.deepEqual(adapter.inference(), { url: "http://mock-cnb.invalid", routes: ["/v1/chat/completions", "/v1/responses", "/v1/messages", "/v1/messages/count_tokens"] });
  const credential = await adapter.ensureUpstreamCredential();
  assert.deepEqual(credential, { secret: "internal-gateway-secret", id: "builtin", name: "CNB 内置网关密钥", shared: true });
  assert.equal(seen.at(-1).path, "/api/access/key");
  assert.equal(seen.at(-1).method, "POST");
  assert.equal(JSON.stringify(await adapter.console.listKeys()).includes(credential.secret), false);
});

test("CNB declares wake-all as a channel action and marks card quick actions", async () => {
  const { adapter, api } = fixture();
  assert.deepEqual(adapter.channelActions.map((entry) => [entry.id, entry.accountAction]), [["wake-all", "wake"]]);
  assert.deepEqual((await api.capabilities()).accounts.channelActions, [{ id: "wake-all", label: "唤醒全部工作区" }]);
  const [account] = await adapter.listAccounts();
  assert.deepEqual(account.actions.filter((action) => action.quick).map((action) => action.id), ["probe", "quota", "wake"]);
  const repo = account.display.find((field) => field.key === "repo");
  assert.equal(repo.kind, "link");
  assert.equal(repo.href, "https://cnb.cool/org/repo");
});

test("CNB overview sections mirror the native overview without probing upstream", async () => {
  const now = Date.now();
  const { api, seen } = fixture({
    overview: {
      accounts: [
        { id: "a1", name: "Account 1", status: "healthy", enabled: true, endpoint: "https://workspace.test",
          repo: "org/repo", quota: { credits: { total: 100, used: 20, freeze: 5 }, syncedAt: NOW } },
        { id: "a2", name: "Account 2", status: "unhealthy", enabled: true, repo: "org/repo2", lastError: "Bearer workspace-secret",
          quota: { credits: { total: 50, used: 10, freeze: 0 } } },
        { id: "a3", name: "Account 3", status: "pending", enabled: false },
      ],
      stats: { total: 3, ready: 1, cooling: 0, requests: 12, errors: 2, successRate: 83.3, averageDurationMs: 450,
        activeRequests: 1, remainingCredits: 75, quotaOrganizations: 1,
        tokenUsage: { today: { input: 100, output: 20, cacheRead: 10, cacheWrite: 5, total: 120,
          reportedRequests: 4, missingRequests: 1, partialRequests: 0 }, total: {}, startedAt: NOW } },
      hourly: [{ at: new Date(now).toISOString(), requests: 12, errors: 2 }],
    },
  });
  const sections = await api.overviewSections();
  const byId = Object.fromEntries(sections.map((section) => [section.id, section]));
  assert.deepEqual(Object.keys(byId).sort(),
    ["account-quota", "accounts", "attention", "history", "hourly", "quota", "today", "tokens"]);
  const metric = (id, label) => byId[id].items.find((item) => item.label === label);
  assert.equal(metric("accounts", "可用工作区").value, 1);
  assert.equal(metric("accounts", "可用比例").value, 33.3);
  assert.equal(metric("accounts", "已停用").value, 1);
  assert.equal(metric("today", "请求成功率").value, 83.3);
  assert.equal(metric("tokens", "未上报请求").tone, "warn");
  assert.equal(metric("quota", "剩余 Credits").value, 75);
  assert.equal(byId["account-quota"].items[0].remaining, 75);
  assert.equal(byId["account-quota"].items[0].status, "ok");
  assert.equal(byId["account-quota"].items[1].status, "error");
  assert.deepEqual(byId.hourly.buckets.at(-1).values, { 请求: 12, 失败: 2 });
  assert.deepEqual(byId.attention.rows.map((row) => row["账号"]), ["Account 2"]);
  assert.deepEqual(byId.attention.columns.map((column) => column.kind), ["text", "badge", "text", "time", "time"]);
  assert.equal(byId.attention.rows[0]["最近错误"], "Bearer [REDACTED]");
  assert.equal(byId.history.rows.length, 2);
  // Only the service's own local read routes are touched: no probe, no quota sync.
  assert.deepEqual([...new Set(seen.map((call) => call.path))].sort(),
    ["/api/credits/rates", "/api/overview", "/api/usage/history"]);
  assert.ok(seen.every((call) => !call.method || call.method === "GET"));
});

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import createZcodeAdapter, { accountState, normalizeQuota, toEntry } from "../src/adapters/zcode.mjs";
import { AdapterError, createServiceClient } from "../src/adapters/client.mjs";
import { createRegistry } from "../src/adapters/index.mjs";

const TOKEN = "zcode-platform-token";

test("ZCode preserves native email and Unicode labels and encodes exactly one path segment", async () => {
  const seen = [];
  const adapter = createZcodeAdapter({ baseUrl: "http://127.0.0.1:1", client: { request: async (path, options) => {
    seen.push({ path, options }); return { ok: true, status: 200, body: { ok: true } };
  } } });
  for (const label of ["account+ops@example.test", "中文 账号@示例.test", " keep@exact.test "]) {
    assert.equal(toEntry({ label }).nativeId, label);
    await adapter.accountAction(label, "update", { enabled: false });
    assert.equal(seen.at(-1).path, `/api/accounts/${encodeURIComponent(label)}`);
  }
  const calls = seen.length;
  for (const label of ["a/b", "a\\b", "..", "%2F", "a?b", "a#b", "a\u0000b", "a\u0085b", "a\uD800b"]) {
    await assert.rejects(() => adapter.accountAction(label, "refresh"), (error) => error.status === 400);
  }
  assert.equal(seen.length, calls);
});

const listen = async (server) => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
};

const close = async (server) => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
};

const json = (res, body, status = 200) => {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
};

const zcodeAccount = {
  label: "zc-acc-1",
  name: "ZCode 主账号",
  email: "zc@example.test",
  enabled: true,
  status: "healthy",
  cooldownUntil: 0,
  quota: { org: "zc-acc-1", credits: { total: 400, used: 100, freeze: 0 }, syncedAt: "2026-11-09T09:00:00.000Z" },
  hasCodingPlanKey: true,
  eligibility: { status: "eligible" },
};

async function fixture(t, { requireToken = true } = {}) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://zcode.local");
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    const record = {
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: req.headers,
      body: raw ? JSON.parse(raw) : null,
    };
    seen.push(record);
    if (requireToken && record.headers.authorization !== `Bearer ${TOKEN}`)
      return json(res, { error: "未登录或会话已过期" }, 401);

    if (record.path === "/health") return json(res, { ok: true, version: "1.4.0", accounts: 1, keys: 2 });
    if (record.path === "/api/overview") {
      return json(res, {
        accounts: [zcodeAccount],
        settings: { strategy: "weighted", topN: 3 },
        hourly: [{ at: "2026-11-09T10:00:00.000Z", requests: 4, errors: 0 }],
        stats: {
          total: 1,
          ready: 1,
          cooling: 0,
          requestS: 0,
          requests: 12,
          errors: 1,
          successRate: 91.7,
          remainingCredits: 300,
          totalCredits: 400,
          quotaOrganizations: 1,
          activeRequests: 1,
        },
        claimAutomation: { running: false },
      });
    }
    if (record.path === "/api/accounts/zc-acc-1" && req.method === "PATCH")
      return json(res, { ok: true, account: "zc-acc-1" });
    if (record.path === "/api/accounts/zc-acc-1/refresh" && req.method === "POST")
      return json(res, { quotaSources: [], eligibility: { status: "eligible" } });
    if (record.path === "/api/accounts/zc-acc-1/selftest" && req.method === "POST")
      return json(res, { jobId: "job-9", status: "running" }, 202);
    if (record.path === "/api/accounts/zc-acc-1/selftest/job-9" && req.method === "GET")
      return json(res, { jobId: "job-9", status: "done", ok: true, steps: [] });
    if (record.path === "/api/accounts/zc-acc-1/claim/start" && req.method === "POST")
      return json(res, { preparationId: "prep-1", plan: { id: "plan-1" }, expiresAt: 0 });
    if (record.path === "/api/accounts/zc-acc-1/claim" && req.method === "POST")
      return json(res, { ok: true, claim: { ok: true } });
    if (record.path === "/api/onboard/start" && req.method === "POST")
      return json(res, {
        flowId: "flow-1",
        authorizeUrl: "https://zcode.test/authorize?state=st-1",
        expiresAt: "2026-11-09T10:20:00.000Z",
        pollIntervalSec: 3,
        provider: "zai",
      });
    if (record.path === "/api/onboard/poll/flow-1") return json(res, { status: "pending" });
    if (record.path === "/api/onboard/poll/flow-2")
      return json(res, { status: "ready", added: true, label: "zc-acc-2", email: "a@b.c", claim: { ok: false } });
    if (record.path === "/api/onboard/poll/gone") return json(res, { error: "flow 不存在或已过期", code: "flow_missing" }, 410);
    if (record.path === "/api/onboard/redeem" && req.method === "POST")
      return json(res, { status: "ready", label: "zc-acc-2", claim: { ok: false, code: "captcha_required" } });
    if (record.path === "/keys" && req.method === "GET")
      return json(res, { keys: [{ id: 1, name: "k1" }], total: 1, masterKeyEnabled: true, openMode: false });
    if (record.path === "/keys" && req.method === "POST") return json(res, { key: { id: 2 }, secret: "sk-full" });
    if (record.path === "/keys/2/update" && req.method === "POST") return json(res, { key: { id: 2, name: "k2" } });
    if (record.path === "/pool/settings" && req.method === "GET")
      return json(res, { settings: { topN: 3 }, limits: { topN: [1, 9] }, fromFile: true });
    if (record.path === "/api/settings" && req.method === "PATCH")
      return json(res, { ok: true, applied: { topN: 4 }, settings: { strategy: "weighted", topN: 4 } });
    if (record.path === "/security" && req.method === "POST") return json(res, { toggled: true });
    return json(res, { error: `no console api route ${record.method} ${record.path}` }, 404);
  });
  const baseUrl = await listen(server);
  t.after(() => close(server));
  return { baseUrl, seen };
}

const adapterFor = (baseUrl, token = TOKEN) =>
  createZcodeAdapter({
    system: "zcode",
    baseUrl,
    token,
    timeoutMs: 5000,
    client: createServiceClient({ system: "zcode", baseUrl, token, timeoutMs: 5000 }),
  });

test("zcode adapter authenticates every call with the platform bearer", async (t) => {
  const { baseUrl, seen } = await fixture(t);
  const adapter = adapterFor(baseUrl);
  await adapter.health();
  await adapter.listAccounts();
  assert.equal(seen[0].headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(seen[1].headers.authorization, `Bearer ${TOKEN}`);
});

test("zcode registry resolves the real module instead of the stub", async (t) => {
  const { baseUrl } = await fixture(t);
  const registry = await createRegistry({ systems: [{ system: "zcode", baseUrl, token: TOKEN, timeoutMs: 5000 }] });
  assert.equal(registry.isStub("zcode"), false);
  assert.equal((await registry.get("zcode").health()).status, "ok");
});

test("zcode overview keeps ZCode quota and usage on its own section", async (t) => {
  const { baseUrl } = await fixture(t);
  const overview = await adapterFor(baseUrl).overview();
  assert.equal(overview.health, "ok");
  assert.equal(overview.quota.total, 400);
  assert.equal(overview.quota.remaining, 300);
  assert.equal(overview.quota.used, 100);
  assert.equal(overview.accounts.total, 1);
  assert.equal(overview.stats.successRate, 91.7);
  assert.equal(overview.settings.topN, 3);
  assert.equal(overview.claimAutomation.running, false);
  assert.equal(overview.usage.find((metric) => metric.label === "成功率").value, 91.7);
});

test("zcode listAccounts reads the console overview feed and keeps labels as ids", async (t) => {
  const { baseUrl, seen } = await fixture(t);
  const entries = await adapterFor(baseUrl).listAccounts();
  assert.deepEqual(seen.map((record) => record.path), ["/api/overview"]);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].nativeId, "zc-acc-1");
  assert.equal(entries[0].quota.remaining, 300);
  assert.equal(entries[0].detail, "zc@example.test");
  assert.equal(entries[0].raw.hasCodingPlanKey, true);
});

test("zcode accountAction maps console subroutes including the async self-test", async (t) => {
  const { baseUrl, seen } = await fixture(t);
  const adapter = adapterFor(baseUrl);
  const updated = await adapter.accountAction("zc-acc-1", "update", { enabled: false });
  assert.deepEqual(updated, { ok: true, account: "zc-acc-1" });
  await adapter.accountAction("zc-acc-1", "refresh", {});
  const started = await adapter.accountAction("zc-acc-1", "selftest", {});
  assert.equal(started.jobId, "job-9");
  const result = await adapter.accountAction("zc-acc-1", "selftest-result", { jobId: started.jobId });
  assert.equal(result.status, "done");
  await adapter.accountAction("zc-acc-1", "claim-start", { planId: "plan-1" });
  await adapter.accountAction("zc-acc-1", "claim", {});
  assert.deepEqual(
    seen.map((record) => `${record.method} ${record.path}`),
    [
      "PATCH /api/accounts/zc-acc-1",
      "POST /api/accounts/zc-acc-1/refresh",
      "POST /api/accounts/zc-acc-1/selftest",
      "GET /api/accounts/zc-acc-1/selftest/job-9",
      "POST /api/accounts/zc-acc-1/claim/start",
      "POST /api/accounts/zc-acc-1/claim",
    ],
  );
  assert.deepEqual(seen[4].body, { planId: "plan-1" });
  await assert.rejects(() => adapter.accountAction("zc-acc-1", "remove"), (error) => {
    assert.equal(error.name, "InputError");
    assert.equal(error.status, 400);
    return true;
  });
});

test("zcode enrollment maps native states onto the console flow vocabulary", async (t) => {
  const { baseUrl, seen } = await fixture(t);
  const adapter = adapterFor(baseUrl);
  const started = await adapter.startAuth({ provider: "zai" });
  assert.equal(started.flowId, "flow-1");
  assert.equal(started.status, "pending");
  assert.equal(started.url, "https://zcode.test/authorize?state=st-1");
  assert.equal(started.pollIntervalMs, 3000);
  assert.equal(seen[0].body.provider, "zai");

  const pending = await adapter.pollAuth("flow-1");
  assert.equal(pending.status, "pending");

  const ready = await adapter.pollAuth("flow-2");
  assert.equal(ready.status, "success");
  assert.equal(ready.accountId, "zc-acc-2");

  const expired = await adapter.pollAuth("gone");
  assert.equal(expired.status, "expired");

  const redeemed = await adapter.completeAuth("flow-1", { url: "https://x/callback?code=c&state=st-1" });
  assert.equal(redeemed.status, "success");
  assert.equal(redeemed.flowId, "flow-1");
  assert.equal(seen.at(-1).body.flowId, "flow-1");
  assert.equal(seen.at(-1).body.url, "https://x/callback?code=c&state=st-1");
});

test("zcode legacy root routes stay reachable through call()", async (t) => {
  const { baseUrl, seen } = await fixture(t);
  const adapter = adapterFor(baseUrl);
  assert.equal((await adapter.call("/keys")).body.total, 1);
  assert.equal((await adapter.call("/keys", { method: "POST", body: { name: "k2" } })).body.secret, "sk-full");
  await adapter.call("/keys/2/update", { method: "POST", body: { name: "k2" } });
  assert.equal((await adapter.call("/pool/settings")).body.fromFile, true);
  assert.equal((await adapter.call("/api/settings", { method: "PATCH", body: { topN: 4 } })).body.applied.topN, 4);
  const missing = await adapter.call("/api/nope");
  assert.equal(missing.status, 404);
  assert.deepEqual(seen.slice(0, 4).map((record) => `${record.method} ${record.path}`), [
    "GET /keys",
    "POST /keys",
    "POST /keys/2/update",
    "GET /pool/settings",
  ]);
});

test("zcode adapter fails loudly on a rejected token and on invalid input", async (t) => {
  const { baseUrl } = await fixture(t);
  const stale = adapterFor(baseUrl, "stale");
  await assert.rejects(() => stale.overview(), (error) => {
    assert.ok(error instanceof AdapterError);
    assert.equal(error.status, 401);
    assert.match(error.message, /未登录/);
    return true;
  });
  const adapter = adapterFor(baseUrl);
  await assert.rejects(() => adapter.accountAction("bad/label", "refresh"), (error) => error.status === 400);
  await assert.rejects(() => adapter.accountAction("zc-acc-1", "selftest-result", {}), (error) => error.status === 400);
  await assert.rejects(() => adapter.pollAuth("bad flow"), (error) => error.status === 400);
  assert.throws(() => createZcodeAdapter({ system: "zcode", baseUrl, token: TOKEN }), /shared service client/);
});

test("zcode health degrades to down instead of throwing", async () => {
  const baseUrl = "http://127.0.0.1:1";
  const adapter = createZcodeAdapter({
    system: "zcode",
    baseUrl,
    token: TOKEN,
    client: createServiceClient({ system: "zcode", baseUrl, token: TOKEN, timeoutMs: 2000 }),
  });
  const health = await adapter.health();
  assert.equal(health.status, "down");
});

test("zcode normalize helpers treat label as identity and disabled as state", () => {
  const entry = toEntry({ label: "zc-1", disabled: true, quota: zcodeAccount.quota });
  assert.equal(entry.nativeId, "zc-1");
  assert.equal(entry.enabled, false);
  assert.equal(entry.status, "disabled");
  assert.equal(entry.quota.remaining, 300);
  assert.equal(accountState({ label: "x", status: "unhealthy" }), "offline");
  assert.equal(accountState({ label: "x", lastErr: "boom" }), "offline");
  assert.equal(accountState({ label: "x", cooldownUntil: new Date(Date.now() + 60_000).toISOString() }), "cooling");
  assert.equal(normalizeQuota({}), null);
  assert.equal(normalizeQuota({ quota: { credits: { total: 10, used: 4, freeze: 1 } } }).remaining, 5);
});

// ── Panel integration: ZCode reaches the panel through P1's real endpoints ──

const ADMIN = "zcode-panel-integration-key";

const panelClient = (base) => {
  let cookie = "";
  const request = async (path, options = {}) => {
    const headers = { ...(options.headers || {}) };
    if (cookie) headers.cookie = cookie;
    const response = await fetch(`${base}${path}`, { ...options, headers, redirect: "manual" });
    for (const value of response.headers.getSetCookie?.() || []) {
      const pair = value.split(";")[0];
      if (pair.startsWith("platform_session=")) cookie = pair.endsWith("=") ? "" : pair;
    }
    const text = await response.text();
    let body = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON responses stay text */
    }
    return { status: response.status, headers: response.headers, body };
  };
  return {
    request,
    async login(key = ADMIN) {
      return request("/api/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key }),
      });
    },
  };
};

async function panelWithZcode(t, baseUrl) {
  const { createPanelServer } = await import("../src/app.mjs");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dataDir = mkdtempSync(join(tmpdir(), "platform-zcode-"));
  const instance = createPanelServer({
    adminKey: ADMIN,
    dataDir,
    allowLocal: true,
    systems: [{ system: "zcode", baseUrl, token: TOKEN, timeoutMs: 5000 }],
    logger: { warn() {}, error() {} },
  });
  t.after(async () => {
    instance.server.closeAllConnections?.();
    await new Promise((resolve) => instance.server.close(resolve));
    rmSync(dataDir, { recursive: true, force: true });
  });
  instance.server.listen(0, "127.0.0.1");
  await once(instance.server, "listening");
  const base = `http://127.0.0.1:${instance.server.address().port}`;
  const api = panelClient(base);
  assert.equal((await api.login()).status, 200);
  return { api, registry: await instance.registry };
}

test("panel resolves the ZCode adapter module instead of the stub", async (t) => {
  const { baseUrl } = await fixture(t);
  const { registry } = await panelWithZcode(t, baseUrl);
  assert.equal(registry.isStub("zcode"), false);
});

test("panel lists ZCode accounts from the console overview feed", async (t) => {
  const { baseUrl } = await fixture(t);
  const { api } = await panelWithZcode(t, baseUrl);
  const result = await api.request("/api/accounts?system=zcode");
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.accounts.map((account) => account.id), ["zcode:zc-acc-1"]);
  assert.deepEqual(result.body.accounts[0].tags, ["zcode"]);
  assert.equal(result.body.accounts[0].quota.remaining, 300);
});

test("panel overview isolates the ZCode card", async (t) => {
  const { baseUrl } = await fixture(t);
  const { api } = await panelWithZcode(t, baseUrl);
  const result = await api.request("/api/overview");
  assert.equal(result.status, 200);
  assert.equal(result.body.zcode.ok, true);
  assert.equal(result.body.zcode.quota.remaining, 300);
  assert.equal(result.body.zcode.health, "ok");
  assert.equal(result.body.zcode.overview, undefined);
  assert.equal(result.body.cnb, undefined);
});

test("panel proxies ZCode console and legacy root routes through /api/p/zcode", async (t) => {
  const { baseUrl, seen } = await fixture(t);
  const { api } = await panelWithZcode(t, baseUrl);
  const keys = await api.request("/api/p/zcode/keys");
  assert.equal(keys.status, 200);
  assert.equal(keys.body.total, 1);
  const pool = await api.request("/api/p/zcode/pool/settings");
  assert.equal(pool.status, 200);
  assert.equal(pool.body.fromFile, true);
  // A service 4xx keeps its own status instead of becoming a panel error.
  const missing = await api.request("/api/p/zcode/api/nope");
  assert.equal(missing.status, 404);
  assert.match(missing.body.error, /no console api route/);
  assert.deepEqual(seen.map((record) => record.path), ["/keys", "/pool/settings", "/api/nope"]);
});

test("panel routes the ZCode enrollment flow through the adapter", async (t) => {
  const { baseUrl, seen } = await fixture(t);
  const { api } = await panelWithZcode(t, baseUrl);
  const started = await api.request("/api/accounts/auth/zcode/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(started.status, 200);
  assert.equal(started.body.flowId, "flow-1");
  assert.equal(started.body.result.url, "https://zcode.test/authorize?state=st-1");
  assert.equal(seen.at(-1).path, "/api/onboard/start");

  const polled = await api.request("/api/accounts/auth/zcode/poll", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ flowId: "flow-2" }),
  });
  assert.equal(polled.status, 200);
  assert.equal(polled.body.result.status, "success");
  assert.equal(polled.body.result.accountId, "zc-acc-2");
});

// Every documented ZCode console and legacy root route the console exposes.
test("zcode adapter maps every documented console and legacy route", async (t) => {
  const { baseUrl, seen } = await fixture(t);
  const adapter = adapterFor(baseUrl);
  const call = (path, options) => adapter.call(path, options).then((result) => result.status);

  await call("/api/overview");
  await call("/api/models");
  await call("/api/logs", { query: { limit: 20, offset: 0, q: "", outcome: "all" } });
  await call("/api/logs", { query: { download: "1" } });
  await call("/api/access");
  await call("/api/access/key", { method: "POST", body: {} });
  await call("/api/settings", { method: "PATCH", body: { topN: 4 } });
  await call("/api/claim-automation");
  await call("/api/claim-automation", { method: "PATCH", body: { enabled: true } });
  await call("/api/claim-automation/run", { method: "POST", body: {} });
  await call("/api/claim-automation/cancel", { method: "POST", body: {} });
  await call("/api/onboard/start", { method: "POST", body: { provider: "zai" } });
  await call("/api/onboard/poll/flow-1");
  await call("/api/onboard/redeem", { method: "POST", body: { url: "x" } });
  await call("/keys");
  await call("/keys", { method: "POST", body: { name: "k2" } });
  await call("/keys/2/update", { method: "POST", body: {} });
  await call("/keys/2/delete", { method: "POST", body: {} });
  await call("/keys/2/reset", { method: "POST", body: {} });
  await call("/stats", { query: { range: "today" } });
  await call("/quota");
  await call("/security");
  await call("/security", { method: "POST", body: { enabled: true } });
  await call("/security/clear-blocked", { method: "POST", body: {} });
  await call("/pool");
  await call("/pool/settings");
  await call("/pool/settings", { method: "POST", body: { topN: 4 } });
  await call("/pool/reset", { method: "POST", body: {} });
  await call("/logs", { query: { limit: 20 } });
  await call("/claimable");
  await call("/selftest", { method: "POST", body: {} });
  await call("/accounts/identify", { method: "POST", body: {} });
  await call("/accounts/add", { method: "POST", body: { jwt: "eyJ.test", label: "zc-acc-1" } });
  await call("/accounts/update", { method: "POST", body: { label: "zc-acc-1", disabled: true } });
  await call("/health");

  assert.deepEqual(
    seen.map((record) => `${record.method} ${record.path}`),
    [
      "GET /api/overview",
      "GET /api/models",
      "GET /api/logs",
      "GET /api/logs",
      "GET /api/access",
      "POST /api/access/key",
      "PATCH /api/settings",
      "GET /api/claim-automation",
      "PATCH /api/claim-automation",
      "POST /api/claim-automation/run",
      "POST /api/claim-automation/cancel",
      "POST /api/onboard/start",
      "GET /api/onboard/poll/flow-1",
      "POST /api/onboard/redeem",
      "GET /keys",
      "POST /keys",
      "POST /keys/2/update",
      "POST /keys/2/delete",
      "POST /keys/2/reset",
      "GET /stats",
      "GET /quota",
      "GET /security",
      "POST /security",
      "POST /security/clear-blocked",
      "GET /pool",
      "GET /pool/settings",
      "POST /pool/settings",
      "POST /pool/reset",
      "GET /logs",
      "GET /claimable",
      "POST /selftest",
      "POST /accounts/identify",
      "POST /accounts/add",
      "POST /accounts/update",
      "GET /health",
    ],
  );
  assert.deepEqual(seen[2].query, { limit: "20", offset: "0", q: "", outcome: "all" });
  assert.deepEqual(seen[3].query, { download: "1" });
  assert.deepEqual(seen[19].query, { range: "today" });
});

import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import createCnbAdapter, { accountState, normalizeQuota } from "../src/adapters/cnb.mjs";
import { AdapterError, createServiceClient } from "../src/adapters/client.mjs";
import { createRegistry } from "../src/adapters/index.mjs";

const TOKEN = "cnb-platform-token";

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

const healthyAccount = {
  id: "acc-1",
  name: "CNB 主账号",
  enabled: true,
  status: "healthy",
  endpoint: "https://workspace.cnb.test",
  cooldownUntil: null,
  quota: {
    org: "org-a",
    credits: { total: 1000, used: 250, freeze: 50 },
    syncedAt: "2026-11-09T10:00:00.000Z",
  },
};

/** Minimal CNB stand-in answering the documented management routes. */
async function fixture(t, { requireToken = true, overview } = {}) {
  const seen = [];
  let account = { ...healthyAccount };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://cnb.local");
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
      return json(res, { error: { message: "请先登录管理面板" } }, 401);
    if (record.headers.origin) return json(res, { error: { message: "请求来源不匹配" } }, 403);

    if (record.path === "/health") return json(res, { status: "ok", ready: 1 });
    if (record.path === "/api/overview" && req.method === "GET") {
      return json(
        res,
        overview ?? {
          accounts: [account],
          settings: { strategy: "weighted" },
          hourly: [],
          creditRates: { window: "24h" },
          stats: { total: 1, ready: 1, cooling: 0, requests: 20, errors: 1, successRate: 95 },
        },
      );
    }
    if (record.path === "/api/accounts" && req.method === "GET") return json(res, { accounts: [account] });
    if (record.path === "/api/accounts" && req.method === "POST") {
      account = { ...healthyAccount, id: "acc-new", status: "pending", endpoint: null, name: record.body.name };
      return json(res, { account, registrationToken: "reg-secret" }, 201);
    }
    if (record.path === "/api/accounts/acc-1" && req.method === "GET") return json(res, { account });
    if (/^\/api\/accounts\/[\w-]+$/.test(record.path) && req.method === "GET") return json(res, { account });
    if (record.path.endsWith("/quota") && req.method === "POST")
      return json(res, { quota: account.quota });
    if (record.path === "/api/accounts/acc-1" && req.method === "PATCH")
      return json(res, { account: { ...account, ...record.body } });
    if (record.path === "/api/accounts/acc-1" && req.method === "DELETE") return json(res, { ok: true });
    if (record.path === "/api/accounts/acc-1/registration" && req.method === "POST")
      return json(res, { registrationToken: "rotated-token" });
    if (/\/registration$/.test(record.path) && req.method === "POST")
      return json(res, { registrationToken: "reg-secret" });
    if (/\/probe$/.test(record.path) && req.method === "POST")
      return json(res, { account: { ...account, status: "healthy", endpoint: "https://w.test" } });
    // Any other documented account action (inference-probe, wake, registration,
    // pat, credentials) answers with a payload the adapter forwards untouched.
    if (/\/api\/accounts\/[\w-]+\/[\w-]+$/.test(record.path) && req.method === "POST")
      return json(res, { ok: true, action: record.path.split("/").at(-1) });
    if (record.path === "/api/accounts/acc-1/credentials" && req.method === "POST")
      return json(res, { proxyKey: "pk", registrationToken: "rt", pat: "pat" });
    if (record.path === "/api/models" && req.method === "GET") return json(res, { models: [{ id: "cnb-model" }] });
    if (record.path === "/api/logs/requests" && req.method === "GET")
      return json(res, { logs: [{ id: "log-1" }], total: 1, limit: 20, offset: 0 });
    if (record.path === "/api/settings" && req.method === "PATCH") return json(res, { settings: record.body });
    if (record.path === "/api/broken") return json(res, { error: { message: "接口不存在" } }, 404);
    return json(res, { error: { message: `no route ${record.method} ${record.path}` } }, 404);
  });
  const baseUrl = await listen(server);
  t.after(() => close(server));
  return { baseUrl, seen };
}

const adapterFor = (baseUrl, token = TOKEN) =>
  createCnbAdapter({
    system: "cnb",
    baseUrl,
    token,
    timeoutMs: 5000,
    client: createServiceClient({ system: "cnb", baseUrl, token, timeoutMs: 5000 }),
  });

test("cnb adapter authenticates every call with the platform bearer and sends no Origin", async (t) => {
  const { baseUrl, seen } = await fixture(t);
  const adapter = adapterFor(baseUrl);
  await adapter.health();
  await adapter.listAccounts();
  assert.equal(seen.length, 2);
  assert.equal(seen[0].headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(seen[1].headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(seen[0].headers.origin, undefined);
});

test("cnb registry resolves the real module instead of the stub", async (t) => {
  const { baseUrl } = await fixture(t);
  const registry = await createRegistry({
    systems: [{ system: "cnb", baseUrl, token: TOKEN, timeoutMs: 5000 }],
  });
  assert.equal(registry.isStub("cnb"), false);
  const health = await registry.get("cnb").health();
  assert.equal(health.status, "ok");
});

test("cnb health degrades to down instead of throwing", async () => {
  const baseUrl = "http://127.0.0.1:1";
  const adapter = createCnbAdapter({
    system: "cnb",
    baseUrl,
    token: TOKEN,
    client: createServiceClient({ system: "cnb", baseUrl, token: TOKEN, timeoutMs: 2000 }),
  });
  const health = await adapter.health();
  assert.equal(health.status, "down");
  assert.ok(health.detail);
});

test("cnb overview keeps CNB quota on its own section", async (t) => {
  const { baseUrl } = await fixture(t);
  const overview = await adapterFor(baseUrl).overview();
  assert.equal(overview.quota.unit, "credits");
  assert.equal(overview.quota.total, 1000);
  assert.equal(overview.quota.remaining, 700);
  assert.equal(overview.quota.used, 300);
  assert.equal(overview.accounts.total, 1);
  assert.equal(overview.accounts.ready, 1);
  assert.equal(overview.usage.find((metric) => metric.label === "成功率").value, 95);
  assert.equal(overview.settings.strategy, "weighted");
});

test("cnb overview derives quota when the service omits stats.remainingCredits", async (t) => {
  const { baseUrl } = await fixture(t, {
    overview: {
      accounts: [{ id: "a", name: "A", status: "pending", quota: { org: "o", credits: { total: 100, used: 10, freeze: 5 } } }],
      settings: {},
      stats: {},
    },
  });
  const overview = await adapterFor(baseUrl).overview();
  assert.equal(overview.quota.remaining, 85);
  assert.equal(overview.accounts.total, 1);
  assert.equal(overview.accounts.ready, 0);
});

test("cnb listAccounts returns the array shape the panel aggregates", async (t) => {
  const { baseUrl } = await fixture(t);
  const entries = await adapterFor(baseUrl).listAccounts();
  assert.ok(Array.isArray(entries));
  assert.deepEqual(
    { nativeId: entries[0].nativeId, status: entries[0].status, tags: entries[0].tags },
    { nativeId: "acc-1", status: "healthy", tags: ["cnb"] },
  );
  assert.equal(entries[0].quota.remaining, 700);
  assert.equal(entries[0].raw.id, "acc-1");
});

test("cnb accountAction maps documented actions and rejects unknown ones", async (t) => {
  const { baseUrl, seen } = await fixture(t);
  const adapter = adapterFor(baseUrl);
  await adapter.accountAction("acc-1", "probe", {});
  await adapter.accountAction("acc-1", "quota", {});
  await adapter.accountAction("acc-1", "update", { enabled: false });
  await adapter.accountAction("acc-1", "delete");
  assert.deepEqual(
    seen.map((record) => `${record.method} ${record.path}`),
    [
      "POST /api/accounts/acc-1/probe",
      "POST /api/accounts/acc-1/quota",
      "PATCH /api/accounts/acc-1",
      "DELETE /api/accounts/acc-1",
    ],
  );
  await assert.rejects(() => adapter.accountAction("acc-1", "launch"), (error) => {
    assert.equal(error.name, "InputError");
    assert.equal(error.status, 400);
    return true;
  });
});

test("cnb authorization collects credentials, creates the account, then polls registration", async (t) => {
  const { baseUrl, seen } = await fixture(t);
  const adapter = adapterFor(baseUrl);
  const started = await adapter.startAuth();
  assert.equal(started.status, "pending");
  assert.ok(started.inputs.some((input) => input.name === "proxyKey"));

  const created = await adapter.pollAuth(started.flowId, { values: { name: "新账号", proxyKey: "pk-1", pat: "pat-1" } });
  assert.equal(created.status, "pending");
  assert.match(JSON.stringify(created.steps), /reg-secret/);
  assert.equal(seen.find((record) => record.method === "POST" && record.path === "/api/accounts").body.proxyKey, "pk-1");

  const polled = await adapter.pollAuth(created.flowId, {});
  assert.equal(polled.status, "pending");

  const completed = await adapter.completeAuth(created.flowId, {});
  assert.equal(completed.status, "success");
  assert.equal(completed.accountId, "acc-new");
});

test("cnb startAuth with an account rotates its registration token", async (t) => {
  const { baseUrl, seen } = await fixture(t);
  const started = await adapterFor(baseUrl).startAuth({ accountId: "acc-1" });
  assert.equal(seen.at(-1).path, "/api/accounts/acc-1/registration");
  assert.match(JSON.stringify(started.steps), /rotated-token/);
});

test("cnb pollAuth reports an unknown flow as expired instead of polling forever", async (t) => {
  const { baseUrl } = await fixture(t);
  const result = await adapterFor(baseUrl).pollAuth("11111111-1111-1111-1111-111111111111", {});
  assert.equal(result.status, "expired");
});

test("cnb adapter surfaces upstream errors as AdapterError and keeps passthrough status", async (t) => {
  const { baseUrl } = await fixture(t);
  const adapter = adapterFor(baseUrl);
  await assert.rejects(() => adapterFor(`${baseUrl}/missing-prefix`).listAccounts(), (error) => {
    assert.ok(error instanceof AdapterError);
    assert.equal(error.status, 404);
    assert.match(error.message, /no route/);
    return true;
  });
  // A rejected token must fail loudly, never render as an empty account list.
  const wrong = adapterFor(baseUrl, "stale");
  await assert.rejects(() => wrong.listAccounts(), (error) => error.status === 401);
});

test("cnb call forwards query, body and status unchanged", async (t) => {
  const { baseUrl, seen } = await fixture(t);
  const adapter = adapterFor(baseUrl);
  await adapter.call("/api/logs/requests", { query: { limit: 20, offset: 40, q: "", outcome: "all" } });
  await adapter.call("/api/settings", { method: "PATCH", body: { strategy: "failover" } });
  const missing = await adapter.call("/api/broken");
  assert.deepEqual(seen[0].query, { limit: "20", offset: "40", q: "", outcome: "all" });
  assert.equal(seen[1].body.strategy, "failover");
  assert.equal(seen[1].headers["content-type"], "application/json");
  assert.equal(missing.status, 404);
  assert.equal(missing.body.error.message, "接口不存在");
});

test("cnb rejects invalid ids and a missing client", async (t) => {
  const { baseUrl } = await fixture(t);
  const adapter = adapterFor(baseUrl);
  await assert.rejects(() => adapter.accountAction("bad/id", "probe"), (error) => error.status === 400);
  assert.throws(() => createCnbAdapter({ system: "cnb", baseUrl, token: TOKEN }), /shared service client/);
});

test("cnb normalizeQuota and accountState mirror the source console", () => {
  assert.equal(normalizeQuota({}), null);
  assert.deepEqual(normalizeQuota({ quota: { credits: { total: 100, used: 20, freeze: 0 } } }), {
    unit: "credits",
    total: 100,
    used: 20,
    remaining: 80,
    percent: 20,
  });
  assert.equal(accountState({ enabled: false }), "disabled");
  assert.equal(accountState({ enabled: true, quotaProtection: { suspended: true } }), "quota");
  assert.equal(accountState({ enabled: true, cooldownUntil: new Date(Date.now() + 60_000).toISOString() }), "cooling");
  assert.equal(accountState({ enabled: true, status: "healthy", endpoint: "x" }), "healthy");
  assert.equal(accountState({ enabled: true, status: "unhealthy" }), "offline");
  assert.equal(accountState({ enabled: true }), "pending");
});

// ── Panel integration: the adapter is reached through P1's real endpoints ──
// (accounts aggregation, per-system overview card, /api/p passthrough, auth
// routing). These are the rows AC1/AC8 cite for CNB, so they run the panel.

const ADMIN = "cnb-panel-integration-key";

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

async function panelWithCnb(t, baseUrl) {
  const { createPanelServer } = await import("../src/app.mjs");
  const { mkdtempSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dataDir = mkdtempSync(join(tmpdir(), "platform-cnb-"));
  const instance = createPanelServer({
    adminKey: ADMIN,
    dataDir,
    allowLocal: true,
    systems: [{ system: "cnb", baseUrl, token: TOKEN, timeoutMs: 5000 }],
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
  const login = await api.login();
  assert.equal(login.status, 200);
  return { api, registry: await instance.registry };
}

test("panel resolves the CNB adapter module instead of the stub", async (t) => {
  const { baseUrl } = await fixture(t);
  const { registry } = await panelWithCnb(t, baseUrl);
  assert.equal(registry.isStub("cnb"), false);
});

test("panel exposes CNB accounts in the unified list with the system tag", async (t) => {
  const { baseUrl } = await fixture(t);
  const { api } = await panelWithCnb(t, baseUrl);
  const result = await api.request("/api/accounts");
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.accounts.map((account) => account.id), ["cnb:acc-1"]);
  assert.deepEqual(result.body.accounts[0].tags, ["cnb"]);
  assert.equal(result.body.accounts[0].quota.remaining, 700);
  // System filter stays per-system (R11).
  const filtered = await api.request("/api/accounts?system=cnb");
  assert.equal(filtered.status, 200);
  assert.equal(filtered.body.accounts.length, 1);
  const unsupported = await api.request("/api/accounts?system=nope");
  assert.equal(unsupported.status, 400);
});

test("panel overview keeps the CNB card separate and reports the service health", async (t) => {
  const { baseUrl } = await fixture(t);
  const { api } = await panelWithCnb(t, baseUrl);
  const result = await api.request("/api/overview");
  assert.equal(result.status, 200);
  assert.equal(result.body.cnb.ok, true);
  // P1 flattens the adapter payload into the section, so the card reads the
  // quota straight off `body.cnb` and health is an already-normalized string.
  assert.equal(result.body.cnb.quota.unit, "credits");
  assert.equal(result.body.cnb.quota.remaining, 700);
  assert.equal(result.body.cnb.health, "ok");
  assert.equal(result.body.cnb.overview, undefined);
  assert.equal(result.body.codebuddy, undefined);
});

test("panel proxies CNB management routes byte-for-byte through /api/p/cnb", async (t) => {
  const { baseUrl, seen } = await fixture(t);
  const { api } = await panelWithCnb(t, baseUrl);
  const models = await api.request("/api/p/cnb/api/models");
  assert.equal(models.status, 200);
  assert.equal(models.body.models[0].id, "cnb-model");

  const logs = await api.request("/api/p/cnb/api/logs/requests?limit=20&offset=0&outcome=all");
  assert.equal(logs.status, 200);
  assert.equal(logs.body.logs[0].id, "log-1");
  assert.deepEqual(seen.at(-1).query, { limit: "20", offset: "0", outcome: "all" });

  const missing = await api.request("/api/p/cnb/api/broken");
  assert.equal(missing.status, 404);
  assert.match(missing.body.error.message, /接口不存在/);
});

test("panel routes the CNB authorization flow through the adapter", async (t) => {
  const { baseUrl, seen } = await fixture(t);
  const { api } = await panelWithCnb(t, baseUrl);
  const started = await api.request("/api/accounts/auth/cnb/start", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(started.status, 200);
  assert.match(started.body.flowId, /^[A-Za-z0-9._:~-]{1,300}$/);
  assert.ok(started.body.result.inputs.some((input) => input.name === "proxyKey"));
  assert.equal(seen.length, 0);

  const created = await api.request("/api/accounts/auth/cnb/poll", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ flowId: started.body.flowId, values: { name: "面板账号", proxyKey: "pk-2" } }),
  });
  assert.equal(created.status, 200);
  assert.equal(seen.at(-1).path, "/api/accounts");
});

// Every documented CNB management route the console exposes must map onto a
// real service path; this table is what the coverage matrix cites.
test("cnb adapter maps every documented management route", async (t) => {
  const { baseUrl, seen } = await fixture(t);
  const adapter = adapterFor(baseUrl);
  const call = (path, options) => adapter.call(path, options).then((result) => result.status);

  await call("/api/overview");
  await call("/api/accounts");
  await call("/api/models");
  await call("/api/credits/rates", { query: { window: "7d" } });
  await call("/api/usage/history", { query: { days: 90 } });
  await call("/api/usage/comparison");
  await call("/api/usage/comparison", { method: "POST", body: {} });
  await call("/api/settings");
  await call("/api/settings", { method: "PATCH", body: { strategy: "failover" } });
  await call("/api/registration-relay");
  await call("/api/registration-relay/sync", { method: "POST", body: {} });
  await call("/api/logs/requests", { query: { limit: 20, offset: 0 } });
  await call("/api/logs/requests/:id".replace(":id", "00000000-0000-4000-8000-000000000000"));
  await call("/api/logs/audit", { query: { limit: 20 } });
  await call("/api/logs/system", { query: { limit: 20 } });
  await call("/api/logs/requests", { query: { download: "1" } });
  await call("/api/access");
  await call("/api/access/key", { method: "POST", body: {} });
  await call("/api/auth/settings");
  await call("/api/auth/settings", { method: "PATCH", body: { keyLoginEnabled: false } });

  assert.deepEqual(
    seen.map((record) => `${record.method} ${record.path}`),
    [
      "GET /api/overview",
      "GET /api/accounts",
      "GET /api/models",
      "GET /api/credits/rates",
      "GET /api/usage/history",
      "GET /api/usage/comparison",
      "POST /api/usage/comparison",
      "GET /api/settings",
      "PATCH /api/settings",
      "GET /api/registration-relay",
      "POST /api/registration-relay/sync",
      "GET /api/logs/requests",
      "GET /api/logs/requests/00000000-0000-4000-8000-000000000000",
      "GET /api/logs/audit",
      "GET /api/logs/system",
      "GET /api/logs/requests",
      "GET /api/access",
      "POST /api/access/key",
      "GET /api/auth/settings",
      "PATCH /api/auth/settings",
    ],
  );
  assert.deepEqual(seen[3].query, { window: "7d" });
  assert.deepEqual(seen[4].query, { days: "90" });
  assert.deepEqual(seen[15].query, { download: "1" });
});

test("cnb adapter maps every documented account action", async (t) => {
  const { baseUrl, seen } = await fixture(t);
  const adapter = adapterFor(baseUrl);
  for (const action of ["probe", "inference-probe", "quota", "wake", "registration", "pat", "credentials"]) {
    await adapter.accountAction("acc-1", action, {});
  }
  assert.deepEqual(
    seen.map((record) => record.path),
    [
      "/api/accounts/acc-1/probe",
      "/api/accounts/acc-1/inference-probe",
      "/api/accounts/acc-1/quota",
      "/api/accounts/acc-1/wake",
      "/api/accounts/acc-1/registration",
      "/api/accounts/acc-1/pat",
      "/api/accounts/acc-1/credentials",
    ],
  );
});

test("panel exposes CNB channel actions and per-channel overview blocks", async (t) => {
  const { baseUrl, seen } = await fixture(t);
  const { api } = await panelWithCnb(t, baseUrl);
  const channels = await api.request("/api/channels");
  assert.deepEqual(channels.body[0].capabilities.accounts.channelActions, [{ id: "wake-all", label: "唤醒全部工作区" }]);

  const detail = await api.request("/api/overview/cnb");
  assert.equal(detail.status, 200);
  assert.equal(detail.body.system, "cnb");
  const quotaList = detail.body.sections.find((section) => section.kind === "quotaList");
  assert.equal(quotaList.items[0].remaining, 700);
  assert.equal(quotaList.items[0].total, 1000);
  assert.equal(quotaList.items[0].unit, "credits");
  assert.ok(detail.body.sections.some((section) => section.id === "accounts"));
  // Only the service's own local routes; a 404 for a missing optional route is
  // tolerated instead of failing the section.
  assert.ok(seen.every((record) => record.method === "GET"));
  assert.ok(!seen.some((record) => /probe|quota$/.test(record.path)));

  const wake = await api.request("/api/channels/cnb/actions/wake-all", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(wake.status, 200);
  assert.deepEqual(wake.body, { total: 1, started: 1, failed: [] });
  assert.ok(seen.some((record) => record.method === "POST" && record.path === "/api/accounts/acc-1/wake"));

  const undeclared = await api.request("/api/channels/cnb/actions/probe-all", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({}),
  });
  assert.equal(undeclared.status, 404);
});

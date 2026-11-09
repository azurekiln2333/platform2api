import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";

const TOKEN = "codebuddy-platform-token-0123456789";

/**
 * Stand-in for codebuddy2api's /admin contract. It pins the states the
 * inventory calls out: bearer-only auth, revisioned settings (409), an
 * unavailable audit store (503) and cursor-paginated logs.
 */
async function service(t, handlers = {}) {
  const state = {
    calls: [],
    revision: 7,
    auditUnavailable: false,
    token: TOKEN,
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://service.local");
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = raw ? JSON.parse(raw) : null;
    state.calls.push({
      method: req.method,
      path: url.pathname,
      query: url.search,
      headers: req.headers,
      body,
    });

    const send = (status, payload) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(JSON.stringify(payload));
    };

    if (req.headers.authorization !== `Bearer ${state.token}`) {
      return send(401, { detail: "管理认证无效或会话已过期" });
    }
    const custom = handlers[`${req.method} ${url.pathname}`];
    if (custom) return custom({ req, res, url, body, state, send });

    if (req.method === "GET" && url.pathname === "/admin/session") {
      return send(200, { authenticated: true, csrf_token: null });
    }
    if (req.method === "GET" && url.pathname === "/admin/dashboard") {
      if (state.auditUnavailable)
        return send(503, { detail: "审计数据不可用" });
      return send(200, {
        totals: { requests: 12, credits: null },
        health: { status: "ok" },
        storage: { path: "/data/auth" },
      });
    }
    if (req.method === "GET" && url.pathname === "/admin/credentials") {
      return send(200, {
        credentials: [
          {
            name: "acc-1.json",
            nickname: "主账号",
            enabled: true,
            tags: ["vip"],
          },
          { name: "acc-2.json", enabled: false },
          { name: "acc/3", cooldown_until: "2026-11-10T00:00:00Z" },
        ],
      });
    }
    if (
      req.method === "PATCH" &&
      url.pathname.startsWith("/admin/credentials/")
    ) {
      return send(200, { ok: true });
    }
    if (
      req.method === "DELETE" &&
      url.pathname.startsWith("/admin/credentials/")
    ) {
      return send(200, { ok: true });
    }
    if (req.method === "POST" && url.pathname === "/admin/oauth/start") {
      return send(200, {
        login_id: "flow-1",
        verification_uri: "https://example.com/oauth",
      });
    }
    if (req.method === "GET" && url.pathname === "/admin/oauth/poll") {
      return send(200, { done: false });
    }
    if (req.method === "GET" && url.pathname === "/admin/keys") {
      return send(200, { external: true, items: [{ id: "k1" }] });
    }
    if (req.method === "GET" && url.pathname === "/admin/models") {
      return send(200, { revision: state.revision, models: [{ id: "gpt-x" }] });
    }
    if (req.method === "GET" && url.pathname === "/admin/settings") {
      return send(200, {
        revision: state.revision,
        items: [{ key: "audit_max_bytes", value: 1024 }],
      });
    }
    if (req.method === "PATCH" && url.pathname === "/admin/settings") {
      if (body.revision !== state.revision)
        return send(409, { detail: "配置已更新，请刷新后重试" });
      state.revision += 1;
      return send(200, {
        revision: state.revision,
        applied: Object.keys(body.values || {}),
      });
    }
    if (req.method === "GET" && url.pathname === "/admin/logs") {
      return send(200, { items: [{ id: "log-1" }], next_cursor: "c2" });
    }
    if (req.method === "GET" && url.pathname.startsWith("/admin/logs/")) {
      if (url.pathname === "/admin/logs/gone")
        return send(404, { detail: "请求明细不存在或已清理" });
      return send(200, { id: url.pathname.split("/").pop(), detail: "full" });
    }
    // ── credential batch import ──
    if (req.method === "POST" && url.pathname === "/admin/credentials/upload") {
      return send(200, {
        results: body.files.map((file) => ({ name: file.name, ok: true })),
      });
    }
    if (
      req.method === "POST" &&
      url.pathname === "/admin/credentials/refresh-import"
    ) {
      return send(200, {
        results: body.refresh_tokens.map((token) => ({ ok: true, token })),
      });
    }
    // ── model catalog ──
    if (req.method === "POST" && url.pathname === "/admin/models") {
      if (body.revision !== state.revision)
        return send(409, { detail: "配置已更新，请刷新后重试" });
      state.revision += 1;
      return send(201, {
        revision: state.revision,
        model: { id: "custom:1", ...body },
      });
    }
    if (req.method === "PUT" && url.pathname.startsWith("/admin/models/")) {
      if (body.revision !== state.revision)
        return send(409, { detail: "配置已更新，请刷新后重试" });
      state.revision += 1;
      return send(200, {
        revision: state.revision,
        model: { id: url.pathname.split("/").pop(), ...body },
      });
    }
    if (req.method === "DELETE" && url.pathname.startsWith("/admin/models/")) {
      state.revision += 1;
      return send(200, { revision: state.revision });
    }
    if (req.method === "POST" && url.pathname === "/admin/models/scan")
      return send(200, { running: true });
    if (req.method === "GET" && url.pathname === "/admin/models/scan")
      return send(200, { running: false, total: 3 });
    if (req.method === "POST" && url.pathname === "/admin/models/rate-probe")
      return send(200, { total: 2 });
    if (req.method === "GET" && url.pathname === "/admin/models/rate-probe")
      return send(200, { running: false });
    if (req.method === "GET" && url.pathname === "/admin/models/output-probes")
      return send(200, { items: [] });
    if (req.method === "POST" && url.pathname.endsWith("/preview"))
      return send(200, { preview: true });
    // ── keys CRUD ──
    if (req.method === "POST" && url.pathname === "/admin/keys") {
      return send(201, { key: "cbk_secret_once", item: { id: "k2", ...body } });
    }
    if (req.method === "PATCH" && url.pathname.startsWith("/admin/keys/")) {
      if (body.version !== 3)
        return send(409, { detail: "密钥已更新，请刷新后重试" });
      return send(200, {
        item: { id: url.pathname.split("/").pop(), ...body },
      });
    }
    if (req.method === "DELETE" && url.pathname.startsWith("/admin/keys/"))
      return send(200, {});
    if (req.method === "POST" && url.pathname.endsWith("/reveal"))
      return send(200, { key: "cbk_revealed" });
    if (req.method === "POST" && url.pathname.endsWith("/rotate"))
      return send(200, { key: "cbk_rotated" });
    // ── operations ──
    if (req.method === "GET" && url.pathname === "/admin/media")
      return send(200, { configured: true });
    if (req.method === "GET" && url.pathname === "/admin/storage")
      return send(200, { degraded: false, archives: [] });
    if (req.method === "POST" && url.pathname === "/admin/storage/archive")
      return send(200, { ok: true });
    if (req.method === "POST" && url.pathname === "/admin/storage/backups")
      return send(200, { name: "b1.zip" });
    if (
      req.method === "DELETE" &&
      url.pathname.startsWith("/admin/storage/backups/")
    )
      return send(200, {});
    if (req.method === "GET" && url.pathname === "/admin/update")
      return send(200, { current: "1.0.0" });
    if (req.method === "POST" && url.pathname === "/admin/update/check")
      return send(200, { latest: "1.1.0" });
    if (req.method === "GET" && url.pathname === "/admin/performance")
      return send(200, { cpu: 1 });
    if (req.method === "GET" && url.pathname === "/admin/growth-jobs")
      return send(200, { jobs: [{ id: "j1" }] });
    return send(404, { detail: "not found" });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { state, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

/** Build the adapter exactly the way the registry does. */
async function adapterFor(context, overrides = {}) {
  const { createRegistry } = await import("../src/adapters/index.mjs");
  const registry = await createRegistry({
    systems: [
      {
        system: "codebuddy",
        baseUrl: context.baseUrl,
        token: context.token,
        timeoutMs: 5000,
      },
    ],
    ...overrides,
  });
  return registry.get("codebuddy");
}

test("the registry loads this module instead of the stub", async (t) => {
  const { baseUrl } = await service(t);
  const { createRegistry } = await import("../src/adapters/index.mjs");
  const registry = await createRegistry({
    systems: [{ system: "codebuddy", baseUrl, token: TOKEN }],
    logger: {
      warn() {},
      error(message) {
        throw new Error(message);
      },
    },
  });
  assert.equal(registry.isStub("codebuddy"), false);
  assert.equal(registry.get("codebuddy").system, "codebuddy");
});

test("health distinguishes a reachable service from a rejected token", async (t) => {
  const { baseUrl } = await service(t);
  assert.deepEqual(
    await (await adapterFor({ baseUrl, token: TOKEN })).health(),
    { status: "ok" },
  );

  const rejected = await adapterFor({
    baseUrl,
    token: "wrong-token-value-000",
  });
  const health = await rejected.health();
  assert.equal(health.status, "down");
  assert.match(health.detail, /PLATFORM_TOKEN/);
});

test("an unreachable service reports down without throwing", async () => {
  const adapter = await adapterFor({
    baseUrl: "http://127.0.0.1:1",
    token: TOKEN,
  });
  const health = await adapter.health();
  assert.equal(health.status, "down");
  assert.ok(health.detail);
});

test("credentials normalize to the panel account contract", async (t) => {
  const { baseUrl } = await service(t);
  const accounts = await (
    await adapterFor({ baseUrl, token: TOKEN })
  ).listAccounts();

  assert.deepEqual(
    accounts.map((account) => account.nativeId),
    ["acc-1.json", "acc-2.json", "acc_3"],
  );
  const [first, second, third] = accounts;
  assert.equal(first.label, "主账号");
  assert.equal(first.status, "ready");
  assert.equal(first.enabled, true);
  assert.deepEqual(
    first.tags,
    ["vip"],
    "the system tag is added by accounts.mjs, not here",
  );

  assert.equal(second.status, "disabled");
  assert.equal(second.enabled, false);
  assert.equal(third.status, "cooldown");
});

test("native ids stay inside the panel id grammar", async (t) => {
  const { baseUrl } = await service(t);
  const accounts = await (
    await adapterFor({ baseUrl, token: TOKEN })
  ).listAccounts();
  for (const account of accounts) {
    assert.match(account.nativeId, /^[A-Za-z0-9._:-]{1,200}$/);
  }
});

test("overview keeps this system's own numbers and units", async (t) => {
  const { baseUrl } = await service(t);
  const overview = await (
    await adapterFor({ baseUrl, token: TOKEN })
  ).overview({ days: 30 });

  assert.equal(overview.system, "codebuddy");
  assert.equal(overview.days, 30);
  assert.equal(overview.requests, 12);
  assert.equal(overview.credits, null);
  assert.deepEqual(overview.storage, { path: "/data/auth" });
});

test("an unavailable audit store throws instead of reporting zero usage", async (t) => {
  const { baseUrl, state } = await service(t);
  state.auditUnavailable = true;

  const adapter = await adapterFor({ baseUrl, token: TOKEN });
  await assert.rejects(
    () => adapter.overview(),
    (error) =>
      error.code === "upstream_unavailable" && /503/.test(error.message),
  );
});

test("credential updates accept exactly one supported field", async (t) => {
  const { baseUrl, state } = await service(t);
  const adapter = await adapterFor({ baseUrl, token: TOKEN });

  await adapter.accountAction("acc-2.json", "update", { enabled: true });
  const patch = state.calls.find((call) => call.method === "PATCH");
  assert.deepEqual(patch.body, { enabled: true });

  await assert.rejects(
    () =>
      adapter.accountAction("acc-2.json", "update", {
        enabled: true,
        auto_travel: true,
      }),
    (error) => error.status === 400 && error.name === "InputError",
  );
  await assert.rejects(
    () => adapter.accountAction("acc-2.json", "update", { nickname: "x" }),
    (error) => error.status === 400,
  );
  await assert.rejects(
    () => adapter.accountAction("acc-2.json", "probe", {}),
    (error) => error.status === 400,
  );
});

test("credential delete targets the native name", async (t) => {
  const { baseUrl, state } = await service(t);
  await (
    await adapterFor({ baseUrl, token: TOKEN })
  ).accountAction("acc-1.json", "delete");
  assert.ok(
    state.calls.some(
      (call) =>
        call.method === "DELETE" &&
        call.path === "/admin/credentials/acc-1.json",
    ),
  );
});

test("enrollment start/poll map onto flowId and status", async (t) => {
  const { baseUrl, state } = await service(t);
  const adapter = await adapterFor({ baseUrl, token: TOKEN });

  const started = await adapter.startAuth({ site: "intl" });
  assert.equal(started.flowId, "flow-1");
  assert.equal(started.verificationUri, "https://example.com/oauth");
  const startCall = state.calls.find(
    (call) => call.path === "/admin/oauth/start",
  );
  assert.match(startCall.query, /site=intl/);

  assert.equal((await adapter.pollAuth("flow-1")).status, "pending");
  await assert.rejects(
    () => adapter.pollAuth(""),
    (error) => error.status === 400,
  );
});

test("a completed enrollment reports done with the imported credential", async (t) => {
  const done = ({ send }) =>
    send(200, {
      done: true,
      uid: "u1",
      nickname: "小明",
      imported: "acc-9.json",
    });
  const failed = ({ send }) =>
    send(200, { done: true, error: "OAuth 登录失败，请重新发起" });
  const { baseUrl: okBase } = await service(t, {
    "GET /admin/oauth/poll": done,
  });
  const { baseUrl: badBase } = await service(t, {
    "GET /admin/oauth/poll": failed,
  });

  const ok = await (
    await adapterFor({ baseUrl: okBase, token: TOKEN })
  ).pollAuth("flow");
  assert.equal(ok.status, "done");
  assert.equal(ok.nickname, "小明");
  assert.equal(ok.imported, "acc-9.json");

  const bad = await (
    await adapterFor({ baseUrl: badBase, token: TOKEN })
  ).pollAuth("flow");
  assert.equal(bad.status, "error");
});

test("keys and models keep their service envelopes", async (t) => {
  const { baseUrl } = await service(t);
  const adapter = await adapterFor({ baseUrl, token: TOKEN });

  assert.deepEqual(await adapter.listKeys(), {
    external: true,
    items: [{ id: "k1" }],
  });
  const models = await adapter.listModels();
  assert.equal(models.revision, 7);
  assert.deepEqual(models.models, [{ id: "gpt-x" }]);
});

test("settings writes stay revision aware and surface 409 untouched", async (t) => {
  const { baseUrl } = await service(t);
  const adapter = await adapterFor({ baseUrl, token: TOKEN });

  const current = await adapter.getSettings();
  assert.equal(current.revision, 7);

  const written = await adapter.patchSettings(
    { audit_max_bytes: 2048 },
    current.revision,
  );
  assert.equal(written.revision, 8);

  await assert.rejects(
    () => adapter.patchSettings({ audit_max_bytes: 4096 }, 7),
    (error) => error.status === 409 && error.code === "revision_conflict",
  );
});

test("log pagination clamps the limit to the service window", async (t) => {
  const { baseUrl, state } = await service(t);
  const adapter = await adapterFor({ baseUrl, token: TOKEN });

  const page = await adapter.listLogs({
    kind: "credit",
    limit: 9999,
    cursor: "c1",
  });
  assert.deepEqual(page.items, [{ id: "log-1" }]);
  assert.equal(page.nextCursor, "c2");
  const query = state.calls.find((call) => call.path === "/admin/logs").query;
  assert.match(query, /limit=200/);
  assert.match(query, /kind=credit/);
  assert.match(query, /cursor=c1/);

  await adapter.listLogs({ kind: "nope", limit: 0 });
  const clamped = state.calls
    .filter((call) => call.path === "/admin/logs")
    .pop().query;
  assert.match(clamped, /kind=request/);
  assert.match(clamped, /limit=50/);
});

test("passthrough preserves the service status so 409 stays a conflict", async (t) => {
  const { baseUrl } = await service(t);
  const adapter = await adapterFor({ baseUrl, token: TOKEN });

  const conflict = await adapter.call("/admin/settings", {
    method: "PATCH",
    body: { values: {}, revision: 1 },
  });
  assert.equal(conflict.status, 409);

  const missing = await adapter.call("/admin/unknown");
  assert.equal(missing.status, 404);
  assert.equal(missing.body.detail, "not found");
});

test("passthrough refuses absolute and traversal paths", async (t) => {
  const { baseUrl } = await service(t);
  const adapter = await adapterFor({ baseUrl, token: TOKEN });
  await assert.rejects(
    () => adapter.call("http://evil.example/x"),
    (error) => error.status === 400,
  );
  await assert.rejects(
    () => adapter.call("/admin/../../etc/passwd"),
    (error) => error.status === 400,
  );
});

test("the bearer credential is sent and never echoed to the panel", async (t) => {
  const { baseUrl, state } = await service(t);
  const adapter = await adapterFor({ baseUrl, token: TOKEN });
  const session = await adapter.call("/admin/session");

  assert.equal(state.calls[0].headers.authorization, `Bearer ${TOKEN}`);
  assert.ok(!JSON.stringify(session).includes(TOKEN));
});

// ── cb-logs-2: request detail ──────────────────────────────────────────────

test("log detail is fetched by id and a cleaned-up entry stays a 404", async (t) => {
  const { baseUrl, state } = await service(t);
  const adapter = await adapterFor({ baseUrl, token: TOKEN });

  const detail = await adapter.getLog("log-1");
  assert.equal(detail.detail, "full");
  assert.ok(state.calls.some((call) => call.path === "/admin/logs/log-1"));

  await assert.rejects(
    () => adapter.getLog("gone"),
    (error) => error.code === "upstream_error" && /404/.test(error.message),
  );
  await assert.rejects(
    () => adapter.getLog(""),
    (error) => error.status === 400,
  );
});

// ── cb-accounts-3: batch credential import ────────────────────────────────

test("credential upload posts the JSON file batch the service expects", async (t) => {
  const { baseUrl, state } = await service(t);
  const adapter = await adapterFor({ baseUrl, token: TOKEN });

  const result = await adapter.uploadCredentials({
    files: [{ name: "acc-3.json", content: '{"a":1}' }],
    replace: false,
  });
  assert.deepEqual(result.results, [{ name: "acc-3.json", ok: true }]);

  const call = state.calls.find(
    (entry) => entry.path === "/admin/credentials/upload",
  );
  assert.match(call.headers["content-type"], /application\/json/);
  assert.deepEqual(call.body, {
    files: [{ name: "acc-3.json", content: '{"a":1}' }],
    replace: false,
  });
});

test("credential upload rejects malformed batches before calling the service", async (t) => {
  const { baseUrl, state } = await service(t);
  const adapter = await adapterFor({ baseUrl, token: TOKEN });
  const before = state.calls.length;

  await assert.rejects(
    () => adapter.uploadCredentials({ files: [] }),
    (error) => error.status === 400,
  );
  await assert.rejects(
    () => adapter.uploadCredentials({ files: [{ name: "a" }] }),
    (error) => error.status === 400,
  );
  await assert.rejects(
    () =>
      adapter.uploadCredentials({
        files: [{ name: "a", content: "x" }],
        replace: "yes",
      }),
    (error) => error.status === 400,
  );
  assert.equal(state.calls.length, before, "no request may reach the service");
});

test("refresh-import validates the endpoint profile and token batch", async (t) => {
  const { baseUrl, state } = await service(t);
  const adapter = await adapterFor({ baseUrl, token: TOKEN });

  const result = await adapter.refreshImport({
    profile: "cn-cli",
    refreshTokens: [" t1 ", "", "t2"],
  });
  assert.equal(result.results.length, 2, "blank tokens are dropped");
  const call = state.calls.find(
    (entry) => entry.path === "/admin/credentials/refresh-import",
  );
  assert.deepEqual(call.body, {
    profile: "cn-cli",
    refresh_tokens: ["t1", "t2"],
  });

  await assert.rejects(
    () => adapter.refreshImport({ profile: "bogus", refreshTokens: ["t"] }),
    (error) => error.status === 400 && /cn-cli/.test(error.message),
  );
  await assert.rejects(
    () => adapter.refreshImport({ profile: "cn-cli", refreshTokens: ["  "] }),
    (error) => error.status === 400,
  );
});

// ── cb-models-2 / cb-models-3 ─────────────────────────────────────────────

test("model create and update carry the revision and keep 409 a conflict", async (t) => {
  const { baseUrl, state } = await service(t);
  const adapter = await adapterFor({ baseUrl, token: TOKEN });

  const created = await adapter.createModel({ public_id: "gpt-y" }, 7);
  assert.equal(created.revision, 8);
  const createCall = state.calls.find(
    (call) => call.method === "POST" && call.path === "/admin/models",
  );
  assert.deepEqual(createCall.body, { public_id: "gpt-y", revision: 7 });

  const updated = await adapter.updateModel("gpt-y", { public_id: "gpt-y" }, 8);
  assert.equal(updated.revision, 9);

  await assert.rejects(
    () => adapter.updateModel("gpt-y", {}, 8),
    (error) => error.status === 409 && error.code === "revision_conflict",
  );
});

test("model delete and preview target the model path", async (t) => {
  const { baseUrl, state } = await service(t);
  const adapter = await adapterFor({ baseUrl, token: TOKEN });

  await adapter.deleteModel("gpt-y", 9);
  assert.ok(
    state.calls.some(
      (call) => call.method === "DELETE" && call.path === "/admin/models/gpt-y",
    ),
  );

  await adapter.previewModel("gpt-y", { public_id: "gpt-y" });
  assert.ok(
    state.calls.some(
      (call) =>
        call.method === "POST" && call.path === "/admin/models/gpt-y/preview",
    ),
  );
  await assert.rejects(
    () => adapter.deleteModel(""),
    (error) => error.status === 400,
  );
});

test("catalog scan and rate probe expose start plus state", async (t) => {
  const { baseUrl, state } = await service(t);
  const adapter = await adapterFor({ baseUrl, token: TOKEN });

  assert.deepEqual(await adapter.startScan(), { running: true });
  assert.equal((await adapter.scanState()).total, 3);
  assert.deepEqual(await adapter.startRateProbe(), { total: 2 });
  assert.deepEqual(await adapter.rateProbeState(), { running: false });
  assert.deepEqual(await adapter.outputProbes(), { items: [] });

  const scanned = state.calls.filter(
    (call) => call.path === "/admin/models/scan",
  );
  assert.deepEqual(scanned.map((call) => call.method).sort(), ["GET", "POST"]);
});

// ── cb-keys-2 / cb-keys-3 ────────────────────────────────────────────────

test("key create returns the one-time secret and the created item", async (t) => {
  const { baseUrl, state } = await service(t);
  const adapter = await adapterFor({ baseUrl, token: TOKEN });

  const created = await adapter.createKey({ name: "panel", type: "user" });
  assert.equal(created.key, "cbk_secret_once");
  assert.equal(created.item.id, "k2");
  const call = state.calls.find(
    (entry) => entry.method === "POST" && entry.path === "/admin/keys",
  );
  assert.deepEqual(call.body, { name: "panel", type: "user" });
});

test("key update and delete use the service optimistic lock", async (t) => {
  const { baseUrl, state } = await service(t);
  const adapter = await adapterFor({ baseUrl, token: TOKEN });

  await adapter.updateKey("k1", { version: 3, rpm: 60 });
  await assert.rejects(
    () => adapter.updateKey("k1", { version: 2, rpm: 60 }),
    (error) => error.status === 409,
  );
  await adapter.deleteKey("k1");
  assert.ok(
    state.calls.some(
      (call) => call.method === "DELETE" && call.path === "/admin/keys/k1",
    ),
  );
  await assert.rejects(
    () => adapter.updateKey("", {}),
    (error) => error.status === 400,
  );
  await assert.rejects(
    () => adapter.deleteKey(""),
    (error) => error.status === 400,
  );
});

test("key reveal and rotate stay explicit calls", async (t) => {
  const { baseUrl, state } = await service(t);
  const adapter = await adapterFor({ baseUrl, token: TOKEN });

  assert.equal((await adapter.revealKey("k1")).key, "cbk_revealed");
  assert.equal((await adapter.rotateKey("k1")).key, "cbk_rotated");
  assert.ok(state.calls.some((call) => call.path === "/admin/keys/k1/reveal"));
  assert.ok(state.calls.some((call) => call.path === "/admin/keys/k1/rotate"));
  await assert.rejects(
    () => adapter.revealKey(""),
    (error) => error.status === 400,
  );
  await assert.rejects(
    () => adapter.rotateKey(""),
    (error) => error.status === 400,
  );
});

// ── cb-ops-1..4 ──────────────────────────────────────────────────────────

test("media, storage, update and automation use the real admin routes", async (t) => {
  const { baseUrl, state } = await service(t);
  const adapter = await adapterFor({ baseUrl, token: TOKEN });

  assert.deepEqual(await adapter.getMedia(), { configured: true });
  assert.deepEqual((await adapter.getStorage()).degraded, false);
  assert.deepEqual(await adapter.archiveStorage(), { ok: true });
  assert.deepEqual(await adapter.createBackup(), { name: "b1.zip" });
  assert.deepEqual(await adapter.deleteBackup("b1.zip"), { ok: true });
  assert.deepEqual(await adapter.getUpdate(), { current: "1.0.0" });
  assert.deepEqual(await adapter.checkUpdate(), { latest: "1.1.0" });
  assert.deepEqual(await adapter.getPerformance(), { cpu: 1 });
  assert.deepEqual(await adapter.getGrowthJobs(), { jobs: [{ id: "j1" }] });

  const paths = state.calls.map((call) => call.path);
  for (const path of [
    "/admin/media",
    "/admin/storage",
    "/admin/storage/archive",
    "/admin/storage/backups",
    "/admin/storage/backups/b1.zip",
    "/admin/update",
    "/admin/update/check",
    "/admin/performance",
    "/admin/growth-jobs",
  ]) {
    assert.ok(
      paths.includes(path),
      `${path} must be reachable through the adapter`,
    );
  }
  await assert.rejects(
    () => adapter.deleteBackup(""),
    (error) => error.status === 400,
  );
});

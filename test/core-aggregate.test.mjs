import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createPanelServer } from "../src/app.mjs";
import { AdapterError } from "../src/adapters/client.mjs";
import { createStubAdapter } from "../src/adapters/_stub.mjs";
import { createRegistry } from "../src/adapters/index.mjs";
import { assertSafePath } from "../src/proxy.mjs";
import { normalizeHealth, systemOverview } from "../src/overview.mjs";

const ADMIN = "platform-test-admin-key";
const tempDir = (t) => {
  const dir = mkdtempSync(join(tmpdir(), "platform2api-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

// Adapter fixture used instead of the real system modules (owned by P3/P4).
function fakeAdapter(system, overrides = {}) {
  return {
    system,
    async health() {
      return { status: "ok", detail: `${system} healthy` };
    },
    async overview() {
      // Mirrors the real adapters: one flat per-system payload, web-shaped.
      return {
        health: "ok",
        healthMessage: "",
        generatedAt: new Date().toISOString(),
        accounts: { total: 1, ready: 1 },
        quota: { label: `${system} 额度`, unit: system === "cnb" ? "credits" : "requests", remaining: 42 },
        usage: [{ label: "今日请求", value: 3, unit: "次" }],
      };
    },
    async listAccounts() {
      return [{ nativeId: "acct-1", label: `${system} account`, status: "ready", quota: { remaining: 5 } }];
    },
    async accountAction(nativeId, action) {
      return { ok: true, nativeId, action };
    },
    async startAuth() {
      return { flowId: "flow-1", url: "https://example.test/authorize" };
    },
    async pollAuth(flowId) {
      return { status: "pending", flowId };
    },
    async completeAuth(flowId) {
      return { status: "done", flowId };
    },
    async call(path, options) {
      return { status: 200, body: { path, method: options.method, query: options.query } };
    },
    ...overrides,
  };
}

const panel = async (t, options = {}) => {
  const adapters = options.adapters || {
    cnb: fakeAdapter("cnb"),
    codebuddy: fakeAdapter("codebuddy"),
    zcode: fakeAdapter("zcode"),
  };
  const instance = createPanelServer({
    adminKey: ADMIN,
    dataDir: tempDir(t),
    allowLocal: true,
    systems: Object.keys(adapters).map((system) => ({
      system,
      baseUrl: `http://${system}:9000`,
      token: `${system}-token`,
    })),
    adapters,
    logger: { warn() {}, error() {} },
    ...options,
  });
  t.after(async () => {
    instance.server.closeAllConnections?.();
    await new Promise((resolve) => instance.server.close(resolve));
  });
  instance.server.listen(0, "127.0.0.1");
  await once(instance.server, "listening");
  const base = `http://127.0.0.1:${instance.server.address().port}`;
  const cookie = await (async () => {
    const response = await fetch(`${base}/api/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key: ADMIN }),
    });
    assert.equal(response.status, 200);
    return response.headers.getSetCookie()[0].split(";")[0];
  })();
  const request = async (path, options2 = {}) => {
    const response = await fetch(`${base}${path}`, {
      ...options2,
      headers: { cookie, ...(options2.body ? { "content-type": "application/json" } : {}), ...(options2.headers || {}) },
    });
    const text = await response.text();
    let body = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // keep text
    }
    return { status: response.status, headers: response.headers, body, text };
  };
  return { ...instance, base, request };
};

test("overview keeps three independent sections and isolates failures", async (t) => {
  const { request } = await panel(t, {
    adapters: {
      cnb: fakeAdapter("cnb"),
      codebuddy: fakeAdapter("codebuddy", {
        async overview() {
          throw new AdapterError("CodeBuddy 服务返回 503", { status: 502, code: "upstream_unavailable" });
        },
        async health() {
          return { status: "degraded", detail: "audit store unavailable" };
        },
      }),
      zcode: fakeAdapter("zcode", {
        async overview() {
          throw new Error("unexpected adapter bug");
        },
      }),
    },
  });
  const result = await request("/api/overview");
  // An unexpected adapter bug is contained in that system's section; one broken
  // adapter must never hide the two healthy systems.
  assert.equal(result.status, 200);
  assert.equal(result.body.cnb.ok, true);
  assert.equal(result.body.zcode.ok, false);
  assert.equal(result.body.zcode.error.code, "internal_error");
  assert.equal(result.body.zcode.error.message, "服务读取失败");
  // Health is a plain string with the message in its own field (design.md).
  assert.equal(result.body.codebuddy.health, "degraded");
  assert.equal(result.body.codebuddy.detail, "audit store unavailable");
  assert.equal(result.body.codebuddy.error.code, "upstream_unavailable");
  assert.equal(typeof result.body.codebuddy.health, "string");

  const ok = await panel(t);
  const healthy = await ok.request("/api/overview");
  assert.equal(healthy.status, 200);
  for (const system of ["cnb", "codebuddy", "zcode"]) {
    const section = healthy.body[system];
    assert.equal(section.ok, true);
    assert.equal(section.system, system);
    assert.equal(section.health, "ok");
    assert.equal(section.detail, `${system} healthy`);
    // Flat payload: no nested `overview` wrapper (design.md).
    assert.equal(section.overview, undefined);
    assert.equal(section.quota.remaining, 42);
    assert.equal(section.accounts.total, 1);
    assert.equal(section.usage[0].label, "今日请求");
  }
  // Never a blended total across systems (R10).
  assert.equal(healthy.body.quota, undefined);
  assert.equal(healthy.body.total, undefined);
  assert.ok(healthy.body.generatedAt);
});

test("a failing system yields an error for that key only", async (t) => {
  const { request } = await panel(t, {
    adapters: {
      cnb: fakeAdapter("cnb"),
      codebuddy: fakeAdapter("codebuddy", {
        async overview() {
          throw new AdapterError("CodeBuddy 服务返回 503", { status: 502, code: "upstream_unavailable" });
        },
      }),
      zcode: fakeAdapter("zcode"),
    },
  });
  const result = await request("/api/overview");
  assert.equal(result.status, 200);
  assert.equal(result.body.cnb.ok, true);
  assert.equal(result.body.zcode.ok, true);
  assert.equal(result.body.codebuddy.ok, false);
  assert.equal(result.body.codebuddy.error.code, "upstream_unavailable");
  assert.match(result.body.codebuddy.error.message, /503/);
  assert.equal(result.body.codebuddy.health, "ok");
});

test("unified account list carries the system tag and hides adapter secrets", async (t) => {
  const { request } = await panel(t);
  const result = await request("/api/accounts");
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.errors, []);
  assert.equal(result.body.accounts.length, 3);
  for (const account of result.body.accounts) {
    assert.match(account.id, /^(cnb|codebuddy|zcode):acct-1$/);
    assert.equal(account.id, `${account.system}:${account.nativeId}`);
    assert.equal(account.tags[0], account.system);
    assert.equal(account.tags.includes(account.system), true);
  }
  const filtered = await request("/api/accounts?system=codebuddy");
  assert.equal(filtered.body.accounts.length, 1);
  assert.equal(filtered.body.accounts[0].system, "codebuddy");
  const unsupported = await request("/api/accounts?system=nope");
  assert.equal(unsupported.status, 400);
});

test("account list reports per-system failures without dropping the others", async (t) => {
  const { request } = await panel(t, {
    adapters: {
      cnb: fakeAdapter("cnb"),
      zcode: fakeAdapter("zcode", {
        async listAccounts() {
          throw new AdapterError("zcode 服务无法连接", { status: 502, code: "upstream_unreachable" });
        },
      }),
    },
  });
  const result = await request("/api/accounts");
  assert.equal(result.status, 200);
  assert.equal(result.body.accounts.length, 1);
  assert.equal(result.body.errors.length, 1);
  assert.equal(result.body.errors[0].system, "zcode");
  assert.equal(result.body.errors[0].error.code, "upstream_unreachable");
});

test("tags are panel-owned and filterable", async (t) => {
  const { request } = await panel(t);
  const id = encodeURIComponent("cnb:acct-1");
  const saved = await request(`/api/accounts/${id}/tags`, {
    method: "PUT",
    body: JSON.stringify({ tags: ["生产", "core"] }),
  });
  assert.equal(saved.status, 200);
  assert.deepEqual(saved.body.userTags, ["生产", "core"]);
  assert.deepEqual(saved.body.tags, ["cnb", "生产", "core"]);

  const byTag = await request(`/api/accounts?tag=${encodeURIComponent("生产")}`);
  assert.equal(byTag.body.accounts.length, 1);
  assert.equal(byTag.body.accounts[0].id, "cnb:acct-1");
  // The automatic system tag is a valid filter too.
  const bySystemTag = await request("/api/accounts?tag=codebuddy");
  assert.equal(bySystemTag.body.accounts.length, 1);
  assert.equal(bySystemTag.body.accounts[0].system, "codebuddy");

  const invalid = await request(`/api/accounts/${id}/tags`, {
    method: "PUT",
    body: JSON.stringify({ tags: ["<script>"] }),
  });
  assert.equal(invalid.status, 400);

  const missing = await request(`/api/accounts/${id}/tags`, {
    method: "PUT",
    body: JSON.stringify({ tags: [] }),
  });
  assert.equal(missing.status, 200);
  const afterClear = await request("/api/accounts?tag=codebuddy");
  assert.equal(afterClear.body.accounts.length, 1);
});

test("passthrough proxy keeps method, query and provider status", async (t) => {
  const seen = [];
  const { request } = await panel(t, {
    adapters: {
      cnb: fakeAdapter("cnb", {
        async call(path, options) {
          seen.push({ path, options });
          if (path === "/api/accounts/missing")
            return { status: 404, body: { error: { message: "账号不存在" } } };
          return { status: 200, body: { path, method: options.method, query: options.query } };
        },
      }),
    },
  });
  const result = await request("/api/p/cnb/api/accounts?limit=5");
  assert.equal(result.status, 200);
  assert.equal(result.body.path, "/api/accounts");
  assert.deepEqual(result.body.query, { limit: "5" });
  assert.equal(seen[0].options.method, "GET");

  const notFound = await request("/api/p/cnb/api/accounts/missing");
  assert.equal(notFound.status, 404);
  assert.equal(notFound.body.error.message, "账号不存在");

  const written = await request("/api/p/cnb/api/settings", {
    method: "PATCH",
    body: JSON.stringify({ strategy: "weighted" }),
  });
  assert.equal(written.body.method, "PATCH");
  const patchCall = seen.find((entry) => entry.options.method === "PATCH");
  assert.equal(Buffer.isBuffer(patchCall.options.body), true);
  assert.deepEqual(JSON.parse(patchCall.options.body.toString("utf8")), { strategy: "weighted" });

  const unsupported = await request("/api/p/nope/api/accounts");
  assert.equal(unsupported.status, 404);
  assert.equal(unsupported.body.error.code, "system_not_supported");
});

test("proxy rejects absolute and traversal paths", async (t) => {
  const { request } = await panel(t, {
    adapters: {
      cnb: fakeAdapter("cnb", {
        async call(path, options) {
          const { buildUrl } = await import("../src/adapters/client.mjs");
          const url = buildUrl("http://cnb:9002", path);
          return { status: 200, body: { url: url.toString() } };
        },
      }),
    },
  });
  // The HTTP client normalises a literal ../.. before sending, so the panel
  // either sees a safe path (404) or rejects the encoded form outright (400).
  const traversal = await request("/api/p/cnb/../../etc/passwd");
  assert.ok([400, 404].includes(traversal.status));
  const encoded = await request("/api/p/cnb/api/%2e%2e/%2e%2e/etc/passwd");
  assert.ok([400, 404].includes(encoded.status));
  assert.notEqual(encoded.status, 200);
});

test("proxy path guard rejects dot segments and nested slashes", () => {
  assert.throws(() => assertSafePath("/api/%2e%2e/x"), /上级目录/);
  assert.throws(() => assertSafePath("/api/%2e/x"));
  assert.throws(() => assertSafePath("/api/a%2Fb"), /上级目录/);
  assert.throws(() => assertSafePath("/api/%zz"));
  assert.doesNotThrow(() => assertSafePath("/api/accounts/acct-1"));
});

test("overview health is a normalized string", async () => {
  assert.equal(normalizeHealth({ status: "ok" }), "ok");
  assert.equal(normalizeHealth({ status: "healthy", detail: "x" }), "ok");
  assert.equal(normalizeHealth({ status: "degraded" }), "degraded");
  assert.equal(normalizeHealth({ status: "down" }), "down");
  assert.equal(normalizeHealth({ status: "offline" }), "down");
  assert.equal(normalizeHealth("OK"), "ok");
  assert.equal(normalizeHealth(undefined), "unknown");
  assert.equal(normalizeHealth(null), "unknown");

  const adapter = fakeAdapter("cnb", {
    async health() {
      return { status: "down", detail: "连接被拒绝" };
    },
    async overview() {
      // A stale adapter-side health value must not win over the probe.
      return { health: "ok", quota: { remaining: 1 } };
    },
  });
  const section = await systemOverview(adapter);
  assert.equal(section.health, "down");
  assert.equal(section.detail, "连接被拒绝");
  assert.equal(section.overview, undefined);
  assert.equal(section.quota.remaining, 1);
});

test("registry falls back to a stub when a system module is absent", async () => {
  const registry = await createRegistry({
    systems: [{ system: "example", baseUrl: "http://example:1234", token: "" }],
    logger: { warn() {}, error() {} },
  });
  assert.equal(registry.isStub("example"), true);
  assert.equal(await registry.get("example").health().then((health) => health.status), "down");
  await assert.rejects(() => registry.get("example").call("/x"), /适配器尚未实现/);
});

test("stub adapters keep the panel bootable and report unavailable", async (t) => {
  const instance = createPanelServer({
    adminKey: ADMIN,
    dataDir: tempDir(t),
    allowLocal: true,
    // Injected stub: the assertion must not depend on which real adapter
    // modules happen to exist in the tree.
    systems: [{ system: "cnb", baseUrl: "http://127.0.0.1:1", token: "" }],
    adapters: { cnb: createStubAdapter({ system: "cnb" }) },
    logger: { warn() {}, error() {} },
  });
  t.after(async () => {
    instance.server.closeAllConnections?.();
    await new Promise((resolve) => instance.server.close(resolve));
  });
  instance.server.listen(0, "127.0.0.1");
  await once(instance.server, "listening");
  const base = `http://127.0.0.1:${instance.server.address().port}`;
  const login = await fetch(`${base}/api/session`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ key: ADMIN }),
  });
  const cookie = login.headers.getSetCookie()[0].split(";")[0];
  const overview = await fetch(`${base}/api/overview`, { headers: { cookie } });
  const body = await overview.json();
  assert.equal(body.cnb.ok, false);
  assert.equal(body.cnb.error.code, "adapter_not_implemented");
  assert.equal(body.cnb.health, "down");
  assert.equal(body.cnb.detail, "适配器尚未实现");
  assert.equal(typeof body.cnb.health, "string");
});

test("authorization flows route to each system adapter", async (t) => {
  const { request } = await panel(t);
  const start = await request("/api/accounts/auth/cnb/start", { method: "POST", body: "{}" });
  assert.equal(start.status, 200);
  assert.equal(start.body.system, "cnb");
  assert.equal(start.body.flowId, "flow-1");

  const poll = await request("/api/accounts/auth/cnb/poll", {
    method: "POST",
    body: JSON.stringify({ flowId: "flow-1" }),
  });
  assert.equal(poll.body.result.status, "pending");

  const complete = await request("/api/accounts/auth/zcode/complete", {
    method: "POST",
    body: JSON.stringify({ flowId: "flow-1", code: "123456" }),
  });
  assert.equal(complete.body.result.status, "done");

  const badFlow = await request("/api/accounts/auth/cnb/poll", {
    method: "POST",
    body: JSON.stringify({ flowId: "" }),
  });
  assert.equal(badFlow.status, 400);

  const badStep = await request("/api/accounts/auth/cnb/redeem", { method: "POST", body: "{}" });
  assert.equal(badStep.status, 404);
});

test("an adapter without an auth flow answers 501 instead of crashing", async (t) => {
  const adapter = fakeAdapter("codebuddy");
  delete adapter.startAuth;
  const { request } = await panel(t, { adapters: { codebuddy: adapter } });
  const result = await request("/api/accounts/auth/codebuddy/start", { method: "POST", body: "{}" });
  assert.equal(result.status, 501);
  assert.equal(result.body.error.code, "auth_flow_unsupported");
});

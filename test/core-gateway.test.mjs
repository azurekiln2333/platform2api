import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fakeAdapter, mockServer, send, testPanel } from "./fixtures.mjs";
import { UsageScanner } from "../src/gateway/index.mjs";
import { PanelStore } from "../src/store.mjs";
import { GatewayStore } from "../src/gateway/store.mjs";

async function setup(t, options = {}) {
  const seen = [], controls = {}, counts = {};
  const native = await mockServer(t, async (req, res) => {
    const system = req.headers["x-api-key"]?.split("-")[1];
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    seen.push({ system, body, headers: req.headers, path: req.url });
    if (controls[system]) return controls[system](req, res, body);
    if (body.stream) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write('data: {"choices":[{"delta":{"content":"hello"}}]}\n\n');
      return setTimeout(() => res.end('data: {"usage":{"prompt_tokens":3,"completion_tokens":5}}\n\ndata: [DONE]\n\n'), 15);
    }
    return send(res, { system, model: body.model, usage: { prompt_tokens: 3, completion_tokens: 5 } });
  });
  const systems = ["cnb", "codebuddy", "zcode", "fourth"];
  const adapters = Object.fromEntries(systems.map((system) => [system, fakeAdapter(system, { baseUrl: native.url,
    inference: () => ({ url: native.url, routes: ["/v1/chat/completions", "/v1/messages"] }),
    ensureUpstreamCredential: async () => { counts[system] = (counts[system] || 0) + 1; return { secret: `native-${system}-${counts[system]}`, id: "platform-key", name: "platform2api 统一入口" }; } })]));
  const p = await testPanel(t, adapters, options);
  const create = async (input = {}) => {
    const r = await p.request("/api/keys", { method: "POST", body: { via: "unified", channels: "*", name: "prod", ...input } });
    assert.equal(r.status, 201, JSON.stringify(r.body)); return r.body;
  };
  const invoke = (key, body = {}, options = {}) => fetch(`${p.url}/v1/chat/completions`, { method: "POST", headers: { "content-type": "application/json", ...(key ? { authorization: `Bearer ${key}` } : {}), ...options.headers }, body: JSON.stringify({ model: "shared", ...body }), signal: options.signal });
  return { ...p, seen, controls, counts, create, invoke, native, adapters };
}

test("AC10/AC12: one unified key routes streams and JSON to every channel including a registered fourth", async (t) => {
  const p = await setup(t), { secret, item } = await p.create();
  for (const system of ["cnb", "codebuddy", "zcode", "fourth"]) {
    const response = await p.invoke(secret, { model: `${system}/${system}-model` }, { headers: { origin: "https://sdk.example", cookie: "platform_session=not-a-session" } });
    assert.equal(response.status, 200); assert.equal(response.headers.get("set-cookie"), null);
    assert.equal((await response.json()).system, system);
    const stream = await p.invoke(secret, { model: `${system}/${system}-model`, stream: true });
    assert.equal(stream.status, 200); assert.match(await stream.text(), /\[DONE\]/);
  }
  assert.ok(p.seen.every((r) => r.body.model === `${r.system}-model`));
  assert.ok(p.seen.every((r) => !r.headers.cookie && !r.headers.origin && r.headers.authorization.startsWith("Bearer native-")));
  assert.ok(p.seen.every((r) => r.headers["x-platform-request-id"]));
  assert.deepEqual(p.counts, { cnb: 1, codebuddy: 1, zcode: 1, fourth: 1 });
  const listed = (await p.request("/api/keys?via=unified")).body.items[0];
  assert.equal(listed.id, item.id); assert.equal(listed.usage.requests, 8); assert.equal(listed.usage.tokens, 64);
  assert.ok(!JSON.stringify(listed).includes(secret));
  const catalog = await fetch(`${p.url}/v1/models`, { headers: { "x-api-key": secret } });
  const models = (await catalog.json()).data.map((row) => row.id);
  assert.equal(models.filter((id) => id === "shared").length, 1); assert.ok(models.includes("fourth-model"));
  const channels = (await p.request("/api/channels")).body;
  assert.ok(channels.find((c) => c.system === "fourth").unifiedUrl.endsWith("/v1"));
  const log = (await p.request("/api/logs?via=unified&limit=50")).body;
  assert.equal(log.items.length, 8); assert.ok(log.items.every((row) => row.via === "unified" && row.key === "prod"));
  const detail = await p.request(`/api/logs/${log.items[0].id}`); assert.equal(detail.status, 200);
  assert.ok(!JSON.stringify(detail.body).includes(secret));
  for (const suffix of ["", "-wal"]) { let disk; try { disk = readFileSync(`${p.store.databaseFile}${suffix}`); } catch { continue; } assert.ok(!disk.includes(secret)); assert.ok(!disk.includes("native-cnb-1")); }
});

test("gateway denies missing, invalid, disabled, expired, out-of-scope, IP and exhausted keys", async (t) => {
  const p = await setup(t);
  assert.equal((await p.invoke(null)).status, 401); assert.equal((await p.invoke("wrong")).status, 401);
  const scoped = await p.create({ channels: ["cnb"] });
  assert.equal((await p.invoke(scoped.secret, { model: "zcode/zcode-model" })).status, 403);
  assert.equal((await p.invoke(scoped.secret, { model: "zcode-model" })).status, 403);
  const models = await p.create({ models: ["cnb-model"] });
  assert.equal((await p.invoke(models.secret, { model: "shared" })).status, 403);
  const expired = await p.create({ expiresAt: "2020-01-01T00:00:00Z" }); assert.equal((await p.invoke(expired.secret)).status, 401);
  const ip = await p.create({ ipAllow: ["192.0.2.0/24"] }); assert.equal((await p.invoke(ip.secret, {}, { headers: { "x-forwarded-for": "192.0.2.1" } })).status, 403);
  await p.request(`/api/keys/${scoped.item.id}`, { method: "PATCH", body: { enabled: false } }); assert.equal((await p.invoke(scoped.secret)).status, 401);
  const quota = await p.create({ quota: 1 }); assert.equal((await p.invoke(quota.secret)).status, 200); assert.equal((await p.invoke(quota.secret)).status, 429);
  const capped = await p.create({ quota: { requests: 1 } });
  assert.equal((await fetch(`${p.url}/v1/models`, { headers: { "x-api-key": capped.secret } })).status, 200);
  assert.equal(p.gatewayStore.listKeys().find((row) => row.id === capped.item.id).usage.requests, 0);
  const responses = await Promise.all([p.invoke(capped.secret), p.invoke(capped.secret)]);
  assert.deepEqual(responses.map((r) => r.status).sort(), [200, 429]);
  const valid = await p.create(); assert.equal((await p.invoke(valid.secret, { model: "missing" })).status, 404);
});

test("routing priorities, failover and explicit selection respect the no-replay boundary", async (t) => {
  const p = await setup(t), key = await p.create();
  p.controls.cnb = (req, res) => send(res, { error: "retry" }, 503);
  let response = await p.invoke(key.secret); assert.equal(response.status, 200); assert.equal((await response.json()).system, "codebuddy");
  assert.deepEqual(p.seen.map((r) => r.system), ["cnb", "codebuddy"]);
  p.controls.cnb = (req, res) => send(res, { error: "retry" }, 429);
  assert.equal((await p.invoke(key.secret)).status, 200);
  response = await p.invoke(key.secret, { model: "cnb/shared" }); assert.equal(response.status, 429);
  const routing = (await p.request("/api/gateway/routing")).body;
  assert.equal((await p.request("/api/gateway/routing", { method: "PATCH", body: { ...routing, failover: false } })).status, 200);
  assert.equal((await p.invoke(key.secret)).status, 429);
  await p.request("/api/gateway/routing", { method: "PATCH", body: { ...routing, order: ["fourth", "zcode", "codebuddy", "cnb"] } });
  response = await p.invoke(key.secret); assert.equal((await response.json()).system, "fourth");
  p.controls.fourth = (req, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.write("data: first\n\n"); setTimeout(() => res.destroy(), 20); };
  const before = p.seen.length; response = await p.invoke(key.secret, { stream: true }); assert.equal(response.status, 200);
  await assert.rejects(response.text()); assert.equal(p.seen.length, before + 1);
});

test("upstream credentials renew on 401 and remain internal", async (t) => {
  const p = await setup(t), key = await p.create();
  p.controls.cnb = (req, res) => req.headers["x-api-key"].endsWith("-1") ? send(res, {}, 401) : send(res, { ok: true });
  const response = await p.invoke(key.secret, { model: "cnb/shared" }); assert.equal(response.status, 200); await response.text();
  assert.equal(p.counts.cnb, 2);
  assert.ok(!JSON.stringify((await p.request("/api/settings")).body).includes("native-cnb"));
});

test("streaming has an idle timeout, not a total timeout, and disconnect aborts the upstream", async (t) => {
  const p = await setup(t, { gateway: { idleTimeoutMs: 200 } }), key = await p.create();
  let aborted = false;
  p.controls.cnb = (req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" }); let count = 0;
    const timer = setInterval(() => { res.write(`data: ${++count}\n\n`); if (count >= 8) { clearInterval(timer); res.end(); } }, 50);
    res.on("close", () => { clearInterval(timer); aborted = true; });
  };
  const long = await p.invoke(key.secret, { model: "cnb/shared", stream: true }); assert.match(await long.text(), /data: 8/);
  aborted = false;
  const controller = new AbortController(); const response = await p.invoke(key.secret, { model: "cnb/shared", stream: true }, { signal: controller.signal });
  await response.body.getReader().read(); controller.abort();
  await new Promise((r) => setTimeout(r, 80)); assert.equal(aborted, true);
  p.controls.cnb = (req, res) => { res.writeHead(200, { "content-type": "text/event-stream" }); res.write("data: initial\n\n"); };
  const idle = await p.invoke(key.secret, { model: "cnb/shared", stream: true }); await assert.rejects(idle.text());
});

test("request size limits and model-only authentication do not weaken management auth", async (t) => {
  const p = await setup(t, { gateway: { bodyLimit: 128 } }), key = await p.create();
  assert.equal((await p.invoke(key.secret, { messages: [{ content: "x".repeat(300) }] })).status, 413);
  const denied = await fetch(`${p.url}/api/keys`, { headers: { authorization: `Bearer ${key.secret}` } }); assert.equal(denied.status, 401);
  assert.equal((await p.request("/api/gateway/routing", { method: "PATCH", body: { order: ["cnb"] } })).status, 400);
});

test("usage scanning handles fragmented OpenAI and Anthropic usage without retaining large bodies", () => {
  const scanner = new UsageScanner();
  for (const fragment of ['data: {"message":{"usage":{"input_', 'tokens":10,"output_tokens":0}}}\n\n', 'data: {"usage":{"output_tokens":15}}\n\n']) scanner.write(Buffer.from(fragment));
  assert.equal(scanner.inputTokens, 10); assert.equal(scanner.outputTokens, 15);
  scanner.write(Buffer.from("x".repeat(200000))); assert.ok(scanner.tail.length <= 131072);
});

test("connection and first-chunk failures can switch channels before committing output", async (t) => {
  let mode = "connect";
  const attempts = [];
  const p = await setup(t, { inferenceFetchImpl: async (url, options) => {
    const system = options.headers["x-api-key"].split("-")[1]; attempts.push(system);
    if (system === "cnb") {
      if (mode === "connect") throw new TypeError("simulated connection failure");
      return new Response(new ReadableStream({ start(controller) { controller.error(new Error("first read failed")); } }), { status: 200 });
    }
    return fetch(url, options);
  } });
  const key = await p.create();
  for (const failure of ["connect", "body"]) {
    mode = failure; attempts.length = 0;
    const response = await p.invoke(key.secret);
    assert.equal(response.status, 200); assert.equal((await response.json()).system, "codebuddy");
    assert.deepEqual(attempts, ["cnb", "codebuddy"]);
  }
});

test("model cache survives catalog failure, marks stale data and respects routing switches", async (t) => {
  const p = await setup(t, { gateway: { modelTtlMs: 0 } }), key = await p.create({ channels: ["fourth"] });
  const catalog = async () => (await (await fetch(`${p.url}/v1/models`, { headers: { "x-api-key": key.secret } })).json()).data;
  assert.equal((await catalog()).find((v) => v.id === "fourth-model").channels[0].stale, false);
  const adapter = (await p.registry).get("fourth");
  adapter.listModels = async () => { throw new Error("temporary model outage"); };
  assert.equal((await catalog()).find((v) => v.id === "fourth-model").channels[0].stale, true);
  assert.equal((await p.invoke(key.secret, { model: "fourth/shared" })).status, 200);
  await p.request("/api/gateway/routing", { method: "PATCH", body: { enabled: { fourth: false } } });
  assert.deepEqual(await catalog(), []);
  assert.equal((await p.invoke(key.secret, { model: "fourth/shared" })).status, 404);
});

test("gateway keys, routing, internal-key history and accounting survive restart and retention cleanup", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "platform-gateway-store-"));
  let panel, store;
  const open = () => { panel = new PanelStore(directory); store = new GatewayStore(panel, ["fourth"]); };
  t.after(() => { store?.close(); panel?.close(); rmSync(directory, { recursive: true, force: true }); });
  open();
  const created = store.createKey({ name: "persisted", channels: "*" });
  const auth = store.authenticate(created.secret, "127.0.0.1");
  store.saveRouting({ order: ["fourth"], enabled: { fourth: true }, failover: false });
  store.saveCredential("fourth", { id: "old-internal", name: "old-name", secret: "native-before" });
  store.saveCredential("fourth", { id: "new-internal", name: "new-name", secret: "native-after" });
  store.record({ status: 200, requestId: "sample", system: "fourth", model: "sample", durationMs: 12, inputTokens: 2, outputTokens: 3 }, auth);
  store.close(); panel.close(); open();
  assert.equal(store.authenticate(created.secret, "127.0.0.1").usage.tokens, 5);
  assert.equal(store.routing().failover, false);
  assert.equal(store.credential("fourth").secret, "native-after");
  assert.deepEqual(store.internalKeyIds("fourth"), ["old-internal", "new-internal"]);
  assert.ok(store.isInternalKey("fourth", "old-name"));
  assert.equal(store.listLogs().items.length, 1);
  const logId = store.listLogs().items[0].id.slice("unified:".length);
  panel.db.prepare("UPDATE gateway_logs SET at=? WHERE id=?").run("2000-01-01T00:00:00.000Z", logId);
  store.setRetentionDays(1);
  assert.equal(store.listLogs().items.length, 0);
  assert.equal(store.listKeys()[0].usage.tokens, 5);
  const rotated = store.keyOperation(auth.nativeId, "rotate");
  assert.throws(() => store.authenticate(created.secret, "127.0.0.1"), (error) => error.status === 401);
  assert.equal(store.authenticate(rotated.secret, "127.0.0.1").name, "persisted");
  store.keyOperation(auth.nativeId, "reset-usage");
  assert.equal(store.listKeys()[0].usage.requests, 0);
  store.keyOperation(auth.nativeId, "delete");
  assert.throws(() => store.authenticate(rotated.secret, "127.0.0.1"), (error) => error.status === 401);
});

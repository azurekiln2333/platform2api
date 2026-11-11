import test from "node:test";
import assert from "node:assert/strict";
import createAdapter from "../src/adapters/zcode.mjs";

function fixture() {
  const calls = [], missing = new Set();
  const keys = [{ id: 1, name: "prod", prefix: "sk-abc", enabled: true, createdAt: 1780000000000, usedTokens: 4, requests: 1, models: ["m"], quotaTokens: 20 }];
  const rows = Array.from({ length: 14 }, (_, i) => ({ id: `req-${i}`, at: new Date(Date.UTC(2026, 10, 11, 0, 0, 59 - i)).toISOString(), model: i % 2 ? "other" : "wanted", accountId: "a1", status: 200, tokenUsage: { input: 2, output: 3 } }));
  const adapter = createAdapter({ baseUrl: "http://mock.invalid", client: { async request(path, options = {}) {
    calls.push({ path, ...options });
    const ok = (body) => ({ ok: true, status: 200, body });
    if (missing.has(path.split("?")[0])) return { ok: false, status: 404, body: {} };
    if (path === "/keys" && options.method === "POST") return ok({ key: { ...keys[0], id: 2, ...options.body }, secret: "one-time-secret" });
    if (path === "/keys") return ok({ keys, masterKeyEnabled: true });
    if (/\/keys\/1\/(update|reset)/.test(path)) return ok({ key: { ...keys[0], ...options.body } });
    if (path === "/keys/1/delete") return ok({ ok: true });
    if (path === "/api/models") return ok({ models: [{ id: "m", eligibleAccounts: [{ id: "a1" }] }] });
    if (path.split("?")[0] === "/api/logs") {
      const offset = Number(options.query?.offset || 0), limit = Number(options.query?.limit || 1);
      return ok({ logs: rows.slice(offset, offset + limit), total: rows.length });
    }
    if (path === "/api/overview") return ok({ accounts: [], settings: { topN: 3, stickyTtlMin: 10 } });
    if (path === "/security") return ok({ enabled: true, mode: "blacklist", rules: [] });
    if (path === "/api/settings") return ok({ applied: options.body });
    return { ok: false, status: 404, body: {} };
  } } });
  return { adapter, api: adapter.console, calls, missing };
}

test("ZCode capabilities and keys match native restrictions and protect master key", async () => {
  const { api, calls, missing } = fixture();
  const caps = await api.capabilities(); assert.equal(caps.keys.create, true); assert.equal(caps.keys.rotate, false); assert.equal(caps.keys.reveal, false);
  const keys = await api.listKeys(); assert.equal(keys[0].builtin, true); assert.equal(keys[1].limits.quota, 20);
  const created = await api.createKey({ name: "new", quota: 99, ipAllow: ["127.0.0.1"], models: ["m"] });
  assert.equal(created.secret, "one-time-secret"); assert.equal(calls.at(-1).body.quotaTokens, 99);
  assert.deepEqual(calls.at(-1).body.ipAllowlist, ["127.0.0.1"]);
  assert.equal((await api.updateKey("1", { enabled: false })).item.enabled, false);
  assert.equal((await api.deleteKey("1")).ok, true); assert.ok((await api.keyAction("1", "reset-usage")).item);
  await assert.rejects(api.deleteKey("master"), (e) => e.status === 501);
  missing.add("/api/models"); assert.equal((await api.capabilities()).models.list, false);
});

test("ZCode log pagination applies sparse filters without losing rows and supports cached details", async () => {
  const { api } = fixture(); let cursor, items = [];
  do { const page = await api.listLogs({ model: "wanted", account: "zcode:a1", limit: 2, cursor }); items.push(...page.items); cursor = page.nextCursor; } while (cursor);
  assert.equal(items.length, 7); assert.equal(new Set(items.map((r) => r.id)).size, 7);
  assert.equal(items[0].inputTokens, 2);
  assert.equal((await api.getLog(items[0].id)).item.id, items[0].id);
  await assert.rejects(api.getLog("not-cached"), (e) => e.status === 404);
  await assert.rejects(api.listLogs({ key: "prod" }), (e) => e.status === 501);
  const usage = await api.usage({ model: "wanted", from: "2026-11-11T00:00:00Z", to: "2026-11-12T00:00:00Z" });
  assert.equal(usage.series[0].requests, 7); assert.equal(usage.series[0].outputTokens, 21);
  assert.equal(usage.extras.keyAttributionAvailable, false);
});

test("ZCode settings use editable schema and inference provisions a separate native credential", async () => {
  const { adapter, api, calls } = fixture();
  assert.equal((await api.settings()).groups[0].fields.find((f) => f.key === "topN").value, 3);
  await api.saveSettings("pool", { topN: 5 }); assert.equal(calls.at(-1).path, "/api/settings");
  await assert.rejects(api.saveSettings("pool", { secret: "injection" }), /不支持/);
  assert.ok(adapter.inference().routes.includes("/v1/messages"));
  const c = await adapter.ensureUpstreamCredential(); assert.equal(c.secret, "one-time-secret"); assert.equal(calls.at(-1).body.name, "platform2api 统一入口");
});

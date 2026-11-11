import test from "node:test";
import assert from "node:assert/strict";
import { AdapterError } from "../src/adapters/client.mjs";
import { fakeAdapter, testPanel } from "./fixtures.mjs";
import { consoleDayStart, usageBucket } from "../src/console-data.mjs";

const broken = async () => { throw new AdapterError("暂时不可达", { code: "upstream_unreachable" }); };
test("all aggregate APIs isolate a failed channel and obey normalized contracts", async (t) => {
  const p = await testPanel(t, { alpha: fakeAdapter("alpha"), fourth: fakeAdapter("fourth"), broken: fakeAdapter("broken", Object.fromEntries(["health", "overview", "listAccounts", "listKeys", "listModels", "listLogs", "usage", "settings", "capabilities"].map((name) => [name, broken]))) });
  const channels = await p.request("/api/channels");
  assert.equal(channels.status, 200); assert.equal(channels.body.length, 3);
  assert.equal(channels.body.find((v) => v.system === "fourth").color, "#123456");
  assert.equal(channels.body.find((v) => v.system === "broken").health, "down");
  for (const endpoint of ["accounts", "keys", "models", "logs", "usage", "settings", "overview"]) {
    const r = await p.request(`/api/${endpoint}`); assert.equal(r.status, 200, endpoint);
    assert.ok(r.body.errors.some((error) => error.system === "broken" && error.message === "暂时不可达"), endpoint);
    assert.ok(!JSON.stringify(r.body).includes("DO-NOT-LEAK"), endpoint);
  }
  const account = (await p.request("/api/accounts?system=fourth&status=ok&q=fourth")).body.items[0];
  assert.equal(account.id, "fourth:account-1"); assert.equal(account.display[0].kind, "badge");
  const overview = (await p.request("/api/overview")).body;
  assert.equal(overview.totals.requestsToday, 4); assert.equal(overview.totals.tokensToday, 6); assert.equal(overview.quota, undefined);
  assert.equal((await p.request("/api/accounts?system=unknown")).status, 400);
});

test("account mutations, model actions, tags and settings reach their owning adapter", async (t) => {
  const calls = [];
  const p = await testPanel(t, { fourth: fakeAdapter("fourth", { accountAction: async (...args) => { calls.push(args); return { ok: true }; } }) });
  for (const [path, method, body] of [["/api/accounts/fourth:account-1", "PATCH", { enabled: false }], ["/api/accounts/fourth:account-1/actions/probe", "POST", {}], ["/api/accounts/fourth:account-1", "DELETE", null]]) {
    assert.equal((await p.request(path, { method, body })).status, 200);
  }
  assert.deepEqual(calls.map((v) => v[1]), ["update", "probe", "delete"]);
  assert.equal((await p.request("/api/accounts/fourth:account-1/tags", { method: "PUT", body: { tags: ["生产"] } })).status, 200);
  assert.equal((await p.request("/api/models/fourth:shared/actions/toggle", { method: "POST", body: { enabled: false } })).body.action, "toggle");
  assert.equal((await p.request("/api/settings/channels/fourth", { method: "PATCH", body: { group: "pool", values: { enabled: false } } })).body.values.enabled, false);
  assert.equal((await p.request("/api/settings/common", { method: "PATCH", body: { group: "gateway-logs", values: { retentionDays: 7 } } })).status, 200);
  assert.equal((await p.request("/api/settings")).body.common[0].fields[0].value, 7);
});

test("key create/update/rotate/delete never expose stored secrets", async (t) => {
  const p = await testPanel(t, { fourth: fakeAdapter("fourth") });
  assert.equal((await p.request("/api/keys", { method: "POST", body: { name: "No channel" } })).status, 400);
  const created = await p.request("/api/keys", { method: "POST", body: { via: "direct", system: "fourth", name: "prod" } });
  assert.equal(created.status, 201); assert.equal(created.body.secret, "ONCE-ONLY-SECRET"); assert.equal(created.body.item.channels[0], "fourth");
  assert.equal((await p.request("/api/keys/fourth:key-1", { method: "PATCH", body: { enabled: false } })).body.item.enabled, false);
  assert.equal((await p.request("/api/keys/fourth:key-1/actions/reveal", { method: "POST", body: {} })).status, 501);
  assert.equal((await p.request("/api/keys/fourth:key-1/actions/rotate", { method: "POST", body: {} })).body.secret, "ROTATED-ONCE");
  assert.equal((await p.request("/api/keys/fourth:key-1/actions/reset-usage", { method: "POST", body: {} })).status, 200);
  assert.equal((await p.request("/api/keys/fourth:key-1", { method: "DELETE" })).status, 200);
});

test("log merge retains overflow rows, stable order, opaque cursors and failed-channel retry", async (t) => {
  let unavailable = true;
  const logs = (system) => Array.from({ length: 7 }, (_, i) => ({ id: `${system}-${i}`, at: new Date(Date.UTC(2026, 10, 11, 0, 0, 30 - i * 3 - (system === "a" ? 0 : 1))).toISOString(), model: "m", status: 200 }));
  const adapter = (system) => fakeAdapter(system, { listLogs: async ({ cursor, limit }) => {
    if (system === "b" && unavailable) throw new Error("simulated bug");
    const rows = logs(system), offset = Number(cursor || 0); return { items: rows.slice(offset, offset + limit), nextCursor: offset + limit < rows.length ? String(offset + limit) : null };
  } });
  const p = await testPanel(t, { a: adapter("a"), b: adapter("b") });
  let response = (await p.request("/api/logs?via=direct&limit=3")).body;
  assert.equal(response.items.length, 3); assert.equal(response.errors.length, 1);
  unavailable = false;
  const fresh = (await p.request("/api/logs?via=direct&limit=3")).body;
  const rows = [...fresh.items]; let cursor = fresh.nextCursor;
  while (cursor) {
    response = (await p.request(`/api/logs?via=direct&limit=3&cursor=${cursor}`)).body;
    assert.deepEqual(response.errors, []); rows.push(...response.items); cursor = response.nextCursor;
  }
  assert.equal(rows.length, 14); assert.equal(new Set(rows.map((r) => r.id)).size, 14);
  assert.deepEqual(rows.map((r) => r.at), rows.map((r) => r.at).sort().reverse());
  const repeated = (await p.request(`/api/logs?via=direct&limit=3&cursor=${fresh.nextCursor}`)).body;
  assert.deepEqual(repeated.items, rows.slice(3, 6));
  assert.equal((await p.request(`/api/logs?via=direct&limit=4&cursor=${fresh.nextCursor}`)).status, 400);
  const detail = await p.request(`/api/logs/${encodeURIComponent(rows[0].id)}`);
  assert.equal(detail.status, 200); assert.equal(detail.body.raw.authorization, "[REDACTED]");
});

test("service URL overrides update the live registry and survive a new read", async (t) => {
  let observed;
  const p = await testPanel(t, { fourth: (config) => { observed = config.baseUrl; return fakeAdapter("fourth", { baseUrl: config.baseUrl }); } });
  const r = await p.request("/api/settings", { method: "PATCH", body: { serviceUrls: { fourth: "http://127.0.0.1:45678" } } });
  assert.equal(r.status, 200); assert.equal(observed, "http://127.0.0.1:45678");
  assert.equal(r.body.services[0].url, observed);
});

test("key mutations preserve read revisions, optional action bodies and internal-key isolation", async (t) => {
  let reads = 0;
  const calls = [];
  const p = await testPanel(t, { fourth: fakeAdapter("fourth", {
    listKeys: async () => { reads++; return [
      { id: "key-1", name: "user", revision: reads },
      { id: "private", name: "platform2api 统一入口" },
      { id: "builtin", name: "builtin", builtin: true },
    ]; },
    updateKey: async (id, input) => { calls.push(input); return { item: { id, revision: input.revision, ...input } }; },
    keyAction: async (id, action, input) => { calls.push(input); return { ok: true }; },
    deleteKey: async (id, input) => { calls.push(input); return { ok: true }; },
  }) });
  p.gatewayStore.saveCredential("fourth", { id: "private", name: "platform2api 统一入口", secret: "PRIVATE-NATIVE-SECRET" });
  const listed = (await p.request("/api/keys?via=direct")).body.items;
  assert.deepEqual(listed.map((row) => row.id).sort(), ["fourth:builtin", "fourth:key-1"]);
  assert.equal((await p.request("/api/keys/fourth:key-1", { method: "PATCH", body: { enabled: false } })).status, 200);
  assert.equal(reads, 1);
  assert.equal(calls[0].revision, 1);
  assert.equal((await p.request("/api/keys/fourth:key-1/actions/rotate", { method: "POST", body: { revision: 7 } })).status, 200);
  assert.equal(calls[1].revision, 7);
  assert.equal((await p.request("/api/keys/fourth:key-1", { method: "DELETE", body: { revision: 8 } })).status, 200);
  assert.equal(calls[2].revision, 8);
  assert.equal((await p.request("/api/keys/fourth:builtin", { method: "DELETE" })).status, 400);
  assert.equal((await p.request("/api/keys/fourth:private", { method: "DELETE" })).status, 404);
  assert.equal(calls.length, 3);
});

test("aggregate accounts retain native email labels through listing, tags and actions", async (t) => {
  const nativeId = "中文 user+ops@example.test", calls = [];
  const p = await testPanel(t, { zcode: fakeAdapter("zcode", {
    listAccounts: async () => [{ nativeId, label: nativeId, enabled: true, status: "ready" }],
    accountAction: async (id) => { calls.push(id); return { ok: true }; },
  }) });
  const listed = (await p.request("/api/accounts")).body;
  assert.deepEqual(listed.errors, []);
  assert.equal(listed.items[0].id, `zcode:${nativeId}`);
  const route = `/api/accounts/${encodeURIComponent(listed.items[0].id)}`;
  assert.equal((await p.request(`${route}/tags`, { method: "PUT", body: { tags: ["production"] } })).status, 200);
  assert.deepEqual((await p.request(`${route}/tags`)).body.tags, ["production"]);
  assert.equal((await p.request(route, { method: "PATCH", body: { enabled: false } })).status, 200);
  assert.deepEqual(calls, [nativeId]);
  for (const invalid of ["a/b", "a\\b", "%2F", "a\u0000b"]) {
    assert.equal((await p.request(`/api/accounts/${encodeURIComponent(`zcode:${invalid}`)}`, { method: "PATCH", body: {} })).status, 400);
  }
  assert.equal(calls.length, 1);
});

test("usage adds unified counts only when native usage excluded internal credentials", async (t) => {
  const p = await testPanel(t, {
    excluded: fakeAdapter("excluded", { usage: async () => ({ excludesInternalKeys: true, series: [{ bucket: "2026-11-11", requests: 2 }], byModel: [], byKey: [], byAccount: [] }) }),
    included: fakeAdapter("included", { usage: async () => ({ series: [{ bucket: "2026-11-11", requests: 3 }], byModel: [], byKey: [], byAccount: [] }) }),
  });
  const created = p.gatewayStore.createKey({ name: "application", channels: "*" });
  const key = p.gatewayStore.authenticate(created.secret, "127.0.0.1");
  for (const system of ["excluded", "included"]) p.gatewayStore.record({ requestId: system, system, status: 200, model: "shared", durationMs: 2, inputTokens: 3, outputTokens: 5 }, key);
  const all = (await p.request("/api/usage")).body;
  assert.equal(all.series.reduce((sum, row) => sum + row.requests, 0), 6);
  assert.equal(all.byKey.filter((row) => row.via === "unified").reduce((sum, row) => sum + row.requests, 0), 2);
  const unified = (await p.request("/api/usage?via=unified&bucket=hour")).body;
  assert.equal(unified.series.reduce((sum, row) => sum + row.requests, 0), 2);
  assert.ok(unified.series.every((row) => Number.isFinite(Date.parse(row.bucket))));
});

test("native key passthrough cannot expose or mutate gateway credentials", async (t) => {
  const calls = [];
  const p = await testPanel(t, { fourth: fakeAdapter("fourth", {
    keyManagement: { list: "/admin/keys", items: "items", prefix: "/admin/keys/", revealSuffix: "/reveal" },
    call: async (path) => {
      calls.push(path);
      return { status: 200, body: { total: 3, items: [{ id: "private" }, { id: "retired" }, { id: "ordinary" }] } };
    },
  }) });
  p.gatewayStore.saveCredential("fourth", { id: "retired", secret: "OLD-INTERNAL-SECRET" });
  p.gatewayStore.saveCredential("fourth", { id: "private", secret: "INTERNAL-SECRET" });
  for (const route of ["/admin/keys", "/admin/%6beys"]) {
    const listed = await p.request(`/api/p/fourth${route}`);
    assert.deepEqual(listed.body, { total: 1, items: [{ id: "ordinary" }] });
  }
  for (const [path, method] of [["private", "PATCH"], ["retired", "DELETE"], ["private/reveal", "POST"], ["%70rivate/rotate", "POST"], ["ordinary/reveal", "POST"]])
    assert.equal((await p.request(`/api/p/fourth/admin/keys/${path}`, { method, body: {} })).status, 403);
  assert.equal(calls.length, 2);
  assert.equal((await p.request("/api/p/fourth/admin/keys/ordinary", { method: "PATCH", body: { enabled: false } })).status, 200);
});

test("overview uses today's UTC+8 hours and usage buckets align across native formats", async (t) => {
  const midnight = consoleDayStart(), current = new Date(Math.floor(Date.now() / 3600000) * 3600000).toISOString();
  const make = (system, bucket) => fakeAdapter(system, {
    overview: async () => ({ requestsToday: 3, tokensToday: 5, hourly: [
      { at: new Date(midnight - 3600000).toISOString(), requests: 100 },
      { at: current, requests: 3 },
      { at: new Date(Date.now() + 7200000).toISOString(), requests: 100 },
    ] }),
    usage: async () => ({ series: [{ bucket, requests: 1 }], byKey: [], byModel: [], byAccount: [] }),
  });
  const p = await testPanel(t, { a: make("a", "2026-11-11"), b: make("b", "2026-11-10T16:00:00.000Z") });
  const overview = (await p.request("/api/overview")).body;
  assert.deepEqual(overview.hourly, [{ hour: current, a: 3, b: 3 }]);
  const usage = (await p.request("/api/usage")).body;
  assert.equal(new Set(usage.series.map((row) => row.bucket)).size, 1);
  assert.equal(usage.series[0].bucket, "2026-11-10T16:00:00.000Z");
  assert.equal(usageBucket("2026-11-10T18:12:00Z"), "2026-11-10T16:00:00.000Z");
  assert.equal(usageBucket("2026-11-11T02", "hour"), "2026-11-11T02:00:00.000Z");
});

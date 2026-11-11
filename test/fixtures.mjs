import assert from "node:assert/strict";
import http from "node:http";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPanelServer } from "../src/app.mjs";

export const send = (res, body, status = 200) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
export async function mockServer(t, handler) {
  const server = http.createServer(handler);
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); });
  return { server, url: `http://127.0.0.1:${server.address().port}` };
}
export function fakeAdapter(system, options = {}) {
  return { system, health: async () => ({ status: "ok" }), overview: async () => ({ accounts: { total: 1, ready: 1 }, requestsToday: 2, tokensToday: 3, hourly: [{ hour: "2026-11-11T01:00:00Z", requests: 2 }] }),
    listAccounts: async () => [{ nativeId: "account-1", label: `${system} account`, status: "ready", enabled: true, display: [{ key: "region", label: "区域", value: system, kind: "badge" }], actions: [{ id: "probe", label: "探测" }], raw: { access_token: "DO-NOT-LEAK", nested: { authorization: "Bearer DO-NOT-LEAK" } } }],
    accountAction: async (id, action, payload) => ({ id, action, ...payload }), call: async () => ({ status: 200, body: { ok: true } }),
    capabilities: async () => ({ accounts: { add: ["manual"], batch: ["enable", "disable", "probe", "delete", "tags"] }, keys: { create: true, update: true, delete: true, rotate: true, resetUsage: true, fields: [{ key: "models", type: "list", label: "模型" }] }, models: { toggle: true }, logs: { kinds: ["request"], filters: [] }, usage: { extras: [] } }),
    listKeys: async () => [{ nativeId: "key-1", name: "Direct", masked: "sk-***", enabled: true }], createKey: async (input) => ({ item: { nativeId: "key-2", ...input }, secret: "ONCE-ONLY-SECRET" }),
    updateKey: async (id, input) => ({ item: { nativeId: id, ...input } }), deleteKey: async () => ({ ok: true }), keyAction: async (id, action) => ({ item: { nativeId: id, name: "Direct" }, ...(action === "rotate" ? { secret: "ROTATED-ONCE" } : {}) }),
    listModels: async () => [{ nativeId: `${system}-model`, model: `${system}-model`, enabled: true }, { nativeId: "shared", model: "shared", enabled: true }], modelAction: async (id, action) => ({ id, action }),
    listLogs: async () => ({ items: [], nextCursor: null }), getLog: async (id) => ({ item: { id, at: "2026-11-11T00:00:00Z" }, raw: { authorization: "Bearer DO-NOT-LEAK" }, display: [] }),
    usage: async () => ({ series: [{ bucket: "2026-11-11", requests: 2, inputTokens: 3, outputTokens: 4 }], byModel: [], byKey: [], byAccount: [], extras: {} }),
    settings: async () => ({ groups: [{ id: "pool", title: "调度", fields: [{ key: "enabled", type: "bool", value: true }] }], embeds: [] }), saveSettings: async (group, values) => ({ group, values }),
    ...options };
}
export async function testPanel(t, adapters, options = {}) {
  const directory = mkdtempSync(join(tmpdir(), "platform-console-test-"));
  const panel = createPanelServer({ adminKey: "platform-fixture-admin-key", dataDir: directory, allowLocal: true,
    systems: Object.keys(adapters).map((system) => ({ system, label: system.toUpperCase(), color: "#123456", baseUrl: adapters[system].baseUrl || "http://127.0.0.1:1", token: "MANAGEMENT-ONLY" })), adapters,
    logger: { warn() {}, error() {} }, ...options });
  panel.server.listen(0, "127.0.0.1"); await once(panel.server, "listening");
  t.after(async () => { await panel.close(); rmSync(directory, { recursive: true, force: true }); });
  const url = `http://127.0.0.1:${panel.server.address().port}`;
  const login = await fetch(`${url}/api/session`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ key: "platform-fixture-admin-key" }) });
  assert.equal(login.status, 200); const cookie = login.headers.getSetCookie()[0].split(";")[0];
  const request = async (path, { method = "GET", body, headers = {} } = {}) => {
    const response = await fetch(`${url}${path}`, { method, headers: { cookie, ...(body ? { "content-type": "application/json" } : {}), ...headers }, ...(body ? { body: JSON.stringify(body) } : {}) });
    const data = await response.json(); return { status: response.status, body: data, headers: response.headers };
  };
  return { ...panel, url, directory, request };
}

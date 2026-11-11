// This harness starts production loaders/management routes against disposable
// copies. It must never start account refresh, claim, inference or desktop seed.
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import tls from "node:tls";
import dns from "node:dns";
import childProcess from "node:child_process";
import timers from "node:timers";
import { syncBuiltinESMExports } from "node:module";
import { pathToFileURL } from "node:url";

const mode = process.env.CREDENTIAL_SMOKE_SERVICE;
const statusFile = process.env.CREDENTIAL_SMOKE_STATUS;
const state = { started: false, outboundBlocked: 0, desktopSeedBlocked: true };
const writeStatus = () => fs.writeFileSync(statusFile, JSON.stringify(state));
const blocked = () => {
  state.outboundBlocked++;
  writeStatus();
  throw new Error("Smoke harness disallows outbound operations");
};
const isLoopback = (host) => ["127.0.0.1", "::1", "[::1]"].includes(host);
const connect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function (...args) {
  const values = Array.isArray(args[0]) ? args[0] : args;
  const first = values[0];
  const host = typeof first === "object" ? first.host : values[1];
  if (mode !== "panel" || !isLoopback(host)) return blocked();
  return connect.apply(this, args);
};
tls.connect = blocked;
const lookup = dns.lookup;
dns.lookup = (host, ...args) => isLoopback(host) ? lookup(host, ...args) : blocked();
dns.resolve = blocked;
const lookupPromise = dns.promises.lookup;
dns.promises.lookup = (host, ...args) => isLoopback(host) ? lookupPromise(host, ...args) : blocked();
dns.promises.resolve = blocked;
const fetchLocal = globalThis.fetch;
globalThis.fetch = (input, options) => {
  const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
  if (mode !== "panel" || url.protocol !== "http:" || !isLoopback(url.hostname)) return blocked();
  return fetchLocal(input, options);
};
for (const method of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"])
  childProcess[method] = blocked;

if (mode === "zcode") {
  // zcgw-server starts its own listener and schedules desktop-token seeding,
  // quota refresh and automatic claims from the listen callback. Disable all
  // application timers before importing it; HTTP's internal timers are intact.
  const inactiveTimer = () => ({ unref() { return this; }, ref() { return this; }, hasRef() { return false; } });
  timers.setTimeout = globalThis.setTimeout = inactiveTimer;
  timers.setInterval = globalThis.setInterval = inactiveTimer;
}
syncBuiltinESMExports();
writeStatus();

let instance;
try {
  const repo = process.env.CREDENTIAL_SMOKE_REPO;
  const directory = process.env.CREDENTIAL_SMOKE_DATA;
  const port = Number(process.env.PORT);
  if (mode === "cnb") {
    const { createPanelServer } = await import(pathToFileURL(path.join(repo, "src/app.mjs")));
    instance = createPanelServer({
      adminKey: process.env.PANEL_ADMIN_KEY,
      gatewayKey: process.env.GATEWAY_KEY,
      dataDir: directory,
      logDir: path.join(path.dirname(directory), "cnb-logs"),
      allowLocal: true,
    });
    // Creating Pool is safe; calling Pool.start would reach real accounts.
    instance.server.listen(port, "127.0.0.1");
  } else if (mode === "zcode") {
    await import(pathToFileURL(path.join(repo, "zcgw-server.mjs")));
  } else if (mode === "panel") {
    const { createPanelServer } = await import(pathToFileURL(path.join(repo, "src/app.mjs")));
    const systems = JSON.parse(process.env.CREDENTIAL_SMOKE_CHANNELS).map((entry) => ({
      ...entry, token: process.env.PANEL_ADMIN_KEY,
    }));
    instance = createPanelServer({
      adminKey: process.env.PANEL_ADMIN_KEY,
      dataDir: directory,
      allowLocal: true,
      systems,
      logger: { warn() {}, error() {} },
    });
    instance.server.listen(port, "127.0.0.1");
  } else throw new Error("Unknown smoke service");
  state.started = true;
  writeStatus();
} catch {
  state.failed = true;
  writeStatus();
  process.exitCode = 1;
}

process.on("message", async (message) => {
  if (message !== "close") return;
  try {
    if (instance?.close) await instance.close();
    else if (instance?.server) {
      instance.server.closeAllConnections?.();
      await new Promise((resolve) => instance.server.close(resolve));
      instance.store?.close?.();
    }
  } finally { process.exit(0); }
});

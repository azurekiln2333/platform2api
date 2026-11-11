// Opt-in integration smoke: node test/credential-load-smoke.mjs
// Sources are read only; production loaders run only against temporary copies.
// Output is restricted to source filenames, counts and boolean check results.
import { createHash, randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import net from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const sourceRoot = "D:/My2KProjects/data";
const panelRepo = path.resolve(fileURLToPath(new URL("..", import.meta.url)));
const support = fileURLToPath(new URL("./credential-load-smoke-support/", import.meta.url));
const repos = {
  cnb: "D:/My2KProjects/cnb2api-panel",
  codebuddy: "D:/My2KProjects/codebuddy2api-main/codebuddy2api",
  zcode: "D:/My2KProjects/zcode2api/ZCode2api",
};
const sources = {
  cnb: "cnb",
  codebuddy: "data_5E8ZP/data/codebuddy",
  zcode: "data_5E8ZP/data/zcode",
};
const nativePaths = { cnb: "/api/accounts", codebuddy: "/admin/credentials", zcode: "/api/overview" };
const children = [];
const copied = new Map();
const result = { files: [], sourceCounts: {}, nativeCounts: {}, panelCounts: {}, checks: {} };
const root = mkdtempSync(path.join(tmpdir(), "platform-credential-smoke-"));
const adminKey = randomBytes(24).toString("hex");
const gatewayKey = randomBytes(24).toString("hex");
const digest = (data) => createHash("sha256").update(data).digest("hex");
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const baseEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  ["path", "systemroot", "windir", "temp", "tmp", "pathext", "comspec"].includes(key.toLowerCase())));

function copyFile(relative, target) {
  const source = path.join(sourceRoot, relative);
  if (!lstatSync(source).isFile()) throw new Error("Source is not a regular file");
  const bytes = readFileSync(source);
  copied.set(relative.replaceAll("\\", "/"), digest(bytes));
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, bytes, { mode: 0o600, flag: "wx" });
}

function copyTree(relative, target) {
  const source = path.join(sourceRoot, relative);
  if (!lstatSync(source).isDirectory()) throw new Error("Source is not a directory");
  mkdirSync(target, { recursive: true });
  for (const entry of readdirSync(source, { withFileTypes: true })) {
    if (entry.isSymbolicLink()) throw new Error("Source links are not permitted");
    const child = path.join(relative, entry.name);
    if (entry.isDirectory()) copyTree(child, path.join(target, entry.name));
    else if (entry.isFile()) copyFile(child, path.join(target, entry.name));
    else throw new Error("Unsupported source entry");
  }
}

async function allocatePort() {
  const server = net.createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

function start(service, port, channels) {
  const directory = path.join(root, service);
  mkdirSync(directory, { recursive: true });
  const python = service === "codebuddy";
  const env = {
    ...baseEnv,
    CREDENTIAL_SMOKE_SERVICE: service,
    CREDENTIAL_SMOKE_REPO: service === "panel" ? panelRepo : repos[service],
    CREDENTIAL_SMOKE_DATA: directory,
    CREDENTIAL_SMOKE_STATUS: path.join(root, `${service}-status.json`),
    CREDENTIAL_SMOKE_CHANNELS: JSON.stringify(channels || []),
    PANEL_ADMIN_KEY: adminKey,
    GATEWAY_KEY: gatewayKey,
    CODEBUDDY2API_KEY: gatewayKey,
    CODEBUDDY_AUTH_DIR: directory,
    ZCGW_DATA_DIR: directory,
    ZCODE_HOME: path.join(root, "disabled-desktop"),
    HOST: "127.0.0.1",
    PORT: String(port),
    PYTHONDONTWRITEBYTECODE: "1",
    PYTHONIOENCODING: "utf-8",
  };
  const child = spawn(python ? "python" : process.execPath,
    [path.join(support, python ? "codebuddy-service.py" : "node-service.mjs")], {
      cwd: root, env, windowsHide: true,
      stdio: python ? ["ignore", "ignore", "ignore"] : ["ignore", "ignore", "ignore", "ipc"],
    });
  const item = { service, child, port, statusFile: env.CREDENTIAL_SMOKE_STATUS };
  child.on("error", () => { item.failed = true; });
  children.push(item);
  return item;
}

async function readApi(port, endpoint, options = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${endpoint}`, {
    ...options,
    headers: { Authorization: `Bearer ${adminKey}`, ...options.headers },
    signal: AbortSignal.timeout(2500),
    redirect: "error",
  });
  if (!response.ok) throw new Error("Management request failed");
  return { response, body: await response.json() };
}

async function waitReady(item, endpoint) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (item.failed || item.child.exitCode !== null) break;
    try { return await readApi(item.port, endpoint); } catch { /* never print service bodies */ }
    await pause(150);
  }
  throw new Error("Management service did not become ready");
}

function entries(body) {
  const value = Array.isArray(body) ? body : body.items ?? body.accounts ?? body.credentials;
  if (!Array.isArray(value)) throw new Error("Invalid inventory response");
  return value;
}

async function stop(item) {
  const child = item.child;
  if (child.exitCode !== null || child.signalCode !== null || !child.pid) return;
  const stopped = once(child, "exit").catch(() => {});
  if (child.connected) child.send("close");
  else child.kill();
  await Promise.race([stopped, pause(2000)]);
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  await stopped;
}

try {
  for (const filename of ["accounts.json", "master.key", "panel.json", "stats.json"])
    copyFile(path.join(sources.cnb, filename), path.join(root, "cnb", filename));
  copyTree(sources.codebuddy, path.join(root, "codebuddy"));
  copyFile(path.join(sources.zcode, "accounts.json"), path.join(root, "zcode", "accounts.json"));
  result.sourceCounts.cnb = JSON.parse(readFileSync(path.join(root, "cnb", "accounts.json"), "utf8")).accounts.length;
  result.sourceCounts.codebuddy = readdirSync(path.join(root, "codebuddy")).filter((name) => name.endsWith(".info")).length;
  result.sourceCounts.zcode = JSON.parse(readFileSync(path.join(root, "zcode", "accounts.json"), "utf8")).length;
  const channels = [];
  for (const service of Object.keys(repos)) {
    const item = start(service, await allocatePort());
    const { body } = await waitReady(item, nativePaths[service]);
    const count = entries(body).length;
    result.nativeCounts[service] = count;
    result.checks[`${service}Loaded`] = count > 0 && count === result.sourceCounts[service];
    if (!result.checks[`${service}Loaded`]) throw new Error("Inventory count mismatch");
    channels.push({ system: service, baseUrl: `http://127.0.0.1:${item.port}`, timeoutMs: 5000 });
  }
  const panel = start("panel", await allocatePort(), channels);
  await waitReady(panel, "/health");
  const login = await readApi(panel.port, "/api/session", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ key: adminKey }),
  });
  const cookies = login.response.headers.getSetCookie().map((value) => value.split(";")[0]).join("; ");
  const { body } = await readApi(panel.port, "/api/accounts", { headers: { Cookie: cookies } });
  const accounts = entries(body);
  result.checks.noChannelErrors = Array.isArray(body.errors) && body.errors.length === 0;
  for (const service of Object.keys(repos)) {
    result.panelCounts[service] = accounts.filter((account) => account.system === service).length;
    result.checks[`${service}PanelRead`] = result.panelCounts[service] === result.nativeCounts[service];
  }
  result.checks.panelSqliteCreated = existsSync(path.join(root, "panel", "panel.sqlite"));
  result.checks.loaded = result.checks.noChannelErrors && Object.keys(repos).every((service) => result.checks[`${service}PanelRead`]);
} catch {
  result.checks.loaded = false;
} finally {
  for (const item of [...children].reverse()) await stop(item);
  result.checks.processesStopped = children.every(({ child }) => child.exitCode !== null || child.signalCode !== null || !child.pid);
  for (const item of children) {
    if (existsSync(item.statusFile)) {
      const status = JSON.parse(readFileSync(item.statusFile, "utf8"));
      result.checks[`${item.service}NoOutboundAttempt`] = status.outboundBlocked === 0;
      result.checks[`${item.service}Started`] = status.started === true || status.installed === true;
      if (item.service === "codebuddy")
        for (const name of ["imported", "initialized", "loaded", "installed"])
          result.checks[`codebuddy_${name}`] = status[name] === true;
      if (status.failureFiles) result.failureFiles = status.failureFiles;
    }
  }
  result.files = [...copied.keys()].sort();
  result.totals = { files: result.files.length, accounts: Object.values(result.panelCounts).reduce((sum, count) => sum + count, 0) };
  result.checks.sourceUnchanged = result.files.every((relative) => {
    try { return digest(readFileSync(path.join(sourceRoot, relative))) === copied.get(relative); }
    catch { return false; }
  });
  // Check the resolved deletion target before removing any temporary data.
  const resolved = path.resolve(root);
  const temporaryRoot = path.resolve(tmpdir());
  const parent = path.dirname(resolved);
  if (parent === temporaryRoot && path.basename(resolved).startsWith("platform-credential-smoke-")) {
    rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    result.checks.temporaryDataRemoved = !existsSync(resolved);
  } else result.checks.temporaryDataRemoved = false;
  result.checks.passed = Object.values(result.checks).every((value) => value === true);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exitCode = result.checks.passed ? 0 : 1;
}

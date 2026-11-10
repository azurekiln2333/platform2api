import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { configFromEnv } from "../src/server.mjs";
import { normalizeServiceUrl } from "../src/store.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const compose = readFileSync(`${root}docker-compose.yaml`, "utf8");
const composeBuild = readFileSync(`${root}docker-compose.build.yaml`, "utf8");
const envExample = readFileSync(`${root}.env.example`, "utf8");
const dockerfile = readFileSync(`${root}Dockerfile`, "utf8");
const workflow = readFileSync(`${root}.github/workflows/build-and-release.yml`, "utf8");

test("env config uses Compose DNS and one independent URL per system", () => {
  const config = configFromEnv({
    PANEL_ADMIN_KEY: "panel-admin-key-0001",
    CNB_URL: "http://cnb:9002/",
    CODEBUDDY_URL: "http://codebuddy:8787",
    ZCODE_URL: "http://zcode:12283",
    PLATFORM_ALLOW_LOCAL_UPSTREAM: "true",
  });
  assert.equal(config.port, 9000);
  assert.equal(config.host, "0.0.0.0");
  assert.deepEqual(
    config.systems.map((entry) => [entry.system, entry.baseUrl, entry.token]),
    [
      // One key opens all four consoles, so each service credential defaults
      // to the panel's own key (D1/D3).
      ["cnb", "http://cnb:9002", "panel-admin-key-0001"],
      ["codebuddy", "http://codebuddy:8787", "panel-admin-key-0001"],
      ["zcode", "http://zcode:12283", "panel-admin-key-0001"],
    ],
  );
  assert.equal(config.ssoBootstrap, null);
});

test("the panel key keeps the legacy name as an alias, new name wins", () => {
  assert.equal(configFromEnv({ PLATFORM_ADMIN_KEY: "legacy-key-000001" }).adminKey, "legacy-key-000001");
  assert.equal(
    configFromEnv({ PANEL_ADMIN_KEY: "new-key-00000001", PLATFORM_ADMIN_KEY: "legacy-key-000001" }).adminKey,
    "new-key-00000001",
  );
  assert.equal(configFromEnv({}).adminKey, undefined);
});

test("a service key override wins and the old token name is the last fallback", () => {
  const overridden = configFromEnv({
    PANEL_ADMIN_KEY: "panel-admin-key-0001",
    CNB_ADMIN_KEY: "cnb-own-key-000001",
    CODEBUDDY_PLATFORM_TOKEN: "legacy-codebuddy-token",
  });
  assert.deepEqual(
    overridden.systems.map((entry) => entry.token),
    [
      // Explicit override wins over the shared key.
      "cnb-own-key-000001",
      // The shared key wins over the legacy per-service token.
      "panel-admin-key-0001",
      "panel-admin-key-0001",
    ],
  );

  const legacyOnly = configFromEnv({
    PANEL_ADMIN_KEY: "panel-admin-key-0001",
    CODEBUDDY_ADMIN_KEY: "",
    CODEBUDDY_PLATFORM_TOKEN: "legacy-codebuddy-token",
  });
  // A blank override falls back to the shared key, never to an empty credential.
  assert.equal(legacyOnly.systems[1].token, "panel-admin-key-0001");
});

test("the public console URL accepts both names", () => {
  assert.equal(configFromEnv({ PANEL_PUBLIC_URL: "https://panel.example.com/" }).publicUrl, "https://panel.example.com");
  assert.equal(
    configFromEnv({ PLATFORM_PUBLIC_URL: "https://panel.example.com" }).publicUrl,
    "https://panel.example.com",
  );
});

test("env config rejects an invalid port and seeds SSO settings", () => {
  assert.throws(() => configFromEnv({ PLATFORM_PORT: "0" }), /PLATFORM_PORT/);
  const config = configFromEnv({
    PLATFORM_SSO_ENABLED: "true",
    PLATFORM_OIDC_ISSUER: "https://idp.example.com",
    PLATFORM_OIDC_ALLOWED_EMAILS: "admin@example.com, ops@example.com",
  });
  assert.equal(config.ssoBootstrap.enabled, true);
  assert.deepEqual(config.ssoBootstrap.allowedEmails, ["admin@example.com", "ops@example.com"]);
});

test("service urls must be http(s) origins", () => {
  assert.equal(normalizeServiceUrl("http://cnb:9002/", { allowLocal: true }), "http://cnb:9002");
  assert.throws(() => normalizeServiceUrl("ftp://cnb", { allowLocal: true }), /HTTP/);
  assert.throws(() => normalizeServiceUrl("http://user:pw@cnb:9002", { allowLocal: true }), /凭据/);
  assert.throws(() => normalizeServiceUrl("http://cnb.example.com:9002"), /HTTPS/);
  assert.equal(normalizeServiceUrl("https://cnb.example.com:9002"), "https://cnb.example.com:9002");
});

test("env example keeps only the panel key and the four public URLs", () => {
  const assignments = envExample
    .split(/\r?\n/)
    .filter((line) => line.trim() && !line.trim().startsWith("#"))
    .map((line) => line.split("=")[0].trim());
  assert.deepEqual(assignments, [
    "PANEL_ADMIN_KEY",
    "PLATFORM_PUBLIC_URL",
    "CNB_PUBLIC_URL",
    "CODEBUDDY_PUBLIC_URL",
    "ZCODE_PUBLIC_URL",
  ]);
  // Every value starts empty: nothing else needs setting (AC1).
  for (const line of envExample.split(/\r?\n/))
    if (line.includes("=") && !line.trim().startsWith("#")) assert.match(line, /^[A-Z_]+=$/);
  assert.equal(/PLATFORM_TOKEN|GATEWAY_KEY|OIDC_/.test(envExample), false);
});

test("compose defines the panel, three services and the updater", () => {
  for (const name of ["platform2api:", "cnb:", "codebuddy:", "zcode:", "watchtower:"]) {
    assert.ok(compose.includes(`\n  ${name}`), `compose is missing service ${name}`);
  }
  // Panel reaches services over Compose DNS, never loopback defaults.
  assert.match(compose, /CNB_URL: http:\/\/cnb:9002/);
  assert.match(compose, /CODEBUDDY_URL: http:\/\/codebuddy:8787/);
  assert.match(compose, /ZCODE_URL: http:\/\/zcode:12283/);
  // Fixed host ports, one bind host, no port variables (D5).
  for (const port of ["9000", "9002", "8787", "12283"])
    assert.match(compose, new RegExp(`\\$\\{BIND_HOST:-127\\.0\\.0\\.1\\}:${port}:${port}`));
  assert.equal(/PLATFORM_PORT|SERVICE_BIND_HOST|PANEL_PORT/.test(compose), false);
  assert.match(compose, /\$\{BIND_HOST:-127\.0\.0\.1\}/);
});

test("compose loads .env once and leaves container settings to the images", () => {
  assert.match(compose, /x-app: &app/);
  assert.match(compose, /env_file:\n\s+- \.env/);
  // Removed variables (R4/R5): no per-service tokens, gateway keys, OIDC or TZ.
  for (const gone of ["PLATFORM_TOKEN", "GATEWAY_KEY", "OIDC_", "COMPOSE_PROJECT_NAME", "TZ:", "ZCODE_UPSTREAM_ORIGIN", "ZCODE_MODEL", "PANEL_DATA_DIR", "PANEL_ERROR"])
    assert.equal(compose.includes(gone), false, `compose still declares ${gone}`);
  // Each service maps its own public URL into the name that service reads.
  assert.match(compose, /PANEL_PUBLIC_URL: \$\{CNB_PUBLIC_URL:-\}/);
  assert.match(compose, /PUBLIC_ORIGIN: \$\{CODEBUDDY_PUBLIC_URL:-\}/);
  assert.match(compose, /PANEL_PUBLIC_URL: \$\{ZCODE_PUBLIC_URL:-\}/);
});

test("every application container opts into the scoped updater", () => {
  const block = (name) => compose.split(`\n  ${name}:`)[1].split(/\n  [a-z0-9-]+:\n/)[0];
  for (const service of ["platform2api", "cnb", "codebuddy", "zcode"]) {
    // The shared anchor supplies restart, env_file and labels.
    assert.match(block(service), /<<: \*app/, `${service} must use the shared anchor`);
  }
  assert.match(compose, /com\.centurylinklabs\.watchtower\.enable: "true"/);
  assert.match(compose, /com\.centurylinklabs\.watchtower\.scope: platform2api/);
  const watchtower = block("watchtower");
  assert.match(watchtower, /nickfedor\/watchtower:1\.23\.2/);
  assert.match(watchtower, /WATCHTOWER_LABEL_ENABLE: "true"/);
  assert.match(watchtower, /WATCHTOWER_CLEANUP: "true"/);
  assert.match(watchtower, /WATCHTOWER_POLL_INTERVAL: "\$\{WATCHTOWER_POLL_INTERVAL:-600\}"/);
  assert.match(watchtower, /\/var\/run\/docker\.sock:\/var\/run\/docker\.sock/);
  // The updater must never update itself.
  assert.match(watchtower, /watchtower\.enable: "false"/);
});

test("compose keeps one private data directory per service", () => {
  const mounts = [...compose.matchAll(/^\s+- \.\/data\/([^\s:]+):/gm)].map((match) => match[1]);
  assert.deepEqual(mounts.sort(), ["cnb/data", "cnb/logs", "codebuddy", "panel", "zcode"]);
  assert.equal(new Set(mounts).size, mounts.length);
  assert.match(compose, /- \.\/data\/codebuddy:\/data\/auth/);
  assert.match(compose, /- \.\/data\/zcode:\/app\/data/);
});

test("compose pulls every image from GHCR by default", () => {
  for (const image of ["platform2api", "cnb2api-panel", "codebuddy2api", "zcode2api"])
    assert.match(compose, new RegExp(`\\$\\{[A-Z_]+:-ghcr\\.io/azurekiln2333/${image}:latest\\}`));
  assert.equal(compose.includes("docker.cnb.cool"), false);
});

test("build overlay points at the sibling service repositories", () => {
  assert.match(composeBuild, /\.\.\/cnb2api-panel/);
  assert.match(composeBuild, /\.\.\/codebuddy2api-main\/codebuddy2api/);
  assert.match(composeBuild, /\.\.\/zcode2api\/ZCode2api/);
  for (const image of ["platform2api", "cnb2api-panel", "codebuddy2api", "zcode2api"])
    assert.match(composeBuild, new RegExp(`ghcr\\.io/azurekiln2333/${image}:latest`));
});

test("dockerfile runs the panel entry point and exposes 9000", () => {
  assert.match(dockerfile, /EXPOSE 9000/);
  assert.match(dockerfile, /CMD \["node", "src\/server\.mjs"\]/);
  assert.match(dockerfile, /HEALTHCHECK/);
  assert.match(dockerfile, /PLATFORM_DATA_DIR=\/app\/data/);
});

test("workflow validates compose and publishes a release on tags", () => {
  assert.match(workflow, /docker compose config/);
  assert.match(workflow, /cp \.env\.example \.env/);
  assert.match(workflow, /PANEL_ADMIN_KEY=\$\{key\}/);
  assert.match(workflow, /name: Validate the Compose deployment/);
  assert.match(workflow, /gh release create/);
  assert.match(workflow, /needs: \[test, image\]/);
  assert.match(workflow, /startsWith\(github\.ref, 'refs\/tags\/v'\)/);
});

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

test("env config uses Compose DNS and one independent URL per system", () => {
  const config = configFromEnv({
    PLATFORM_ADMIN_KEY: "platform-admin-key",
    CNB_URL: "http://cnb:9002/",
    CODEBUDDY_URL: "http://codebuddy:8787",
    ZCODE_URL: "http://zcode:12283",
    CNB_PLATFORM_TOKEN: "cnb-token",
    PLATFORM_ALLOW_LOCAL_UPSTREAM: "true",
  });
  assert.equal(config.port, 9000);
  assert.equal(config.host, "0.0.0.0");
  assert.deepEqual(
    config.systems.map((entry) => [entry.system, entry.baseUrl, entry.token]),
    [
      ["cnb", "http://cnb:9002", "cnb-token"],
      ["codebuddy", "http://codebuddy:8787", ""],
      ["zcode", "http://zcode:12283", ""],
    ],
  );
  assert.equal(config.ssoBootstrap, null);
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

test("compose defines the panel and three independent services", () => {
  for (const name of ["platform2api:", "cnb:", "codebuddy:", "zcode:"]) {
    assert.ok(compose.includes(`\n  ${name}`), `compose is missing service ${name}`);
  }
  // Panel reaches services over Compose DNS, never loopback defaults.
  assert.match(compose, /CNB_URL: http:\/\/cnb:9002/);
  assert.match(compose, /CODEBUDDY_URL: http:\/\/codebuddy:8787/);
  assert.match(compose, /ZCODE_URL: http:\/\/zcode:12283/);
  // Independent host ports for model traffic (AC6/AC7).
  for (const port of ["9000", "9002", "8787", "12283"]) assert.ok(compose.includes(port));
  assert.match(compose, /"?\$\{PLATFORM_PORT:-9000\}:9000"?/);
});

test("compose keeps one private data directory per service", () => {
  const mounts = [...compose.matchAll(/^\s+- \.\/data\/([^\s:]+):/gm)].map((match) => match[1]);
  assert.deepEqual(mounts.sort(), ["cnb/data", "cnb/logs", "codebuddy", "panel", "zcode"]);
  // No service may share another service's data directory.
  assert.equal(new Set(mounts).size, mounts.length);
  assert.match(compose, /- \.\/data\/codebuddy:\/data\/auth/);
  assert.match(compose, /- \.\/data\/zcode:\/app\/data/);
});

test("compose wires platform tokens and health checks for every container", () => {
  assert.match(compose, /CNB_PLATFORM_TOKEN: \$\{CNB_PLATFORM_TOKEN:-\}/);
  assert.match(compose, /CODEBUDDY_PLATFORM_TOKEN: \$\{CODEBUDDY_PLATFORM_TOKEN:-\}/);
  assert.match(compose, /ZCODE_PLATFORM_TOKEN: \$\{ZCODE_PLATFORM_TOKEN:-\}/);
  for (const service of ["platform2api", "cnb", "codebuddy", "zcode"]) {
    const block = compose.split(`\n  ${service}:`)[1].split(/\n  [a-z0-9-]+:\n/)[0];
    assert.match(block, /healthcheck:/, `${service} needs a healthcheck`);
    assert.match(block, /restart: unless-stopped/, `${service} needs a restart policy`);
  }
  // Tokens must never be baked into the image or the example file as values.
  assert.match(envExample, /CNB_PLATFORM_TOKEN=\n/);
  assert.match(envExample, /PLATFORM_ADMIN_KEY=\n/);
});

test("build overlay points at the sibling service repositories", () => {
  assert.match(composeBuild, /\.\.\/cnb2api-panel/);
  assert.match(composeBuild, /\.\.\/codebuddy2api-main\/codebuddy2api/);
  assert.match(composeBuild, /\.\.\/zcode2api\/ZCode2api/);
});

test("dockerfile runs the panel entry point and exposes 9000", () => {
  assert.match(dockerfile, /EXPOSE 9000/);
  assert.match(dockerfile, /CMD \["node", "src\/server\.mjs"\]/);
  assert.match(dockerfile, /HEALTHCHECK/);
  assert.match(dockerfile, /PLATFORM_DATA_DIR=\/app\/data/);
});

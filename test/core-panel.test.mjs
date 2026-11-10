import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { generateKeyPairSync, createSign, createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { createPanelServer } from "../src/app.mjs";
import { resetOidcCaches } from "../src/oidc.mjs";

const ADMIN = "platform-test-admin-key";
const SUBJECT = "admin-subject-1";
const EMAIL = "admin@example.com";

const tempDir = (t) => {
  const dir = mkdtempSync(join(tmpdir(), "platform2api-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
};

const listen = async (server) => {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
};

const panel = async (t, options = {}) => {
  const instance = createPanelServer({
    adminKey: ADMIN,
    dataDir: tempDir(t),
    allowLocal: true,
    systems: [],
    logger: { warn() {}, error() {} },
    ...options,
  });
  t.after(async () => {
    instance.server.closeAllConnections?.();
    await new Promise((resolve) => instance.server.close(resolve));
  });
  const base = await listen(instance.server);
  return { ...instance, base };
};

const client = (base) => {
  let cookie = "";
  const request = async (path, options = {}) => {
    const headers = { ...(options.headers || {}) };
    if (cookie) headers.cookie = cookie;
    const response = await fetch(`${base}${path}`, { ...options, headers, redirect: "manual" });
    const setCookie = response.headers.getSetCookie?.() || [];
    for (const value of setCookie) {
      const pair = value.split(";")[0];
      if (pair.startsWith("platform_session=")) cookie = pair.endsWith("=") ? "" : pair;
    }
    const text = await response.text();
    let body = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      // non-JSON responses stay text
    }
    return { status: response.status, headers: response.headers, body, setCookie, text };
  };
  return {
    request,
    get cookie() {
      return cookie;
    },
    async login(key = ADMIN) {
      const result = await request("/api/session", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ key }),
      });
      return result;
    },
  };
};

test("panel refuses a weak admin key", () => {
  assert.throws(
    () => createPanelServer({ adminKey: "short", dataDir: mkdtempSync(join(tmpdir(), "p-")) }),
    /PANEL_ADMIN_KEY/,
  );
});

test("key login, session read and logout mirror cnb2api-panel", async (t) => {
  const { base } = await panel(t);
  const api = client(base);

  const config = await api.request("/api/auth/config");
  assert.equal(config.status, 200);
  assert.equal(config.body.keyLoginEnabled, true);
  assert.deepEqual(config.body.systems, []);

  const anonymous = await api.request("/api/overview");
  assert.equal(anonymous.status, 401);
  assert.equal(anonymous.body.error.message, "请先登录管理面板");
  assert.equal(anonymous.body.error.type, "invalid_request_error");

  const wrong = await api.login("definitely-not-the-key");
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.error.message, "管理密钥不正确");

  const ok = await api.login();
  assert.equal(ok.status, 200);
  assert.equal(ok.body.authenticated, true);
  assert.equal(ok.body.user.provider, "key");
  const cookie = ok.setCookie.join(";");
  assert.match(cookie, /platform_session=[a-f0-9]{64}/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);

  const session = await api.request("/api/session");
  assert.equal(session.status, 200);
  assert.equal(session.body.authenticated, true);

  const logout = await api.request("/api/session", { method: "DELETE" });
  assert.equal(logout.status, 200);
  const after = await api.request("/api/session");
  assert.equal(after.status, 401);
});

test("repeated key failures are rate limited", async (t) => {
  const { base } = await panel(t);
  const api = client(base);
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const result = await api.login(`wrong-key-${attempt}`);
    assert.equal(result.status, 401);
  }
  const limited = await api.login("wrong-key-again");
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("retry-after"), "600");
  // The correct key stays blocked until the window expires.
  const blocked = await api.login();
  assert.equal(blocked.status, 429);
});

test("mutating api calls require a matching Origin", async (t) => {
  const { base } = await panel(t);
  const api = client(base);
  const rejected = await api.request("/api/session", {
    method: "POST",
    headers: { "content-type": "application/json", origin: "https://evil.example" },
    body: JSON.stringify({ key: ADMIN }),
  });
  assert.equal(rejected.status, 403);
  const accepted = await api.request("/api/session", {
    method: "POST",
    headers: { "content-type": "application/json", origin: base },
    body: JSON.stringify({ key: ADMIN }),
  });
  assert.equal(accepted.status, 200);
});

test("health endpoints answer without a session", async (t) => {
  const { base } = await panel(t);
  const api = client(base);
  const health = await api.request("/health");
  assert.equal(health.status, 200);
  assert.equal(health.body.panel, "ok");
  const apiHealth = await api.request("/api/health");
  assert.equal(apiHealth.status, 200);
  assert.deepEqual(apiHealth.body.systems, []);
});

test("unbuilt console reports a build hint instead of crashing", async (t) => {
  const { base } = await panel(t, { webRoot: join(tempDir(t), "missing") });
  const api = client(base);
  const result = await api.request("/");
  assert.equal(result.status, 404);
  assert.match(result.body.error.message, /前端尚未构建/);
});

test("malformed JSON is rejected with the shared error shape", async (t) => {
  const { base } = await panel(t);
  const api = client(base);
  const result = await api.request("/api/session", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not json",
  });
  assert.equal(result.status, 400);
  assert.equal(result.body.error.type, "invalid_request_error");
  assert.equal(result.body.error.message, "请求体须为有效的 JSON");
});

test("sso settings are sanitized and guarded", async (t) => {
  const { base } = await panel(t);
  const api = client(base);
  await api.login();

  const initial = await api.request("/api/auth/settings");
  assert.equal(initial.status, 200);
  assert.equal(initial.body.ssoEnabled, false);
  assert.equal(initial.body.hasClientSecret, false);
  assert.equal(initial.body.callbackUrl, `${base}/api/auth/oidc/callback`);

  // Enabling SSO without an issuer, client and allowlist is refused.
  const incomplete = await api.request("/api/auth/settings", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ssoEnabled: true }),
  });
  assert.equal(incomplete.status, 400);
  assert.match(incomplete.body.error.message, /颁发者/);

  // Key login cannot be closed before an SSO session proves it works.
  const lockout = await api.request("/api/auth/settings", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ keyLoginEnabled: false }),
  });
  assert.equal(lockout.status, 400);
  assert.match(lockout.body.error.message, /关闭密钥登录前/);

  // Plain HTTP is only allowed for loopback in local mode.
  const insecure = await api.request("/api/auth/settings", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ issuer: "http://idp.example.com" }),
  });
  assert.equal(insecure.status, 400);
  assert.match(insecure.body.error.message, /HTTPS/);
});

test("panel settings expose service urls without leaking tokens", async (t) => {
  const { base } = await panel(t, {
    systems: [
      { system: "cnb", baseUrl: "http://cnb:9002", token: "cnb-secret-token" },
      // No adapter module exists for this name, so it must resolve to the stub.
      { system: "example", baseUrl: "http://example:1234", token: "" },
    ],
    adapters: {},
  });
  const api = client(base);
  await api.login();
  const settings = await api.request("/api/settings");
  assert.equal(settings.status, 200);
  assert.equal(settings.text.includes("cnb-secret-token"), false);
  const cnb = settings.body.systems.find((entry) => entry.system === "cnb");
  assert.equal(cnb.url, "http://cnb:9002");
  assert.equal(cnb.tokenConfigured, true);
  const example = settings.body.systems.find((entry) => entry.system === "example");
  assert.equal(example.stub, true);

  const patched = await api.request("/api/settings", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ serviceUrls: { cnb: "http://cnb.internal:9002" } }),
  });
  assert.equal(patched.status, 200);
  assert.equal(patched.body.serviceUrls.cnb, "http://cnb.internal:9002");

  const bad = await api.request("/api/settings", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ serviceUrls: { cnb: "ftp://cnb" } }),
  });
  assert.equal(bad.status, 400);
});

// --- OIDC -------------------------------------------------------------------
const b64url = (value) => Buffer.from(value).toString("base64url");

// Minimal provider: discovery, RS256 id_token, client_secret_basic token
// endpoint and a UserInfo route. Mirrors the cnb2api-panel contract.
async function provider(t, { subject = SUBJECT, email = EMAIL } = {}) {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const kid = "test-kid-1";
  const jwk = publicKey.export({ format: "jwk" });
  const state = { issuer: "", codes: new Map(), tokens: new Map(), authorize: null };
  const sign = (payload) => {
    const header = b64url(JSON.stringify({ alg: "RS256", kid, typ: "JWT" }));
    const body = b64url(JSON.stringify(payload));
    const signer = createSign("RSA-SHA256");
    signer.update(`${header}.${body}`);
    return `${header}.${body}.${signer.sign(privateKey).toString("base64url")}`;
  };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, "http://provider.local");
    const json = (status, data) => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    };
    if (url.pathname === "/.well-known/openid-configuration")
      return json(200, {
        issuer: state.issuer,
        authorization_endpoint: `${state.issuer}/authorize`,
        token_endpoint: `${state.issuer}/token`,
        userinfo_endpoint: `${state.issuer}/userinfo`,
        jwks_uri: `${state.issuer}/jwks`,
        id_token_signing_alg_values_supported: ["RS256"],
      });
    if (url.pathname === "/jwks") return json(200, { keys: [{ ...jwk, kid, use: "sig", alg: "RS256" }] });
    if (url.pathname === "/authorize") {
      state.authorize = { ...Object.fromEntries(url.searchParams), at: Date.now() };
      const redirect = new URL(url.searchParams.get("redirect_uri"));
      const code = `code-${state.codes.size + 1}`;
      state.codes.set(code, {
        challenge: url.searchParams.get("code_challenge"),
        nonce: url.searchParams.get("nonce"),
        redirectUri: url.searchParams.get("redirect_uri"),
      });
      redirect.searchParams.set("code", code);
      redirect.searchParams.set("state", url.searchParams.get("state"));
      res.writeHead(302, { location: redirect.toString() });
      res.end();
      return;
    }
    if (url.pathname === "/token") {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const form = new URLSearchParams(Buffer.concat(chunks).toString("utf8"));
      if (form.get("grant_type") !== "authorization_code") return json(400, { error: "unsupported_grant_type" });
      const entry = state.codes.get(form.get("code"));
      if (!entry) return json(400, { error: "invalid_grant" });
      const challenge = createHash("sha256")
        .update(form.get("code_verifier") || "")
        .digest("base64url");
      if (challenge !== entry.challenge) return json(400, { error: "invalid_grant" });
      state.codes.delete(form.get("code"));
      const now = Math.floor(Date.now() / 1000);
      const idToken = sign({
        iss: state.issuer,
        aud: "platform2api",
        sub: subject,
        email,
        email_verified: true,
        name: "管理员",
        iat: now,
        exp: now + 300,
        nonce: entry.nonce,
      });
      return json(200, { access_token: "access-token", token_type: "Bearer", id_token: idToken });
    }
    if (url.pathname === "/userinfo") return json(200, { sub: subject, email, email_verified: true });
    return json(404, { error: "not_found" });
  });
  const base = await listen(server);
  state.issuer = base;
  t.after(async () => {
    server.closeAllConnections?.();
    await new Promise((resolve) => server.close(resolve));
  });
  return { base, state };
}

test("OIDC login issues a panel session end to end", async (t) => {
  resetOidcCaches();
  const idp = await provider(t);
  const { base } = await panel(t);
  const api = client(base);
  await api.login();
  const saved = await api.request("/api/auth/settings", {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      ssoEnabled: true,
      issuer: idp.base,
      clientId: "platform2api",
      clientSecret: "client-secret",
      allowedEmails: [EMAIL],
    }),
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.ssoEnabled, true);
  assert.equal(saved.body.hasClientSecret, true);

  const ssoApi = client(base);
  const start = await ssoApi.request("/api/auth/oidc/login");
  assert.equal(start.status, 302);
  const authorizeUrl = new URL(start.headers.get("location"));
  assert.equal(authorizeUrl.origin + authorizeUrl.pathname, `${idp.base}/authorize`);
  assert.equal(authorizeUrl.searchParams.get("code_challenge_method"), "S256");
  const oidcCookie = start.setCookie.find((value) => value.startsWith("platform_oidc="));
  assert.ok(oidcCookie);

  // Browser leg 1: the provider registers the code and redirects to the panel.
  const authorize = await fetch(authorizeUrl, { redirect: "manual" });
  assert.equal(authorize.status, 302);
  const callbackUrl = new URL(authorize.headers.get("location"));
  assert.equal(callbackUrl.pathname, "/api/auth/oidc/callback");
  assert.equal(callbackUrl.searchParams.get("state"), authorizeUrl.searchParams.get("state"));

  // Browser leg 2: the panel exchanges the code and issues the session.
  const callback = await fetch(callbackUrl, {
    headers: { cookie: oidcCookie.split(";")[0] },
    redirect: "manual",
  });
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.get("location"), "/#overview");
  const sessionCookie = callback.headers.getSetCookie().find((value) => value.startsWith("platform_session="));
  assert.ok(sessionCookie, "SSO callback must issue a panel session");

  const session = await fetch(`${base}/api/session`, {
    headers: { cookie: sessionCookie.split(";")[0] },
  });
  assert.equal(session.status, 200);
  const body = await session.json();
  assert.equal(body.user.provider, "oidc");
  assert.equal(body.user.email, EMAIL);
});

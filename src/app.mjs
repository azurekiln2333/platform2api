import http from "node:http";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import {
  InputError,
  MAX_JSON_BYTES,
  MAX_PASSTHROUGH_BYTES,
  cookieValue,
  errorResponse,
  json,
  readJsonBody,
  redirect,
  requestUrl,
  serveStatic,
} from "./http.mjs";
import { PanelStore, parseAccountId } from "./store.mjs";
import { SESSION_MS, assertOrigin, createOriginGuard, createSessionManager, equals } from "./session.mjs";
import { validateSso } from "./sso.mjs";
import {
  OidcError,
  buildAuthorizationUrl,
  createTransaction,
  discoverProvider,
  exchangeAuthorizationCode,
  fetchUserInfo,
  identityFromClaims,
  isAllowed,
  safeEqual,
  verifyIdTokenForConfig,
} from "./oidc.mjs";
import { createRegistry } from "./adapters/index.mjs";
import { AdapterError } from "./adapters/client.mjs";
import { buildOverview, describeError } from "./overview.mjs";
import { authAction, listAccounts, saveTags } from "./accounts.mjs";
import { proxyRequest, proxyTarget, writeProxyResult } from "./proxy.mjs";

const OIDC_TRANSACTION_MS = 10 * 60 * 1000;
const ADMIN_KEY_MIN = 12;

const digest = (value) => createHash("sha256").update(String(value)).digest();
const ssoFingerprint = (sso) =>
  digest(
    JSON.stringify([
      sso.issuer,
      sso.clientId,
      sso.clientSecret,
      sso.scope,
      sso.allowedSubjects,
      sso.allowedEmails,
      sso.callbackUrl,
    ]),
  ).toString("hex");

const validateOrigin = (publicUrl) => {
  if (!publicUrl) return;
  let parsed;
  try {
    parsed = new URL(publicUrl);
  } catch {
    throw new Error("PLATFORM_PUBLIC_URL must be a valid HTTP(S) origin");
  }
  if (
    !["http:", "https:"].includes(parsed.protocol) ||
    parsed.username ||
    parsed.password ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash
  )
    throw new Error("PLATFORM_PUBLIC_URL must be an HTTP(S) origin without a path or credentials");
};

export function createPanelServer(options) {
  const {
    adminKey,
    dataDir,
    publicUrl = "",
    allowLocal = false,
    ssoBootstrap = null,
    systems = [],
    adapters = {},
    logger = console,
    fetchImpl,
    webRoot = fileURLToPath(new URL("../web/dist/", import.meta.url)),
    sessionCookieName = "platform_session",
    oidcCookieName = "platform_oidc",
  } = options;
  if (!adminKey || adminKey.length < ADMIN_KEY_MIN)
    throw new Error(`PLATFORM_ADMIN_KEY must contain at least ${ADMIN_KEY_MIN} characters`);
  validateOrigin(publicUrl);

  const store = new PanelStore(dataDir, { allowLocal });
  if (ssoBootstrap && typeof ssoBootstrap === "object") store.seedSso(ssoBootstrap);

  const isSecure = (req) =>
    publicUrl ? new URL(publicUrl).protocol === "https:" : Boolean(req.socket.encrypted);
  const sessions = createSessionManager({ cookieName: sessionCookieName, isSecure });
  const validOrigin = createOriginGuard({ publicUrl });
  const oidcCookie = (req, value, age) =>
    `${oidcCookieName}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${isSecure(req) ? "; Secure" : ""}`;
  const oidcTransactions = new Map();
  const pruneTransactions = () => {
    const now = Date.now();
    for (const [id, tx] of oidcTransactions) if (tx.expiresAt <= now) oidcTransactions.delete(id);
    if (oidcTransactions.size >= 500) oidcTransactions.delete(oidcTransactions.keys().next().value);
  };
  const safeReason = (error) =>
    error instanceof OidcError && /^[a-z_]+$/.test(error.reason) ? error.reason : "internal_error";
  const requestOrigin = (req) =>
    publicUrl
      ? new URL(publicUrl).origin
      : `${isSecure(req) ? "https" : "http"}://${req.headers.host || "localhost"}`;
  const ssoCallbackUrl = (req) =>
    store.state.sso.callbackUrl || `${requestOrigin(req)}/api/auth/oidc/callback`;

  const registryPromise = createRegistry({
    systems,
    adapters,
    logger,
    clientOptions: fetchImpl ? { fetchImpl } : {},
  });

  const ssoLogin = async (req, res) => {
    const sso = store.state.sso;
    if (!sso.enabled) return redirect(res, "/?auth_error=sso_disabled");
    let discovery;
    try {
      discovery = await discoverProvider(sso, { allowLocal });
    } catch {
      return redirect(res, "/?auth_error=discovery_failed");
    }
    pruneTransactions();
    const tx = createTransaction();
    const redirectUri = ssoCallbackUrl(req);
    oidcTransactions.set(tx.txid, {
      state: tx.state,
      nonce: tx.nonce,
      verifier: tx.verifier,
      redirectUri,
      expiresAt: Date.now() + OIDC_TRANSACTION_MS,
    });
    const location = buildAuthorizationUrl(sso, {
      redirectUri,
      state: tx.state,
      nonce: tx.nonce,
      codeChallenge: tx.challenge,
      authorizationEndpoint: discovery.authorizationEndpoint,
    });
    return redirect(res, location, { "Set-Cookie": oidcCookie(req, tx.txid, OIDC_TRANSACTION_MS / 1000) });
  };

  const ssoCallback = async (req, res) => {
    const sso = store.state.sso;
    const clearCookie = oidcCookie(req, "", 0);
    const fail = (reason) =>
      redirect(res, `/?auth_error=${reason}`, { "Set-Cookie": clearCookie });
    if (!sso.enabled) return fail("sso_disabled");
    const url = requestUrl(req);
    const txid = cookieValue(req, oidcCookieName);
    const tx = txid ? oidcTransactions.get(txid) : null;
    if (txid) oidcTransactions.delete(txid);
    if (!tx || tx.expiresAt <= Date.now()) return fail("transaction_expired");
    if (url.searchParams.get("error")) return fail("provider_error");
    const state = url.searchParams.get("state") || "";
    if (!safeEqual(state, tx.state)) return fail("state_mismatch");
    const code = url.searchParams.get("code") || "";
    if (!code || code.length > 4096) return fail("missing_code");
    let discovery;
    let tokens;
    try {
      discovery = await discoverProvider(sso, { allowLocal });
      tokens = await exchangeAuthorizationCode(sso, {
        code,
        codeVerifier: tx.verifier,
        redirectUri: tx.redirectUri,
        tokenEndpoint: discovery.tokenEndpoint,
      });
    } catch (error) {
      return fail(safeReason(error));
    }
    let idClaims;
    try {
      idClaims = await verifyIdTokenForConfig(sso, tokens.id_token, { nonce: tx.nonce, allowLocal });
    } catch (error) {
      return fail(safeReason(error));
    }
    let userInfo = null;
    try {
      userInfo = await fetchUserInfo(discovery, tokens.access_token);
    } catch {
      // UserInfo stays optional; verified ID token claims remain the fallback.
    }
    if (userInfo && userInfo.sub !== idClaims.sub) return fail("userinfo_mismatch");
    let identity;
    try {
      identity = identityFromClaims(userInfo, idClaims);
    } catch (error) {
      return fail(safeReason(error));
    }
    if (!isAllowed(identity, sso)) return fail("not_allowed");
    const token = sessions.create({
      ssoFingerprint: ssoFingerprint(sso),
      subject: identity.sub,
      user: {
        name: identity.name || identity.sub || "SSO 用户",
        email: identity.email,
        picture: identity.picture,
        provider: "oidc",
      },
    });
    return redirect(res, "/#overview", {
      "Set-Cookie": [sessions.cookie(req, token, SESSION_MS / 1000), clearCookie],
    });
  };

  const api = async (req, res, path, session) => {
    const url = requestUrl(req);
    const registry = await registryPromise;
    const route = (system) => registry.get(system);

    if (path === "/api/auth/config" && req.method === "GET") {
      const sso = store.state.sso;
      return json(res, 200, {
        keyLoginEnabled: sso.keyLoginEnabled,
        sso: {
          enabled: sso.enabled,
          providerName: sso.providerName || "SSO",
          loginUrl: sso.enabled ? "/api/auth/oidc/login" : "",
        },
        systems: registry.systems(),
      });
    }
    if (path === "/api/auth/oidc/login" && req.method === "GET") return ssoLogin(req, res);
    if (path === "/api/auth/oidc/callback" && req.method === "GET") return ssoCallback(req, res);

    // No session yet: only the key login is reachable.
    if (!session) {
      if (path !== "/api/session" || req.method !== "POST")
        throw new InputError("请先登录管理面板", 401);
    }

    if (path === "/api/session" && req.method === "POST") {
      if (!store.state.sso.keyLoginEnabled)
        throw new InputError("管理密钥登录已停用，请使用单点登录", 403);
      const ip = req.socket.remoteAddress || "unknown";
      if (!sessions.loginAllowed(ip))
        return json(
          res,
          429,
          { error: { message: "登录尝试过多，请 10 分钟后重试", type: "invalid_request_error" } },
          { "Retry-After": "600" },
        );
      const input = await readJsonBody(req, 4096);
      if (!equals(input.key, adminKey)) {
        sessions.recordFailure(ip);
        throw new InputError("管理密钥不正确", 401);
      }
      sessions.clearFailures(ip);
      const user = { name: "管理员", email: "", picture: "", provider: "key" };
      const token = sessions.create({ user });
      return json(res, 200, { authenticated: true, user }, {
        "Set-Cookie": sessions.cookie(req, token, SESSION_MS / 1000),
      });
    }

    if (path === "/api/session" && req.method === "GET")
      return json(res, 200, { authenticated: true, user: session.user, systems: registry.systems() });
    if (path === "/api/session" && req.method === "DELETE") {
      sessions.destroy(session.token);
      return json(res, 200, { ok: true }, { "Set-Cookie": sessions.cookie(req, "", 0) });
    }

    if (path === "/api/auth/settings" && req.method === "GET")
      return json(res, 200, store.viewSso(ssoCallbackUrl(req)));
    if (path === "/api/auth/settings" && req.method === "PATCH") {
      const input = await readJsonBody(req);
      const previous = store.state.sso;
      const fields = {};
      if (input.ssoEnabled !== undefined) fields.enabled = input.ssoEnabled;
      for (const key of [
        "keyLoginEnabled",
        "issuer",
        "clientId",
        "clientSecret",
        "scope",
        "providerName",
        "allowedSubjects",
        "allowedEmails",
        "callbackUrl",
      ])
        if (input[key] !== undefined) fields[key] = input[key];
      const { validateSso } = await import("./sso.mjs");
      const candidate = validateSso(fields, previous, { allowLocal });
      // Closing key login needs proof that SSO actually works.
      if (
        previous.keyLoginEnabled &&
        candidate.keyLoginEnabled === false &&
        (session.user.provider !== "oidc" ||
          session.ssoFingerprint !== ssoFingerprint(candidate))
      )
        throw new InputError("请先通过 SSO 登录验证，再关闭管理密钥登录");
      const needsDiscovery =
        candidate.enabled &&
        (!previous.enabled ||
          previous.issuer !== candidate.issuer ||
          previous.clientId !== candidate.clientId ||
          (!candidate.keyLoginEnabled && previous.keyLoginEnabled));
      if (needsDiscovery) {
        try {
          await discoverProvider(candidate, { allowLocal });
        } catch {
          throw new InputError("SSO 颁发者不可用或 discovery 校验失败，请检查地址后重试");
        }
      }
      store.saveSso(candidate);
      return json(res, 200, store.viewSso(candidate.callbackUrl || ssoCallbackUrl(req)));
    }

    if (path === "/api/settings" && req.method === "GET")
      return json(res, 200, panelSettings(store, systems, registry));
    if (path === "/api/settings" && req.method === "PATCH") {
      const input = await readJsonBody(req);
      if (input.serviceUrls !== undefined) store.saveServiceUrls(input.serviceUrls);
      return json(res, 200, panelSettings(store, systems, registry));
    }

    if (path === "/api/overview" && req.method === "GET") return json(res, 200, await buildOverview(registry));

    if (path === "/api/accounts" && req.method === "GET") {
      const result = await listAccounts(registry, store, {
        system: url.searchParams.get("system") || "",
        tag: url.searchParams.get("tag") || "",
      });
      return json(res, 200, result);
    }

    const tagsRoute = /^\/api\/accounts\/([^/]+)\/tags$/.exec(path);
    if (tagsRoute) {
      const id = decodeURIComponent(tagsRoute[1]);
      if (req.method === "PUT" || req.method === "PATCH") {
        const input = await readJsonBody(req);
        parseAccountId(id);
        return json(res, 200, saveTags(store, id, input));
      }
      if (req.method === "GET") {
        parseAccountId(id);
        return json(res, 200, { id, tags: store.tags(id) });
      }
      throw new InputError("method not allowed", 405);
    }

    const authRoute = /^\/api\/accounts\/auth\/([a-z]+)\/(start|poll|complete)$/.exec(path);
    if (authRoute) {
      if (req.method !== "POST") throw new InputError("method not allowed", 405);
      const [, system, action] = authRoute;
      route(system);
      const payload = await readJsonBody(req, MAX_JSON_BYTES);
      return json(res, 200, await authAction(registry, system, action, payload));
    }

    const target = proxyTarget(path);
    if (target) {
      route(target.system);
      const result = await proxyRequest({
        req,
        registry,
        system: target.system,
        path: target.path,
        search: url.searchParams,
        maxBytes: MAX_PASSTHROUGH_BYTES,
      });
      return writeProxyResult(res, result);
    }

    throw new InputError("接口不存在", 404);
  };

  const server = http.createServer(async (req, res) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "same-origin");
    res.setHeader("X-Frame-Options", "DENY");
    try {
      const url = requestUrl(req);
      const path = url.pathname;
      const session = sessions.get(req);
      assertOrigin(validOrigin, req);

      if (path === "/health" && req.method === "GET") {
        const body = { status: "ok", panel: "ok", session: session ? "authenticated" : "anonymous" };
        return json(res, 200, body);
      }

      if (path === "/api/health" && req.method === "GET") {
        const registry = await registryPromise;
        const systems = await Promise.all(
          registry.systems().map(async (system) => {
            try {
              const health = await registry.get(system).health();
              return { system, ...health };
            } catch (error) {
              return { system, status: "down", detail: describeError(error).message };
            }
          }),
        );
        return json(res, 200, { panel: "ok", systems });
      }

      if (path.startsWith("/api/")) return await api(req, res, path, session);

      if (!["GET", "HEAD"].includes(req.method))
        return json(res, 404, { error: { message: "not found", type: "invalid_request_error" } });
      return serveStatic(req, res, webRoot, path);
    } catch (error) {
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (error instanceof AdapterError) {
        const { status, body } = errorResponse(
          new InputError(error.message, error.status || 502, { code: error.code }),
        );
        return json(res, status, { error: body });
      }
      if (!(error instanceof InputError) && !error?.status)
        logger.error?.(`[panel] request failed: ${error?.name}: ${error?.message}`);
      const { status, body } = errorResponse(error);
      return json(res, status, { error: body });
    }
  });
  server.requestTimeout = 30000;
  server.headersTimeout = 15000;
  server.keepAliveTimeout = 65000;

  return {
    server,
    store,
    registry: registryPromise,
    sessions,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

// Tokens are never echoed back: the console only needs to know whether one is
// configured (sh-settings-1).
function panelSettings(store, systems, registry) {
  const urls = store.serviceUrls();
  return {
    serviceUrls: urls,
    systems: systems.map((config) => ({
      system: config.system,
      // A saved override wins; otherwise the configured (env/Compose) URL is shown.
      url: store.state.serviceUrls[config.system] || config.baseUrl,
      tokenConfigured: Boolean(config.token),
      stub: registry.isStub(config.system),
    })),
    ssoCallbackUrl: store.state.sso.callbackUrl || "",
  };
}

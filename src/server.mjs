import { resolve } from "node:path";
import { createPanelServer } from "./app.mjs";

const flag = (name, value) => {
  if (value === undefined || value === "") return undefined;
  const normalized = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "on"].includes(normalized)) return true;
  if (["false", "0", "no", "off"].includes(normalized)) return false;
  throw new Error(`${name} must be true or false`);
};

const list = (value) =>
  value === undefined || value === ""
    ? undefined
    : String(value)
        .split(/[\s,]+/)
        .map((entry) => entry.trim())
        .filter(Boolean);

const origin = (value) => (value || "").replace(/\/+$/, "");

// The first defined, non-empty value wins; legacy names stay accepted.
const firstSet = (...values) => {
  for (const value of values) if (typeof value === "string" && value) return value;
  return undefined;
};

// Compose service names are reachable by DNS; the host-published ports stay
// available for direct model calls.
const SERVICES = [
  { system: "cnb", urlEnv: "CNB_URL", keyEnv: "CNB_ADMIN_KEY", legacyEnv: "CNB_PLATFORM_TOKEN", fallback: "http://127.0.0.1:9002" },
  {
    system: "codebuddy",
    urlEnv: "CODEBUDDY_URL",
    keyEnv: "CODEBUDDY_ADMIN_KEY",
    legacyEnv: "CODEBUDDY_PLATFORM_TOKEN",
    fallback: "http://127.0.0.1:8787",
  },
  {
    system: "zcode",
    urlEnv: "ZCODE_URL",
    keyEnv: "ZCODE_ADMIN_KEY",
    legacyEnv: "ZCODE_PLATFORM_TOKEN",
    fallback: "http://127.0.0.1:12283",
  },
];

// One key opens all four consoles, so a service credential defaults to the
// panel's own key. A deployment with distinct keys overrides one service at a
// time. A pre-0.2 `*_PLATFORM_TOKEN` also beats the shared default: the panel
// key is always set, and a service image that predates the shared key accepts
// only that token.
function servicesFromEnv(env, panelKey) {
  return SERVICES.map(({ system, urlEnv, keyEnv, legacyEnv, fallback }) => ({
    system,
    baseUrl: origin(env[urlEnv]) || fallback,
    token: firstSet(env[keyEnv], env[legacyEnv], panelKey) || "",
  }));
}

// Environment variables seed an unconfigured panel only. Once SSO settings are
// saved in panel.json, the saved configuration wins.
function ssoBootstrapFromEnv(env) {
  const bootstrap = {
    enabled: flag("PLATFORM_SSO_ENABLED", env.PLATFORM_SSO_ENABLED),
    keyLoginEnabled: flag("PLATFORM_KEY_LOGIN_ENABLED", env.PLATFORM_KEY_LOGIN_ENABLED),
    issuer: env.PLATFORM_OIDC_ISSUER,
    clientId: env.PLATFORM_OIDC_CLIENT_ID,
    clientSecret: env.PLATFORM_OIDC_CLIENT_SECRET,
    scope: env.PLATFORM_OIDC_SCOPES,
    providerName: env.PLATFORM_OIDC_PROVIDER_NAME,
    allowedSubjects: list(env.PLATFORM_OIDC_ALLOWED_SUBJECTS),
    allowedEmails: list(env.PLATFORM_OIDC_ALLOWED_EMAILS),
  };
  const provided = Object.fromEntries(Object.entries(bootstrap).filter(([, value]) => value !== undefined));
  return Object.keys(provided).length ? provided : null;
}

export function configFromEnv(env = process.env) {
  const port = Number(env.PLATFORM_PORT || 9000);
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("PLATFORM_PORT must be a valid port");
  const adminKey = firstSet(env.PANEL_ADMIN_KEY, env.PLATFORM_ADMIN_KEY);
  return {
    port,
    host: env.PLATFORM_HOST || "0.0.0.0",
    adminKey,
    dataDir: resolve(env.PLATFORM_DATA_DIR || "data/panel"),
    publicUrl: origin(firstSet(env.PANEL_PUBLIC_URL, env.PLATFORM_PUBLIC_URL) || ""),
    allowLocal: flag("PLATFORM_ALLOW_LOCAL_UPSTREAM", env.PLATFORM_ALLOW_LOCAL_UPSTREAM) === true,
    ssoBootstrap: ssoBootstrapFromEnv(env),
    systems: servicesFromEnv(env, adminKey),
  };
}

const isEntry = () => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return import.meta.url === new URL(`file://${resolve(entry).replace(/\\/g, "/")}`).href;
  } catch {
    return false;
  }
};

if (isEntry()) {
  try {
    const config = configFromEnv();
    const { port, host, ...panelOptions } = config;
    const panel = createPanelServer(panelOptions);
    panel.server.listen(port, host, () => {
      console.log(`[panel] http://${host}:${port}`);
      for (const service of config.systems)
        console.log(`[panel] ${service.system} -> ${service.baseUrl}${service.token ? "" : " (no key)"}`);
    });
    for (const signal of ["SIGINT", "SIGTERM"])
      process.on(signal, () => {
        panel.server.close(() => process.exit(0));
        setTimeout(() => process.exit(0), 5000).unref();
      });
  } catch (error) {
    console.error(`[panel] ${error.message}`);
    process.exit(1);
  }
}

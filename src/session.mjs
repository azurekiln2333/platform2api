import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { cookieValue, InputError } from "./http.mjs";

export const SESSION_MS = 12 * 60 * 60 * 1000;
const MAX_SESSIONS = 100;
const LOGIN_WINDOW_MS = 600000;
const MAX_LOGIN_FAILURES = 10;

const digest = (value) => createHash("sha256").update(String(value)).digest();

// Constant-time comparison that never short-circuits on length.
export const equals = (a, b) =>
  typeof a === "string" && typeof b === "string" && Boolean(a && b) && timingSafeEqual(digest(a), digest(b));

// Opaque server-side sessions in a process-local map, exactly like
// cnb2api-panel: no JWT, no roles, one admin identity.
export function createSessionManager({ cookieName = "platform_session", isSecure }) {
  const sessions = new Map();
  const failures = new Map();

  const prune = () => {
    const now = Date.now();
    for (const [token, entry] of sessions) if (entry.expiresAt <= now) sessions.delete(token);
  };

  return {
    cookieName,
    cookie(req, token, ageSeconds) {
      const secure = isSecure(req) ? "; Secure" : "";
      return `${cookieName}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${ageSeconds}${secure}`;
    },
    get(req) {
      const token = cookieValue(req, cookieName);
      if (!token) return null;
      const entry = sessions.get(token);
      if (!entry || entry.expiresAt < Date.now()) {
        if (entry) sessions.delete(token);
        return null;
      }
      return { token, user: entry.user, subject: entry.subject, ssoFingerprint: entry.ssoFingerprint };
    },
    create(entry) {
      const token = randomBytes(32).toString("hex");
      if (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
      sessions.set(token, { ...entry, expiresAt: Date.now() + SESSION_MS });
      return token;
    },
    destroy(token) {
      sessions.delete(token);
    },
    size() {
      prune();
      return sessions.size;
    },
    // Ten failures per address inside ten minutes, then a hard 429.
    loginAllowed(ip) {
      const now = Date.now();
      for (const [address, entry] of failures) if (now - entry.at > LOGIN_WINDOW_MS) failures.delete(address);
      return (failures.get(ip)?.count || 0) < MAX_LOGIN_FAILURES;
    },
    recordFailure(ip) {
      const now = Date.now();
      const entry = failures.get(ip);
      failures.set(ip, { count: (entry?.count || 0) + 1, at: entry?.at || now });
    },
    clearFailures(ip) {
      failures.delete(ip);
    },
  };
}

// Mutating /api requests must come from the panel itself when Origin is sent.
export function createOriginGuard({ publicUrl = "" } = {}) {
  return (req) => {
    if (!req.headers.origin) return true;
    try {
      const origin = new URL(req.headers.origin);
      if (publicUrl && origin.origin === new URL(publicUrl).origin) return true;
      return origin.host === req.headers.host;
    } catch {
      return false;
    }
  };
}

export const assertOrigin = (validOrigin, req) => {
  if (!["GET", "HEAD", "OPTIONS"].includes(req.method) && !validOrigin(req))
    throw new InputError("请求来源不匹配", 403);
};

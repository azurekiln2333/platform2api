import { AdapterError } from "./adapters/index.mjs";

// Per-system overview. Top level is `{ cnb, codebuddy, zcode }` (design.md):
// each key holds that system's own flat payload. Values and units are never
// summed or blended across systems (R10); a failing system yields `error` for
// its own key only (sh-overview-2).

export const HEALTH_VALUES = Object.freeze(["ok", "degraded", "down", "unknown"]);

const HEALTH_TOKENS = {
  ok: "ok",
  healthy: "ok",
  up: "ok",
  ready: "ok",
  degraded: "degraded",
  warning: "degraded",
  partial: "degraded",
  down: "down",
  offline: "down",
  error: "down",
  unavailable: "down",
  unknown: "unknown",
};

// Health is a plain string so the console can render it directly. Adapters may
// return `{ status, detail }` (contract) or an already-normalized string.
export function normalizeHealth(value) {
  if (typeof value === "string") return HEALTH_TOKENS[value.trim().toLowerCase()] || "unknown";
  const status = value && typeof value === "object" ? value.status : undefined;
  if (typeof status === "string") return HEALTH_TOKENS[status.trim().toLowerCase()] || "unknown";
  return "unknown";
}

export const describeError = (error) => {
  if (error instanceof AdapterError || error?.name === "AdapterError")
    return {
      message: error.message,
      code: error.code || "upstream_error",
      ...(error.status ? { status: error.status } : {}),
    };
  if (error?.name === "InputError")
    return { message: error.message, code: error.code || "invalid_request" };
  return { message: "服务读取失败", code: "internal_error" };
};

// A polled overview must not wait on one slow channel (ui-fixes.md §3). Each
// channel read gets its own deadline; the timeout is an ordinary AdapterError so
// the channel shows a retryable reason instead of stalling the whole page.
export function deadline(promise, ms, what = "渠道") {
  if (!Number.isFinite(ms) || ms <= 0) return promise;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new AdapterError(`${what}响应超时`, { code: "upstream_timeout" })),
      ms,
    );
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

export async function systemOverview(adapter, { timeoutMs = 0 } = {}) {
  let health = "unknown";
  let detail = "";
  try {
    const probe = await deadline(adapter.health(), timeoutMs, `${adapter.system} 服务`);
    health = normalizeHealth(probe);
    detail = typeof probe?.detail === "string" ? probe.detail : "";
  } catch (error) {
    health = "down";
    detail = describeError(error).message;
  }

  try {
    const payload = await deadline(adapter.overview(), timeoutMs, `${adapter.system} 服务`);
    // Flat payload: adapter fields (accounts/quota/usage/generatedAt/...) stay
    // top-level, never nested under an `overview` key (design.md).
    const available = payload && typeof payload === "object" ? payload : {};
    return {
      system: adapter.system,
      ok: true,
      ...available,
      health,
      detail,
      // The console reads healthMessage; detail is the design.md field name.
      healthMessage: available.healthMessage || detail,
    };
  } catch (error) {
    if (!(error instanceof AdapterError) && error?.name !== "InputError" && !error?.status)
      throw error;
    return {
      system: adapter.system,
      ok: false,
      health,
      detail,
      healthMessage: detail,
      error: describeError(error),
    };
  }
}

export async function buildOverview(registry, { timeoutMs = 0 } = {}) {
  const systems = registry.systems();
  // Systems are independent: a slow or broken service must not hide the others.
  const sections = await Promise.all(
    systems.map((system) =>
      systemOverview(registry.get(system), { timeoutMs }).catch((error) => {
        const described = describeError(error);
        return {
          system,
          ok: false,
          health: "unknown",
          detail: described.message,
          healthMessage: described.message,
          error: described,
        };
      }),
    ),
  );
  const result = { generatedAt: new Date().toISOString() };
  for (const section of sections) result[section.system] = section;
  return result;
}

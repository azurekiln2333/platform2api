/**
 * CodeBuddy (codebuddy2api) management adapter.
 *
 * Talks to the service's existing `/admin/*` API through the env-gated
 * `PLATFORM_TOKEN` credential (see branch `platform-token` in the codebuddy2api
 * repository). The panel never forwards model traffic and never touches the
 * service's SQLite directory.
 *
 * Contract: ./README.md. Everything goes through `context.client`, which owns
 * bearer auth, timeouts and the response size cap.
 *
 * Service facts taken from research/codebuddy-management.md:
 * - list endpoints use envelopes (`{ credentials }`, `{ external, items }`);
 * - `PATCH /admin/settings` is revision-aware and answers 409 on a stale
 *   `revision`, which stays a conflict and is never retried blindly;
 * - an unavailable audit store answers 503 and must not render as zero usage;
 * - logs use cursor pagination with a 1..200 limit window;
 * - enrollment (`/admin/oauth/*`) is a separate flow from console login.
 */
import { AdapterError } from "./client.mjs";
import { InputError } from "../http.mjs";

const CREDENTIAL_TOGGLES = [
  "enabled",
  "auto_checkin",
  "auto_travel",
  "auto_daily_chat",
  "auto_growth",
  "growth_auto",
];
const LOG_KINDS = ["request", "runtime", "admin", "credit"];
const DASHBOARD_DAYS = [1, 7, 30, 90];
const GRANULARITIES = ["auto", "hour", "day"];
const LOG_LIMIT = { min: 1, max: 200, default: 50 };

/** Stable, URL-safe credential id: the service keys credentials by file name. */
const nativeIdOf = (record) => {
  const raw = String(record?.name ?? record?.id ?? record?.file ?? "");
  return raw.replace(/[^A-Za-z0-9._:-]/g, "_").slice(0, 200);
};

const statusOf = (record) => {
  if (record?.disabled === true || record?.enabled === false) return "disabled";
  if (record?.cooldown_until || record?.cooldown) return "cooldown";
  if (record?.error || record?.invalid === true) return "error";
  return "ready";
};

const unwrapList = (body, key) => {
  if (Array.isArray(body)) return body;
  if (body && Array.isArray(body[key])) return body[key];
  return [];
};

/** Map a non-2xx service answer onto the adapter's error vocabulary. */
const failure = (response, what) => {
  const detail =
    typeof response.body === "string" && response.body.trim()
      ? response.body.trim().slice(0, 300)
      : response.body && typeof response.body === "object"
        ? String(response.body.detail ?? response.body.error ?? response.body.message ?? "").slice(0, 300)
        : "";
  const status = response.status;
  return new AdapterError(`${what}失败：CodeBuddy 返回 ${status}${detail ? `（${detail}）` : ""}`, {
    // 409 must reach the browser unchanged so the console can show a conflict.
    status: status === 409 ? 409 : 502,
    code:
      status === 409
        ? "revision_conflict"
        : status === 503
          ? "upstream_unavailable"
          : status === 401 || status === 403
            ? "service_auth_failed"
            : "upstream_error",
  });
};

const ensureOk = (response, what) => {
  if (!response.ok) throw failure(response, what);
  return response.body;
};

export default function createAdapter(context) {
  const { system = "codebuddy", client } = context || {};
  if (!client) throw new Error("codebuddy adapter requires the shared service client");

  const request = (path, options) => client.request(path, options);

  return {
    system,

    /** Never throws for an expected outage: the console renders the state. */
    async health() {
      try {
        const response = await request("/admin/session");
        if (!response.ok)
          return {
            status: response.status === 401 || response.status === 403 ? "down" : "degraded",
            detail:
              response.status === 401 || response.status === 403
                ? "服务拒绝了 PLATFORM_TOKEN，请检查面板与服务的令牌是否一致"
                : `CodeBuddy 返回 ${response.status}`,
          };
        return { status: "ok" };
      } catch (error) {
        return { status: "down", detail: error?.message || "无法连接 CodeBuddy" };
      }
    },

    /**
     * Native dashboard metadata for this system only. A 503 stays a thrown
     * AdapterError so the panel marks usage unavailable instead of zero.
     */
    async overview(params = {}) {
      const days = DASHBOARD_DAYS.includes(Number(params.days)) ? Number(params.days) : 7;
      const granularity = GRANULARITIES.includes(params.granularity) ? params.granularity : "auto";
      const response = await request("/admin/dashboard", {
        query: { days, granularity },
      });
      const body = ensureOk(response, "读取 CodeBuddy 概览");
      const totals = body?.totals ?? body?.summary ?? {};
      return {
        system,
        days,
        // Keep the service's own units; the panel never converts or merges them.
        requests: totals.requests ?? totals.request_count ?? null,
        credits: totals.credits ?? null,
        health: body?.health ?? null,
        storage: body?.storage ?? null,
        granularity: body?.granularity ?? granularity,
        raw: body,
      };
    },

    async listAccounts() {
      const response = await request("/admin/credentials");
      const body = ensureOk(response, "读取 CodeBuddy 凭证");
      return unwrapList(body, "credentials").map((record) => {
        const nativeId = nativeIdOf(record);
        return {
          nativeId,
          label: String(record?.nickname || record?.label || nativeId),
          status: statusOf(record),
          enabled: record?.enabled !== false && record?.disabled !== true,
          quota: record?.quota ?? record?.credits ?? null,
          // Provider tags only; accounts.mjs prepends the system tag itself.
          tags: Array.isArray(record?.tags) ? record.tags.map(String).slice(0, 20) : [],
          raw: record,
        };
      });
    },

    /**
     * `update` sends exactly one allowed boolean field, because the service
     * rejects wider credential patches; `delete` removes the credential file.
     */
    async accountAction(nativeId, action, payload = {}) {
      const id = String(nativeId || "");
      if (!id) throw new InputError("缺少凭证标识", 400);
      const path = `/admin/credentials/${encodeURIComponent(id)}`;

      if (action === "delete") {
        ensureOk(await request(path, { method: "DELETE" }), "删除 CodeBuddy 凭证");
        return { ok: true };
      }
      if (action !== "update")
        throw new InputError(`不支持的 CodeBuddy 账号操作：${action}`, 400);

      const fields = Object.keys(payload || {});
      if (fields.length !== 1 || !CREDENTIAL_TOGGLES.includes(fields[0]))
        throw new InputError(
          `凭证更新一次只能提交一个受支持字段（${CREDENTIAL_TOGGLES.join("、")}）`,
          400,
        );
      const response = await request(path, { method: "PATCH", body: payload });
      return ensureOk(response, "更新 CodeBuddy 凭证") ?? { ok: true };
    },

    /** Enrollment is independent of console login: start an upstream OAuth flow. */
    async startAuth(payload = {}) {
      const site = payload?.site === "intl" ? "intl" : "cn";
      const response = await request("/admin/oauth/start", { method: "POST", query: { site } });
      const body = ensureOk(response, "发起 CodeBuddy 授权");
      return {
        flowId: String(body?.login_id ?? ""),
        verificationUri: body?.verification_uri ?? body?.url ?? null,
        site,
        raw: body,
      };
    },

    async pollAuth(flowId) {
      const id = String(flowId || "");
      if (!id) throw new InputError("缺少 login_id", 400);
      const response = await request("/admin/oauth/poll", { query: { login_id: id } });
      const body = ensureOk(response, "轮询 CodeBuddy 授权");
      if (body?.error) return { status: "error", detail: String(body.error), raw: body };
      if (!body?.done) return { status: "pending", raw: body };
      return {
        status: "done",
        uid: body?.uid ?? null,
        nickname: body?.nickname ?? "",
        imported: body?.imported ?? null,
        raw: body,
      };
    },

    /**
     * Raw management passthrough for `/api/p/codebuddy/<path>`. The service's
     * own status is preserved (409 stays 409) so no route is silently altered.
     */
    async call(path, opts = {}) {
      const response = await request(path, {
        method: opts.method || "GET",
        query: opts.query,
        body: opts.body,
        headers: opts.headers,
      });
      return {
        status: response.status,
        body: response.body,
        contentType: response.contentType,
        headers: response.headers,
      };
    },

    // ── Provider-specific helpers used by the CodeBuddy pages ──────────────
    // These stay on the adapter (not the router) so the console has one place
    // per system for envelopes and revision rules.

    async listKeys() {
      const body = ensureOk(await request("/admin/keys"), "读取 CodeBuddy 密钥");
      return { external: Boolean(body?.external), items: unwrapList(body, "items") };
    },

    async listModels() {
      const body = ensureOk(await request("/admin/models"), "读取 CodeBuddy 模型");
      return {
        revision: body?.revision ?? null,
        models: unwrapList(body, "models").slice(0, 5000),
        raw: body,
      };
    },

    async getSettings() {
      const body = ensureOk(await request("/admin/settings"), "读取 CodeBuddy 设置");
      return {
        revision: body?.revision ?? null,
        items: Array.isArray(body?.items) ? body.items : [],
        audit: body?.audit ?? null,
        session: body?.session ?? null,
      };
    },

    /** Revision-aware write: a stale revision surfaces as a 409 conflict. */
    async patchSettings(values, revision) {
      const body = { values: values && typeof values === "object" ? values : {} };
      if (revision !== undefined && revision !== null) body.revision = revision;
      const response = await request("/admin/settings", { method: "PATCH", body });
      const saved = ensureOk(response, "保存 CodeBuddy 设置");
      return {
        revision: saved?.revision ?? null,
        applied: saved?.applied ?? null,
        settings: saved?.items ?? saved?.settings ?? null,
      };
    },

    async listLogs({ kind = "request", limit = LOG_LIMIT.default, cursor } = {}) {
      const query = {
        kind: LOG_KINDS.includes(kind) ? kind : "request",
        limit: Math.min(LOG_LIMIT.max, Math.max(LOG_LIMIT.min, Number(limit) || LOG_LIMIT.default)),
      };
      if (cursor) query.cursor = String(cursor);
      const body = ensureOk(await request("/admin/logs", { query }), "读取 CodeBuddy 日志");
      return {
        items: unwrapList(body, "items"),
        nextCursor: body?.next_cursor ?? body?.cursor ?? null,
      };
    },
  };
}

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
// `resolve_settings` rejects anything else; the service's own error message
// names the four accepted endpoint profiles.
const PROFILE_DOMAINS = ["cn-cli", "cn-work", "intl-cli", "intl-work"];
const MAX_UPLOAD_FILES = 100;
const MAX_REFRESH_TOKENS = 50;

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

    /** `GET /admin/logs/{id}`; 503 when the audit store cannot answer. */
    async getLog(id) {
      const key = String(id || "");
      if (!key) throw new InputError("缺少日志标识", 400);
      const body = ensureOk(
        await request(`/admin/logs/${encodeURIComponent(key)}`),
        "读取 CodeBuddy 日志明细",
      );
      return body ?? null;
    },

    /**
     * Batch credential import. The service takes JSON (`files: [{name, content}]`),
     * not multipart, so the browser can post it through the ordinary proxy.
     */
    async uploadCredentials({ files, replace = false } = {}) {
      if (!Array.isArray(files) || files.length < 1 || files.length > MAX_UPLOAD_FILES)
        throw new InputError(`凭证上传需包含 1 至 ${MAX_UPLOAD_FILES} 个文件`, 400);
      for (const file of files) {
        if (!file || typeof file.name !== "string" || typeof file.content !== "string")
          throw new InputError("每个凭证文件必须包含 name 和 UTF-8 content", 400);
      }
      if (typeof replace !== "boolean") throw new InputError("replace 必须为布尔值", 400);
      const body = ensureOk(
        await request("/admin/credentials/upload", { method: "POST", body: { files, replace } }),
        "上传 CodeBuddy 凭证",
      );
      return { results: unwrapList(body, "results") };
    },

    /** `POST /admin/credentials/refresh-import`: exchange refresh tokens for credentials. */
    async refreshImport({ profile, refreshTokens } = {}) {
      if (!PROFILE_DOMAINS.includes(profile))
        throw new InputError(`端点必须为 ${PROFILE_DOMAINS.join("、")}`, 400);
      const tokens = Array.isArray(refreshTokens)
        ? [...new Set(refreshTokens.map((token) => (typeof token === "string" ? token.trim() : "")).filter(Boolean))]
        : [];
      if (!tokens.length || tokens.length > MAX_REFRESH_TOKENS)
        throw new InputError(`refreshTokens 需包含 1 至 ${MAX_REFRESH_TOKENS} 项`, 400);
      const body = ensureOk(
        await request("/admin/credentials/refresh-import", {
          method: "POST",
          body: { profile, refresh_tokens: tokens },
        }),
        "导入 CodeBuddy 刷新令牌",
      );
      return { results: unwrapList(body, "results") };
    },

    /** Model catalog mutations are revision-aware, exactly like settings. */
    async createModel(rule, revision) {
      const body = { ...(rule && typeof rule === "object" ? rule : {}) };
      if (revision !== undefined && revision !== null) body.revision = revision;
      const saved = ensureOk(
        await request("/admin/models", { method: "POST", body }),
        "新建 CodeBuddy 模型",
      );
      return { revision: saved?.revision ?? null, model: saved?.model ?? null };
    },

    async updateModel(id, rule, revision) {
      const key = String(id || "");
      if (!key) throw new InputError("缺少模型标识", 400);
      const body = { ...(rule && typeof rule === "object" ? rule : {}) };
      if (revision !== undefined && revision !== null) body.revision = revision;
      const saved = ensureOk(
        await request(`/admin/models/${key}`, { method: "PUT", body }),
        "更新 CodeBuddy 模型",
      );
      return { revision: saved?.revision ?? null, model: saved?.model ?? null };
    },

    async deleteModel(id, revision) {
      const key = String(id || "");
      if (!key) throw new InputError("缺少模型标识", 400);
      const query =
        revision === undefined || revision === null ? undefined : { revision: String(revision) };
      ensureOk(await request(`/admin/models/${key}`, { method: "DELETE", query }), "删除 CodeBuddy 模型");
      return { ok: true };
    },

    async previewModel(id, rule) {
      const body = { ...(rule && typeof rule === "object" ? rule : {}) };
      const key = String(id || "");
      const path = key ? `/admin/models/${key}/preview` : "/admin/models/preview";
      return ensureOk(await request(path, { method: "POST", body }), "预览 CodeBuddy 模型");
    },

    /** One user-triggered catalog scan; the service never runs it periodically. */
    async startScan() {
      return ensureOk(await request("/admin/models/scan", { method: "POST" }), "启动 CodeBuddy 目录扫描");
    },

    async scanState() {
      return ensureOk(await request("/admin/models/scan"), "读取 CodeBuddy 扫描状态");
    },

    /** Spends a little credit when a nominally free model is actually charged. */
    async startRateProbe() {
      return ensureOk(
        await request("/admin/models/rate-probe", { method: "POST" }),
        "启动 CodeBuddy 计费探测",
      );
    },

    async rateProbeState() {
      return ensureOk(await request("/admin/models/rate-probe"), "读取 CodeBuddy 计费探测状态");
    },

    async outputProbes() {
      return ensureOk(await request("/admin/models/output-probes"), "读取 CodeBuddy 输出探测结果");
    },

    async createKey(payload = {}) {
      const body = ensureOk(
        await request("/admin/keys", { method: "POST", body: payload }),
        "新建 CodeBuddy 密钥",
      );
      return { key: body?.key ?? null, item: body?.item ?? body ?? null };
    },

    /** Key rewrites carry `version`, the service's own optimistic-lock token. */
    async updateKey(id, payload = {}) {
      const key = String(id || "");
      if (!key) throw new InputError("缺少密钥标识", 400);
      const body = ensureOk(
        await request(`/admin/keys/${encodeURIComponent(key)}`, { method: "PATCH", body: payload }),
        "更新 CodeBuddy 密钥",
      );
      return { item: body?.item ?? body ?? null };
    },

    async deleteKey(id) {
      const key = String(id || "");
      if (!key) throw new InputError("缺少密钥标识", 400);
      ensureOk(await request(`/admin/keys/${encodeURIComponent(key)}`, { method: "DELETE" }), "删除 CodeBuddy 密钥");
      return { ok: true };
    },

    /** Reveal and rotate both invalidate/return secrets; the console confirms first. */
    async revealKey(id) {
      const key = String(id || "");
      if (!key) throw new InputError("缺少密钥标识", 400);
      const body = ensureOk(
        await request(`/admin/keys/${encodeURIComponent(key)}/reveal`, { method: "POST" }),
        "读取 CodeBuddy 密钥明文",
      );
      return { key: body?.key ?? body?.secret ?? null };
    },

    async rotateKey(id) {
      const key = String(id || "");
      if (!key) throw new InputError("缺少密钥标识", 400);
      const body = ensureOk(
        await request(`/admin/keys/${encodeURIComponent(key)}/rotate`, { method: "POST" }),
        "轮换 CodeBuddy 密钥",
      );
      return { key: body?.key ?? null, item: body?.item ?? body ?? null };
    },

    // ── Provider-specific operations (media / storage / update / automation) ──

    async getMedia() {
      return ensureOk(await request("/admin/media"), "读取 CodeBuddy 媒体概览");
    },

    async getStorage() {
      return ensureOk(await request("/admin/storage"), "读取 CodeBuddy 存储状态");
    },

    async archiveStorage() {
      return ensureOk(
        await request("/admin/storage/archive", { method: "POST" }),
        "归档 CodeBuddy 审计存储",
      );
    },

    async createBackup() {
      return ensureOk(
        await request("/admin/storage/backups", { method: "POST" }),
        "创建 CodeBuddy 备份",
      );
    },

    async deleteBackup(name) {
      const key = String(name || "");
      if (!key) throw new InputError("缺少备份名称", 400);
      ensureOk(
        await request(`/admin/storage/backups/${encodeURIComponent(key)}`, { method: "DELETE" }),
        "删除 CodeBuddy 备份",
      );
      return { ok: true };
    },

    async getUpdate() {
      return ensureOk(await request("/admin/update"), "读取 CodeBuddy 更新状态");
    },

    async checkUpdate() {
      return ensureOk(await request("/admin/update/check", { method: "POST" }), "检查 CodeBuddy 更新");
    },

    async getPerformance() {
      return ensureOk(await request("/admin/performance"), "读取 CodeBuddy 性能计数");
    },

    async getGrowthJobs() {
      const body = ensureOk(await request("/admin/growth-jobs"), "读取 CodeBuddy 成长任务");
      return { jobs: unwrapList(body, "jobs") };
    },
  };
}

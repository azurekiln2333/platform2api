import { AdapterError } from "./client.mjs";
import { InputError } from "../http.mjs";
import { createZcodeConsole } from "./zcode-console.mjs";
import { descriptor, redact } from "../console-data.mjs";
import { isAccountNativeId } from "../account-id.mjs";

// ZCode adapter: one service (`zcode2api` / zcgw-server.mjs) reached over its
// console API plus its root legacy routes. Contract: ./README.md.
//
// Shape notes that differ from CNB (research/zcode-management.md):
//   - There is no `GET /api/accounts`; the console list is `GET /api/overview`.
//   - `PATCH /api/accounts/:id` answers `{ ok, account: <label> }`, not the account.
//   - `POST /api/accounts/:id/selftest` is async (202 + jobId); the result is polled
//     at `GET /api/accounts/:id/selftest/:jobId`.
//   - Keys, security, stats and pool settings live on root routes
//     (`/keys`, `/keys/:id/{update,delete,reset}`, `/security`, `/stats`, `/pool/*`).
//   - Enrollment is an interactive onboard flow (`/api/onboard/start|poll|redeem`).

const SYSTEM = "zcode";
const FLOW_ID = /^[A-Za-z0-9._:~-]{1,300}$/;
const ACTION_TIMEOUT_MS = 120000;

const ACCOUNT_ACTIONS = new Map([
  ["update", { method: "PATCH", suffix: "" }],
  ["refresh", { method: "POST", suffix: "/refresh" }],
  ["selftest", { method: "POST", suffix: "/selftest" }],
  ["claim-start", { method: "POST", suffix: "/claim/start" }],
  ["claim", { method: "POST", suffix: "/claim" }],
]);

const upstreamMessage = (body, status) => {
  const error = body?.error;
  if (typeof error === "string" && error.trim()) return error.trim();
  if (typeof error?.message === "string" && error.message.trim()) return error.message.trim();
  if (typeof body?.message === "string" && body.message.trim()) return body.message.trim();
  return `${SYSTEM} 服务返回 HTTP ${status}`;
};

export const normalizeQuota = (account) => {
  const credits = account?.quota?.credits;
  if (!credits || !Number.isFinite(Number(credits.total))) return null;
  const total = Number(credits.total) || 0;
  const used = Number(credits.used) || 0;
  const freeze = Number(credits.freeze) || 0;
  const remaining = Math.max(0, total - used - freeze);
  return {
    unit: "credits",
    total,
    used,
    remaining,
    percent: total ? Math.round(((used + freeze) / total) * 1000) / 10 : null,
  };
};

/** ZCode identifies an account by `label`; `disabled` is the stored switch. */
export const accountLabel = (account) =>
  String(account?.label ?? account?.id ?? "");

export const accountState = (account) => {
  if (!account) return "unknown";
  if (account.enabled === false || account.disabled === true) return "disabled";
  if (account.cooldownUntil && Date.parse(account.cooldownUntil) > Date.now()) return "cooling";
  if (account.status === "healthy" || account.status === "ready") return "healthy";
  if (account.status === "unhealthy" || account.status === "offline") return "offline";
  if (account.lastErr) return "offline";
  return "pending";
};

const toEntry = (account) => {
  const label = accountLabel(account);
  const status = accountState(account);
  const detail = account?.email || account?.phone || account?.identity || "";
  return {
    nativeId: label,
    label: String(account?.name || detail || label).slice(0, 200),
    status,
    enabled: account?.enabled !== false && account?.disabled !== true,
    quota: normalizeQuota(account),
    tags: [SYSTEM],
    detail: detail || null,
    lastUsedAt: account?.checkedAt ?? null,
    primary: detail,
    display: [descriptor("realm", "区域", account?.group ?? account?.realm, "badge"), descriptor("identity", "身份", detail), descriptor("cooldownUntil", "冷却至", account?.cooldownUntil, "time"), descriptor("checkedAt", "最近探测", account?.checkedAt, "time"), descriptor("lastError", "最近错误", account?.lastError), descriptor("quotaSources", "额度明细", account?.quotaSources), descriptor("eligibility", "领取资格", account?.eligibility)],
    actions: [
      { id: "refresh", label: "刷新额度与资格", quick: true },
      { id: "probe", label: "探测", quick: true },
      { id: "claim-start", label: "准备领取" },
      { id: "claim", label: "领取 Coding Plan" },
    ],
    raw: redact(account ?? null),
  };
};

/** Native onboard status -> the console's AuthFlow vocabulary. */
const flowStatus = (value) => {
  if (value === "ready") return "success";
  if (value === "pending") return "pending";
  if (value === "error" || value === "failed") return "failed";
  return "pending";
};

export default function createZcodeAdapter(context = {}) {
  const { client, baseUrl, token = "" } = context;
  if (!client) throw new Error("zcode: adapter requires the shared service client");

  const service = async (path, options) => {
    const result = await client.request(path, options);
    if (!result.ok) {
      // 410 means the enrollment flow expired; that is a normal flow state, not
      // a transport failure, so it is surfaced as data by the auth methods below.
      throw new AdapterError(upstreamMessage(result.body, result.status), {
        status: result.status >= 500 ? 502 : result.status,
        code: result.status >= 500 ? "upstream_error" : "upstream_rejected",
      });
    }
    return result;
  };

  const serviceJson = async (path, options) => {
    const { body } = await service(path, options);
    if (!body || typeof body !== "object")
      throw new AdapterError(`${SYSTEM} 服务返回的数据格式不正确`, { code: "upstream_shape" });
    return body;
  };

  async function health() {
    try {
      const result = await client.request("/health", { timeoutMs: 5000 });
      if (!result.ok) return { status: "down", detail: `HTTP ${result.status}` };
      const body = result.body ?? {};
      const detail = [body.version ? `v${body.version}` : "", Number.isFinite(body.accounts) ? `${body.accounts} 个账号` : ""]
        .filter(Boolean)
        .join(" · ");
      return { status: body.ok === false ? "degraded" : "ok", detail };
    } catch (error) {
      return { status: "down", detail: error?.message || "服务不可达" };
    }
  }

  /** The console overview is the only account feed, so it also backs listAccounts. */
  const fetchOverview = () => serviceJson("/api/overview");

  async function overview() {
    const [data, probe] = await Promise.all([fetchOverview(), health()]);
    const accounts = Array.isArray(data.accounts) ? data.accounts : [];
    const stats = data.stats && typeof data.stats === "object" ? data.stats : {};
    const quotas = accounts.map(normalizeQuota).filter(Boolean);
    const totalCredits = quotas.reduce((sum, quota) => sum + quota.total, 0);
    const remainingCredits = quotas.reduce((sum, quota) => sum + quota.remaining, 0);
    const paused = accounts.filter((account) => accountState(account) === "quota").length;
    return {
      health: probe.status === "ok" ? "ok" : probe.status === "degraded" ? "degraded" : "offline",
      healthMessage: probe.detail || "",
      accounts: {
        total: Number.isFinite(stats.total) ? stats.total : accounts.length,
        ready: Number.isFinite(stats.ready)
          ? stats.ready
          : accounts.filter((account) => accountState(account) === "healthy").length,
        paused,
      },
      // ZCode credits only; the console shows them on the ZCode card (R10).
      quota: {
        label: "ZCode 套餐额度",
        unit: "credits",
        total: Number.isFinite(stats.totalCredits) ? stats.totalCredits : totalCredits || null,
        used: Math.max(0, totalCredits - remainingCredits),
        remaining: Number.isFinite(stats.remainingCredits) ? stats.remainingCredits : remainingCredits,
        syncedAt: accounts.find((account) => account?.quota?.syncedAt)?.quota?.syncedAt ?? null,
        metrics: [
          {
            label: "账号数",
            unit: "个",
            total: null,
            used: null,
            remaining: Number.isFinite(stats.quotaOrganizations) ? stats.quotaOrganizations : quotas.length,
          },
        ],
        note: quotas.length ? "" : "账号尚未同步额度",
      },
      usage: [
        { label: "今日请求", value: Number.isFinite(stats.requests) ? stats.requests : null },
        { label: "今日错误", value: Number.isFinite(stats.errors) ? stats.errors : null },
        { label: "成功率", value: Number.isFinite(stats.successRate) ? stats.successRate : null, unit: "%", digits: 1 },
        {
          label: "平均耗时",
          value: Number.isFinite(stats.averageDurationMs) ? stats.averageDurationMs : null,
          unit: "ms",
        },
        { label: "进行中", value: Number.isFinite(stats.activeRequests) ? stats.activeRequests : null },
      ],
      generatedAt: new Date().toISOString(),
      settings: data.settings ?? null,
      claimAutomation: data.claimAutomation ?? null,
      hourly: Array.isArray(data.hourly) ? data.hourly : [],
      stats,
      tokenUsage: stats.tokenUsage ?? null,
    };
  }

  async function listAccounts() {
    const data = await fetchOverview();
    if (!Array.isArray(data.accounts))
      throw new AdapterError("ZCode 账号列表格式不正确", { code: "upstream_shape" });
    return data.accounts.map(toEntry);
  }

  async function accountAction(nativeId, action, payload = {}) {
    const label = String(nativeId ?? "");
    if (!isAccountNativeId(label)) throw new InputError("账号 ID 格式不正确", 400, { param: "id" });
    let name = String(action || "").toLowerCase();
    if (name === "probe") name = "selftest";
    if (name === "enable" || name === "disable") { payload = { enabled: name === "enable" }; name = "update"; }
    if (name === "selftest-result") {
      const jobId = String(payload?.jobId ?? "").trim();
      if (!/^[A-Za-z0-9._:-]{1,200}$/.test(jobId))
        throw new InputError("探测任务 ID 格式不正确", 400, { param: "jobId" });
      const { body } = await service(
        `/api/accounts/${encodeURIComponent(label)}/selftest/${encodeURIComponent(jobId)}`,
        { timeoutMs: 30000 },
      );
      return body;
    }
    const spec = ACCOUNT_ACTIONS.get(name);
    if (!spec)
      throw new InputError(`不支持的 ZCode 账号操作：${action}`, 400, { code: "action_unsupported" });
    const { body } = await service(
      `/api/accounts/${encodeURIComponent(label)}${spec.suffix}`,
      {
        method: spec.method,
        body: spec.method === "POST" || payload !== undefined ? (payload ?? {}) : undefined,
        timeoutMs: ACTION_TIMEOUT_MS,
      },
    );
    return body;
  }

  /** Interactive provider-aware enrollment: the browser authorises, the panel polls. */
  async function startAuth(payload = {}) {
    const body = {};
    if (payload.provider) body.provider = payload.provider;
    if (payload.accountId) body.accountId = String(payload.accountId);
    const data = await serviceJson("/api/onboard/start", {
      method: "POST",
      body,
      timeoutMs: ACTION_TIMEOUT_MS,
    });
    if (!FLOW_ID.test(String(data.flowId ?? "")))
      throw new AdapterError("ZCode 未返回有效的授权流程 ID", { code: "upstream_shape" });
    const pollIntervalMs = Number.isFinite(data.pollIntervalSec)
      ? Math.max(1000, Number(data.pollIntervalSec) * 1000)
      : 5000;
    return {
      flowId: String(data.flowId),
      status: "pending",
      message: "在浏览器完成登录授权，然后回到面板等待状态变为成功。",
      url: data.authorizeUrl ?? undefined,
      steps: [
        { title: "打开授权链接", message: "使用要接入的 ZCode 账号登录。", url: data.authorizeUrl ?? undefined },
        { title: "等待面板确认", message: "授权完成后无需操作，面板会自动轮询结果。" },
      ],
      pollIntervalMs,
      provider: data.provider ?? null,
      expiresAt: data.expiresAt ?? null,
    };
  }

  async function pollAuth(flowId) {
    const id = String(flowId ?? "");
    if (!FLOW_ID.test(id)) throw new InputError("flowId 格式不正确", 400, { param: "flowId" });
    let data;
    try {
      data = await serviceJson(`/api/onboard/poll/${encodeURIComponent(id)}`);
    } catch (error) {
      if (error instanceof AdapterError && error.status === 410)
        return { flowId: id, status: "expired", error: "授权流程已过期，请重新发起登录" };
      throw error;
    }
    const status = flowStatus(data.status);
    return {
      flowId: id,
      status,
      accountId: typeof data.label === "string" ? data.label : null,
      message:
        status === "success"
          ? `账号「${data.label ?? ""}」已加入 ZCode 账号池。`
          : data.error || "等待上游完成授权…",
      claim: data.claim ?? null,
      pollIntervalMs: status === "pending" ? 5000 : undefined,
      ...(status === "failed" ? { error: data.error || "上游授权失败" } : {}),
    };
  }

  /** Completing a ZCode flow can redeem a pasted callback link. */
  async function completeAuth(flowId, payload = {}) {
    const id = String(flowId ?? "");
    if (!FLOW_ID.test(id)) throw new InputError("flowId 格式不正确", 400, { param: "flowId" });
    const values = payload?.values && typeof payload.values === "object" ? payload.values : payload;
    const body = { flowId: id };
    for (const field of ["url", "code", "state"]) {
      const value = values?.[field];
      if (typeof value === "string" && value.trim()) body[field] = value.trim();
    }
    let data;
    try {
      data = await serviceJson("/api/onboard/redeem", {
        method: "POST",
        body,
        timeoutMs: ACTION_TIMEOUT_MS,
      });
    } catch (error) {
      if (error instanceof AdapterError && error.status === 410)
        return { flowId: id, status: "expired", error: "授权流程已过期，请重新发起登录" };
      throw error;
    }
    const status = flowStatus(data.status);
    return {
      flowId: id,
      status,
      accountId: typeof data.label === "string" ? data.label : null,
      message: status === "success" ? "授权已完成。" : data.error || "上游仍在处理授权",
      claim: data.claim ?? null,
      ...(status === "failed" ? { error: data.error || "兑付失败" } : {}),
    };
  }

  /**
   * Raw passthrough for `/api/p/zcode/*` (R8/AC8): console routes as-is plus the
   * root legacy routes (`/keys`, `/stats`, `/quota`, `/security`, `/pool/*`).
   */
  async function call(path, options = {}) {
    const result = await client.request(path, options);
    if (result.contentType && !/^(text\/|application\/(json|xml)|application\/[\w.+-]+\+json)/i.test(result.contentType))
      return { ...result, body: result.buffer };
    return result;
  }

  const consoleApi = createZcodeConsole(client);
  return {
    system: SYSTEM,
    baseUrl,
    tokenConfigured: Boolean(token),
    health,
    overview,
    listAccounts,
    accountAction,
    startAuth,
    pollAuth,
    completeAuth,
    call,
    console: consoleApi,
    keyManagement: { list: "/keys", items: "keys", prefix: "/keys/" },
    inference: () => ({ url: baseUrl, routes: ["/v1/chat/completions", "/v1/messages", "/chat/completions", "/messages"] }),
    async ensureUpstreamCredential() {
      const created = await consoleApi.createKey({ name: "platform2api 统一入口" });
      return { secret: created.secret, id: created.item.nativeId, name: created.item.name };
    },
  };
}

export { ACCOUNT_ACTIONS, toEntry, upstreamMessage, flowStatus };

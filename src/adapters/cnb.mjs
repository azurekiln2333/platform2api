import { randomUUID } from "node:crypto";
import { AdapterError } from "./client.mjs";
import { InputError } from "../http.mjs";
import { descriptor, redact } from "../console-data.mjs";
import { createCnbConsole } from "./cnb-console.mjs";

// CNB adapter: one service (`cnb2api-panel`) reached over its existing
// management routes. Contract: ./README.md. Every request carries
// `Authorization: Bearer <panel key>` through the shared client, so the
// service authorises panel-originated calls without a browser session
// (design.md "Management bearer"). CNB accepts a missing Origin on mutating
// `/api/` calls and rejects a mismatched one, so nothing here sets Origin.

const SYSTEM = "cnb";
const ACCOUNT_ID = /^[A-Za-z0-9._:-]{1,200}$/;
const FLOW_TTL_MS = 20 * 60 * 1000;
const CREDENTIAL_INPUTS = Object.freeze([
  { name: "name", label: "账号名称", required: true, placeholder: "例如 CNB 主账号" },
  {
    name: "proxyKey",
    label: "工作区密钥",
    secret: true,
    required: true,
    placeholder: "填写工作区密钥",
  },
  { name: "pat", label: "CNB 个人令牌", secret: true, placeholder: "可选，用于探活与额度同步" },
  { name: "repo", label: "仓库路径", placeholder: "组织/仓库" },
]);

const ACCOUNT_ACTIONS = new Map([
  ["probe", { method: "POST", suffix: "/probe" }],
  ["inference-probe", { method: "POST", suffix: "/inference-probe" }],
  ["quota", { method: "POST", suffix: "/quota" }],
  ["wake", { method: "POST", suffix: "/wake" }],
  ["registration", { method: "POST", suffix: "/registration" }],
  ["pat", { method: "POST", suffix: "/pat" }],
  ["credentials", { method: "POST", suffix: "/credentials" }],
  ["update", { method: "PATCH" }],
  ["delete", { method: "DELETE" }],
]);

const upstreamMessage = (body, status) => {
  const error = body?.error;
  if (typeof error === "string" && error.trim()) return error.trim();
  if (typeof error?.message === "string" && error.message.trim()) return error.message.trim();
  if (typeof body?.message === "string" && body.message.trim()) return body.message.trim();
  return `${SYSTEM} 服务返回 HTTP ${status}`;
};

const requireId = (nativeId) => {
  const id = String(nativeId ?? "").trim();
  if (!ACCOUNT_ID.test(id)) throw new InputError("账号 ID 格式不正确", 400, { param: "id" });
  return id;
};

/** `total/used/freeze` credit shape shared by CNB and ZCode account payloads. */
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

/** Mirrors the source console's `accountState` (cnb2api-panel web/src/console.ts). */
export const accountState = (account) => {
  if (!account) return "unknown";
  if (account.enabled === false) return "disabled";
  if (account.quotaProtection?.suspended) return "quota";
  if (account.cooldownUntil && Date.parse(account.cooldownUntil) > Date.now()) return "cooling";
  if (account.status === "healthy" && account.endpoint) return "healthy";
  if (account.status === "unhealthy") return "offline";
  return "pending";
};

const toEntry = (account) => ({
  nativeId: String(account?.id ?? ""),
  label: String(account?.name ?? account?.id ?? "").slice(0, 200),
  status: accountState(account),
  enabled: account?.enabled !== false,
  quota: normalizeQuota(account),
  tags: [SYSTEM],
  lastUsedAt: account?.lastUsedAt ?? account?.lastRequestAt ?? null,
  primary: String(account?.repo || account?.endpoint || ""),
  display: [
    descriptor("repo", "仓库", account?.repo, "mono"),
    descriptor("endpoint", "工作区地址", redact(account?.endpoint), "mono"),
    descriptor("upstreamMode", "上游模式", account?.upstreamMode, "badge"),
    descriptor("priority", "优先级", account?.priority),
    descriptor("models", "模型", Array.isArray(account?.models) ? account.models.join("、") : null),
    descriptor("quota", "额度", normalizeQuota(account), "quota"),
    descriptor("quotaSyncedAt", "额度同步时间", account?.quota?.syncedAt, "time"),
    descriptor("lastProbeAt", "最近探活", account?.lastProbeAt, "time"),
    descriptor("lastError", "最近错误", redact(account?.lastError)),
    descriptor("cooldownUntil", "冷却截止", account?.cooldownUntil, "time"),
    descriptor("hasPat", "已保存个人令牌", account?.hasPat, "bool"),
    descriptor("hasProxyKey", "已保存工作区密钥", account?.hasProxyKey, "bool"),
  ],
  actions: [
    { id: "probe", label: "探测账号" }, { id: "inference-probe", label: "探测推理" },
    { id: "quota", label: "同步额度" }, { id: "wake", label: "启动工作区" },
    { id: account?.enabled === false ? "enable" : "disable", label: account?.enabled === false ? "启用账号" : "停用账号" },
    { id: "delete", label: "删除账号", danger: true, confirm: `删除账号「${account?.name || account?.id || ""}」` },
  ],
  raw: account ? redact(Object.fromEntries(Object.entries(account).filter(([key]) => !["secrets", "registrationToken", "credentials"].includes(key)))) : null,
});

export default function createCnbAdapter(context = {}) {
  const { client, baseUrl, token = "" } = context;
  if (!client) throw new Error("cnb: adapter requires the shared service client");
  const pending = new Map();

  const prune = () => {
    const now = Date.now();
    for (const [flowId, flow] of pending) if (flow.expiresAt <= now) pending.delete(flowId);
  };

  // Transport failures are already AdapterError (client.mjs); HTTP error status
  // still resolves, so it has to be converted here or a 404 would look like data.
  const service = async (path, options) => {
    const result = await client.request(path, options);
    if (!result.ok) {
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
      const status = result.body?.status;
      if (!result.ok) return { status: "down", detail: `HTTP ${result.status}` };
      if (status === "degraded")
        return { status: "degraded", detail: `就绪工作区 ${result.body?.ready ?? 0}` };
      return { status: "ok", detail: `就绪工作区 ${result.body?.ready ?? 0}` };
    } catch (error) {
      return { status: "down", detail: error?.message || "服务不可达" };
    }
  }

  async function overview() {
    const [data, probe] = await Promise.all([serviceJson("/api/overview"), health()]);
    const accounts = Array.isArray(data.accounts) ? data.accounts : [];
    const stats = data.stats && typeof data.stats === "object" ? data.stats : {};
    const quotas = accounts.map(normalizeQuota).filter(Boolean);
    const totalCredits = quotas.reduce((sum, quota) => sum + quota.total, 0);
    const remainingCredits = quotas.reduce((sum, quota) => sum + quota.remaining, 0);
    const used = Math.max(0, totalCredits - remainingCredits);
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
      // CNB credits only. The panel renders this on the CNB card; it never sums
      // credit quotas across systems (R10).
      quota: {
        label: "CNB 组织额度",
        unit: "credits",
        total: Number.isFinite(stats.remainingCredits) ? totalCredits : totalCredits || null,
        used,
        remaining: Number.isFinite(stats.remainingCredits) ? stats.remainingCredits : remainingCredits,
        syncedAt: quotas.length ? (accounts.find((a) => a.quota?.syncedAt)?.quota?.syncedAt ?? null) : null,
        metrics: [
          {
            label: "额度组织",
            unit: "个",
            total: null,
            used: null,
            remaining: Number.isFinite(stats.quotaOrganizations)
              ? stats.quotaOrganizations
              : quotas.length,
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
        {
          label: "进行中",
          value: Number.isFinite(stats.activeRequests) ? stats.activeRequests : null,
        },
      ],
      generatedAt: new Date().toISOString(),
      // Native fields the CNB pages render verbatim.
      settings: data.settings ?? null,
      stats,
      hourly: Array.isArray(data.hourly) ? data.hourly : [],
      creditRates: data.creditRates ?? null,
      tokenUsage: stats.tokenUsage ?? null,
    };
  }

  async function listAccounts() {
    const data = await serviceJson("/api/accounts");
    if (!Array.isArray(data.accounts))
      throw new AdapterError("CNB 账号列表格式不正确", { code: "upstream_shape" });
    return data.accounts.map(toEntry);
  }

  async function accountAction(nativeId, action, payload = {}) {
    const id = requireId(nativeId);
    const name = String(action || "").toLowerCase();
    if (["enable", "disable"].includes(name)) return accountAction(id, "update", { enabled: name === "enable" });
    const spec = ACCOUNT_ACTIONS.get(name);
    if (!spec)
      throw new InputError(`不支持的 CNB 账号操作：${action}`, 400, { code: "action_unsupported" });
    const { body } = await service(`/api/accounts/${encodeURIComponent(id)}${spec.suffix ?? ""}`, {
      method: spec.method,
      body: spec.method === "GET" || spec.method === "DELETE" ? undefined : payload ?? {},
      timeoutMs: 90000,
    });
    return body;
  }

  /**
   * CNB has no OAuth enrollment. "Authorization" means: create the account
   * record with its workspace credentials, then let a workspace register with
   * the account's registration token. The flow keeps step state here so the
   * console can collect the credentials, then poll until registration lands.
   */
  async function startAuth(payload = {}) {
    prune();
    const accountId = payload.accountId ? requireId(payload.accountId) : "";
    if (accountId) {
      const { registrationToken } = await serviceJson(
        `/api/accounts/${encodeURIComponent(accountId)}/registration`,
        { method: "POST", body: {}, timeoutMs: 30000 },
      );
      return beginRegistration(accountId, registrationToken);
    }
    const flowId = randomUUID();
    pending.set(flowId, { phase: "collect", expiresAt: Date.now() + FLOW_TTL_MS });
    return {
      flowId,
      status: "pending",
      message: "填写工作区凭据后，面板会在 CNB 里创建账号并返回注册密钥。",
      inputs: CREDENTIAL_INPUTS.map((input) => ({ ...input })),
      pollIntervalMs: 3000,
    };
  }

  function beginRegistration(accountId, registrationToken) {
    const flowId = randomUUID();
    pending.set(flowId, {
      phase: "register",
      accountId,
      registrationToken,
      expiresAt: Date.now() + FLOW_TTL_MS,
    });
    return {
      flowId,
      status: "pending",
      accountId,
      message: "把注册密钥写入工作区，工作区启动后会自动注册。",
      steps: [
        {
          title: "写入注册密钥",
          message: `在工作区环境中设置注册密钥：${registrationToken}`,
        },
        {
          title: "启动工作区",
          message: "工作区启动后会自动回连面板，此处的状态会变为成功。",
        },
      ],
      pollIntervalMs: 3000,
    };
  }

  async function pollAuth(flowId, payload = {}) {
    prune();
    const id = String(flowId ?? "");
    const flow = pending.get(id);
    if (!flow) return { flowId: id, status: "expired", error: "授权流程不存在或已过期，请重新发起" };
    if (flow.phase === "collect") {
      const values = payload?.values && typeof payload.values === "object" ? payload.values : payload;
      const name = String(values?.name ?? "").trim();
      const proxyKey = String(values?.proxyKey ?? "").trim();
      if (!name || !proxyKey)
        return {
          flowId: id,
          status: "pending",
          message: "请填写账号名称与工作区密钥。",
          inputs: CREDENTIAL_INPUTS.map((input) => ({ ...input })),
        };
      const created = await serviceJson("/api/accounts", {
        method: "POST",
        body: {
          name,
          proxyKey,
          ...(values?.pat ? { pat: String(values.pat) } : {}),
          ...(values?.repo ? { repo: String(values.repo) } : {}),
        },
        timeoutMs: 60000,
      });
      const accountId = created.account?.id;
      if (!accountId) throw new AdapterError("CNB 未返回新建账号 ID", { code: "upstream_shape" });
      pending.delete(id);
      const registration = beginRegistration(
        accountId,
        created.registrationToken || created.account?.secrets?.registrationToken || "",
      );
      return { ...registration, status: "pending", message: "账号已创建，继续完成工作区注册。" };
    }
    const data = await serviceJson(`/api/accounts/${encodeURIComponent(flow.accountId)}`);
    const account = data.account ?? null;
    if (!account) return { flowId: id, status: "failed", error: "账号已不存在" };
    const state = accountState(account);
    if (state === "healthy")
      return {
        flowId: id,
        status: "success",
        accountId: flow.accountId,
        message: "工作区已注册，账号可用。",
      };
    return {
      flowId: id,
      status: "pending",
      accountId: flow.accountId,
      message: account.lastError || "等待工作区注册…",
      pollIntervalMs: 3000,
    };
  }

  /** Final step for CNB is a probe: it confirms the workspace answers. */
  async function completeAuth(flowId, payload = {}) {
    const polled = await pollAuth(flowId, payload);
    const accountId = polled.accountId;
    if (!accountId || polled.status === "failed") return polled;
    const { body } = await service(`/api/accounts/${encodeURIComponent(accountId)}/probe`, {
      method: "POST",
      body: {},
      timeoutMs: 90000,
    });
    const state = accountState(body?.account);
    return {
      flowId,
      status: state === "healthy" ? "success" : "pending",
      accountId,
      message: state === "healthy" ? "探活通过，工作区已就绪。" : body?.account?.lastError || "探活未通过",
      pollIntervalMs: 3000,
    };
  }

  /**
   * Raw passthrough for `/api/p/cnb/*` (R8/AC8). Response status is preserved
   * so a service 4xx/409 reaches the console unchanged; binary payloads are
   * forwarded as bytes instead of being decoded as text.
   */
  async function call(path, options = {}) {
    const result = await client.request(path, options);
    if (result.contentType && !/^(text\/|application\/(json|xml)|application\/[\w.+-]+\+json)/i.test(result.contentType))
      return { ...result, body: result.buffer };
    return result;
  }

  const consoleApi = createCnbConsole({ serviceJson });
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
    keyManagement: { revealPaths: ["/api/access/key"] },
    capabilities: consoleApi.capabilities,
    inference: () => ({ url: baseUrl, routes: ["/v1/chat/completions", "/v1/responses", "/v1/messages", "/v1/messages/count_tokens"] }),
    // CNB currently offers only one built-in gateway credential. This method
    // is for the server-side gateway bootstrap and must never be serialized by
    // a management route; the gateway encrypts its result in panel SQLite.
    async ensureUpstreamCredential() {
      const data = await serviceJson("/api/access/key", { method: "POST", body: {} });
      if (typeof data.key !== "string" || !data.key) throw new AdapterError("CNB 尚未配置可用网关密钥", { status: 502, code: "upstream_key_missing" });
      return { secret: data.key, id: "builtin", name: "CNB 内置网关密钥", shared: true };
    },
  };
}

export { ACCOUNT_ACTIONS, toEntry, upstreamMessage };

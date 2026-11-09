import { AdapterError } from "./adapters/index.mjs";
import { InputError } from "./http.mjs";
import { compositeId, normalizeTagFilter, parseAccountId } from "./store.mjs";
import { describeError } from "./overview.mjs";

const MAX_ACCOUNTS_PER_SYSTEM = 5000;
const NATIVE_ID = /^[A-Za-z0-9._:-]{1,200}$/;

// One unified list, one system tag per account (R11). The system tag is
// automatic and always first so the console can render the badge without a
// second lookup; user tags come from the panel-owned store.
export function normalizeAccount(system, entry, userTags = []) {
  if (!entry || typeof entry !== "object")
    throw new AdapterError(`${system} 适配器返回了无效账号`, { code: "adapter_contract" });
  const nativeId = String(entry.nativeId ?? entry.id ?? "");
  if (!NATIVE_ID.test(nativeId))
    throw new AdapterError(`${system} 适配器返回了无效账号 ID`, { code: "adapter_contract" });
  const id = compositeId(system, nativeId);
  const label =
    typeof entry.label === "string" && entry.label.trim() ? entry.label.trim().slice(0, 200) : nativeId;
  const tags = [system, ...userTags.filter((tag) => tag !== system)];
  return {
    id,
    system,
    nativeId,
    label,
    status: typeof entry.status === "string" ? entry.status : "unknown",
    enabled: entry.enabled === undefined ? undefined : entry.enabled === true,
    quota: entry.quota === undefined ? null : entry.quota,
    tags,
    systemTags: [system],
    userTags: [...userTags],
    raw: entry.raw ?? null,
  };
}

export async function listAccounts(registry, store, { system, tag } = {}) {
  const systemFilter = typeof system === "string" && system ? system : "";
  if (systemFilter && !registry.has(systemFilter))
    throw new InputError("系统参数不受支持", 400, { param: "system" });
  const tagFilter = normalizeTagFilter(tag ?? "");
  const targets = systemFilter ? [systemFilter] : registry.systems();
  const errors = [];
  const accounts = [];
  await Promise.all(
    targets.map(async (name) => {
      try {
        const entries = await registry.get(name).listAccounts();
        if (!Array.isArray(entries))
          throw new AdapterError(`${name} 适配器未返回账号数组`, { code: "adapter_contract" });
        const seen = new Set();
        for (const entry of entries.slice(0, MAX_ACCOUNTS_PER_SYSTEM)) {
          const candidate = normalizeAccount(name, entry, []);
          if (seen.has(candidate.id)) continue;
          seen.add(candidate.id);
          accounts.push(normalizeAccount(name, entry, store.tags(candidate.id)));
        }
      } catch (error) {
        if (error instanceof AdapterError || error?.name === "AdapterError")
          errors.push({ system: name, error: describeError(error) });
        else throw error;
      }
    }),
  );
  accounts.sort((a, b) => a.system.localeCompare(b.system) || a.label.localeCompare(b.label));
  const filtered = tagFilter ? accounts.filter((account) => account.tags.includes(tagFilter)) : accounts;
  return { accounts: filtered, errors, systems: registry.systems() };
}

export function saveTags(store, id, input) {
  const { system } = parseAccountId(id);
  const tags = store.saveTags(id, Array.isArray(input) ? input : input?.tags);
  return { id, system, tags: [system, ...tags.filter((tag) => tag !== system)], userTags: tags };
}

const FLOW_ID = /^[A-Za-z0-9._:~-]{1,300}$/;

const requireMethod = (adapter, name, labels) => {
  if (typeof adapter[name] === "function") return adapter[name].bind(adapter);
  throw new InputError(
    adapter.stub ? `${adapter.system} 适配器尚未实现` : `${adapter.system} 服务不支持${labels}授权流程`,
    adapter.stub ? 501 : 501,
    { code: "auth_flow_unsupported" },
  );
};

// Authorization routing for all three systems (sh-accounts-3). Each system
// keeps its own native flow; the panel only wraps start/poll/complete.
export async function authAction(registry, system, action, payload = {}) {
  const adapter = registry.get(system);
  if (action === "start") {
    const start = requireMethod(adapter, "startAuth", "启动");
    const result = await start(payload);
    return { system, flowId: result?.flowId ?? null, result };
  }
  if (action === "poll") {
    const poll = requireMethod(adapter, "pollAuth", "轮询");
    const flowId = typeof payload.flowId === "string" ? payload.flowId : "";
    if (!FLOW_ID.test(flowId)) throw new InputError("flowId 格式不正确", 400, { param: "flowId" });
    return { system, flowId, result: await poll(flowId, payload) };
  }
  if (action === "complete") {
    const complete = requireMethod(adapter, "completeAuth", "完成");
    const flowId = typeof payload.flowId === "string" ? payload.flowId : "";
    if (!FLOW_ID.test(flowId)) throw new InputError("flowId 格式不正确", 400, { param: "flowId" });
    return { system, flowId, result: await complete(flowId, payload) };
  }
  throw new InputError("授权步骤须为 start、poll 或 complete", 404, { code: "auth_step_unsupported" });
}

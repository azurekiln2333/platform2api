// Adapter registry: one adapter per system, resolved from injection,
// `<system>.mjs`, or the stub fallback. See ./README.md for the contract.
import { AdapterError, createServiceClient } from "./client.mjs";
import { createStubAdapter } from "./_stub.mjs";

export { AdapterError, createServiceClient };
export const ADAPTER_METHODS = Object.freeze(["health", "overview", "listAccounts", "accountAction", "call"]);
export const OPTIONAL_ADAPTER_METHODS = Object.freeze(["startAuth", "pollAuth", "completeAuth"]);

const REQUIRED = ADAPTER_METHODS;

export function normalizeAdapter(candidate, { system }) {
  if (!candidate || typeof candidate !== "object")
    throw new Error(`${system}: adapter must be an object or a factory result`);
  const missing = REQUIRED.filter((name) => typeof candidate[name] !== "function");
  if (missing.length)
    throw new Error(`${system}: adapter is missing ${missing.join(", ")}`);
  return { stub: false, ...candidate, system };
}

// Accepts a factory, a `{ adapter }` / default export object, or a ready object.
export async function instantiate(mod, context) {
  const exported = mod?.default ?? mod?.adapter ?? mod;
  if (typeof exported === "function") return iife(await exported(context));
  return iife(exported);
}

const iife = (value) => value;

const loadModule = async (system) => {
  const specifier = new URL(`./${system}.mjs`, import.meta.url);
  try {
    return await import(specifier.href);
  } catch (error) {
    if (error?.code === "ERR_MODULE_NOT_FOUND" || error?.code === "MODULE_NOT_FOUND") return null;
    throw error;
  }
};

export async function createRegistry({ systems = [], adapters = {}, logger = console, clientOptions = {} } = {}) {
  const entries = new Map();
  for (const config of systems) {
    const { system } = config;
    if (!system) throw new Error("adapter registry: system name is required");
    if (adapters[system]) {
      const candidate =
        typeof adapters[system] === "function" ? await adapters[system](config) : adapters[system];
      entries.set(system, normalizeAdapter(candidate, { system }));
      continue;
    }
    const client = createServiceClient({
      system,
      baseUrl: config.baseUrl,
      token: config.token,
      timeoutMs: config.timeoutMs,
      fetchImpl: config.fetchImpl || clientOptions.fetchImpl,
    });
    const context = {
      system,
      baseUrl: config.baseUrl,
      token: config.token || "",
      timeoutMs: client.timeoutMs,
      client,
      logger,
    };
    const mod = await loadModule(system);
    if (!mod) {
      entries.set(system, createStubAdapter(context));
      continue;
    }
    try {
      entries.set(system, normalizeAdapter(await instantiate(mod, context), { system }));
    } catch (error) {
      logger.error?.(`[adapters] ${system}: ${error.message}`);
      entries.set(system, createStubAdapter(context));
    }
  }

  return {
    systems: () => [...entries.keys()],
    has: (system) => entries.has(system),
    get(system) {
      const adapter = entries.get(system);
      if (!adapter)
        throw new AdapterError(`不支持的系统：${system}`, { status: 404, code: "system_not_supported" });
      return adapter;
    },
    isStub: (system) => entries.get(system)?.stub === true,
  };
}

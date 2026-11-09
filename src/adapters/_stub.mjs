import { AdapterError } from "./client.mjs";

// Fallback used until P3/P4 land their adapter module. It keeps the panel
// bootable and makes "this system is unavailable" explicit per system (R10).
export const STUB_ACTIONS = Object.freeze([
  "health",
  "overview",
  "listAccounts",
  "accountAction",
  "startAuth",
  "pollAuth",
  "completeAuth",
  "call",
]);

export function createStubAdapter(context = {}) {
  const system = context.system || "unknown";
  const notImplemented = (what) =>
    new AdapterError(`${system} 适配器尚未实现（${what}）`, {
      status: 501,
      code: "adapter_not_implemented",
    });
  return {
    system,
    stub: true,
    async health() {
      return { status: "down", detail: "适配器尚未实现" };
    },
    async overview() {
      throw notImplemented("overview");
    },
    async listAccounts() {
      throw notImplemented("listAccounts");
    },
    async accountAction() {
      throw notImplemented("accountAction");
    },
    async startAuth() {
      throw notImplemented("startAuth");
    },
    async pollAuth() {
      throw notImplemented("pollAuth");
    },
    async completeAuth() {
      throw notImplemented("completeAuth");
    },
    async call() {
      throw notImplemented("call");
    },
  };
}

// Adding a channel starts here. UI/API inventories and deployment defaults
// derive from this registry; adapters remain responsible for native semantics.
export const CHANNELS = Object.freeze([
  Object.freeze({
    system: "cnb", label: "CNB", color: "#2563eb",
    defaultUrl: "http://127.0.0.1:9002", envPrefix: "CNB",
    adapterUrl: new URL("./adapters/cnb.mjs", import.meta.url).href,
  }),
  Object.freeze({
    system: "codebuddy", label: "CodeBuddy", color: "#7c3aed",
    defaultUrl: "http://127.0.0.1:8787", envPrefix: "CODEBUDDY",
    adapterUrl: new URL("./adapters/codebuddy.mjs", import.meta.url).href,
  }),
  Object.freeze({
    system: "zcode", label: "ZCode", color: "#059669",
    defaultUrl: "http://127.0.0.1:12283", envPrefix: "ZCODE",
    adapterUrl: new URL("./adapters/zcode.mjs", import.meta.url).href,
  }),
]);

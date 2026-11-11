import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { InputError, json, readRawBody } from "../http.mjs";
import { entries, method } from "../console-data.mjs";

const retryable = new Set([429, 502, 503]);
const failure = (message, status, code) => new InputError(message, status, { code });

// Inspect bounded fragments for usage only. Neither request nor response bodies
// are retained in logs, and streaming never waits for a complete response.
export class UsageScanner {
  constructor() { this.tail = ""; this.decoder = new TextDecoder(); this.inputTokens = null; this.outputTokens = null; }
  write(bytes) {
    this.tail = (this.tail + this.decoder.decode(bytes, { stream: true })).slice(-131072);
    const pattern = /"usage"\s*:\s*\{/g;
    let match, end = 0;
    while ((match = pattern.exec(this.tail))) {
      const start = pattern.lastIndex - 1;
      let depth = 0, quoted = false, escaped = false, closed = -1;
      for (let i = start; i < this.tail.length; i++) {
        const char = this.tail[i];
        if (quoted) { if (escaped) escaped = false; else if (char === "\\") escaped = true; else if (char === '"') quoted = false; }
        else if (char === '"') quoted = true;
        else if (char === "{") depth++;
        else if (char === "}" && --depth === 0) { closed = i + 1; break; }
      }
      if (closed < 0) break;
      try {
        const usage = JSON.parse(this.tail.slice(start, closed));
        for (const [property, value] of [["inputTokens", usage.input_tokens ?? usage.prompt_tokens], ["outputTokens", usage.output_tokens ?? usage.completion_tokens]]) {
          if (Number.isSafeInteger(value) && value >= 0) this[property] = Math.max(this[property] ?? 0, value);
        }
      } catch { /* Partial/unrecognized usage is not invented. */ }
      end = closed; pattern.lastIndex = closed;
    }
    if (end) this.tail = this.tail.slice(end);
  }
}

export function createGateway({ getRegistry, store, fetchImpl = fetch, bodyLimit = 32 * 1024 * 1024, idleTimeoutMs = 60000, modelTtlMs = 60000, logger = console }) {
  const catalog = new Map(), credentials = new Map(), catalogLoads = new Map();
  async function channelModels(adapter) {
    const previous = catalog.get(adapter.system);
    if (previous && Date.now() - previous.at < modelTtlMs) return previous;
    if (catalogLoads.has(adapter.system)) return catalogLoads.get(adapter.system);
    const loading = (async () => {
      try {
        const items = entries(await method(adapter, "listModels")(), "models");
        const value = { at: Date.now(), stale: false, models: new Set(items.filter((m) => m.enabled !== false).map((m) => String(m.model ?? m.id ?? m.name))) };
        catalog.set(adapter.system, value); return value;
      } catch {
        if (previous) return { ...previous, stale: true };
        return { at: Date.now(), stale: true, models: new Set() };
      } finally { catalogLoads.delete(adapter.system); }
    })();
    catalogLoads.set(adapter.system, loading); return loading;
  }
  async function credential(adapter, force = false) {
    if (!force) { const saved = store.credential(adapter.system); if (saved) return saved; }
    if (credentials.has(adapter.system)) return credentials.get(adapter.system);
    const loading = (async () => {
      try {
        if (typeof adapter.ensureUpstreamCredential !== "function") throw failure("渠道不支持配置推理凭据", 502, "upstream_credential_unsupported");
        const created = await adapter.ensureUpstreamCredential({ force, previous: store.credential(adapter.system) });
        const result = typeof created === "string" ? { secret: created } : created;
        store.saveCredential(adapter.system, result); return result;
      } finally { credentials.delete(adapter.system); }
    })();
    credentials.set(adapter.system, loading); return loading;
  }
  const permitted = (key, system) => key.channels === "*" || key.channels.includes(system);
  const allowedModel = (key, system, model) => !key.limits.models?.length || key.limits.models.includes(model) || key.limits.models.includes(`${system}/${model}`);
  async function inventory(registry) {
    return Promise.all(registry.systems().map(async (system) => {
      const adapter = registry.get(system);
      const [models, health, inference] = await Promise.allSettled([channelModels(adapter), adapter.health(), typeof adapter.inference === "function" ? adapter.inference() : { url: adapter.baseUrl, routes: [] }]);
      return { system, adapter, models: models.status === "fulfilled" ? models.value.models : new Set(), stale: models.status !== "fulfilled" || models.value.stale,
        healthy: health.status === "fulfilled" && ["ok", "healthy", "ready"].includes(health.value?.status ?? health.value), inference: inference.status === "fulfilled" ? inference.value : { routes: [] } };
    }));
  }
  async function matches(path) {
    if (path.startsWith("/v1/")) return true;
    const registry = await getRegistry();
    for (const system of registry.systems()) {
      const adapter = registry.get(system);
      if (typeof adapter.inference === "function") {
        try { if ((await adapter.inference()).routes?.includes(path)) return true; } catch { /* Unavailable adapter contributes no alias. */ }
      }
    }
    return false;
  }
  async function handle(req, res, url) {
    const started = Date.now(), requestId = randomUUID(), controller = new AbortController();
    let key, release = () => {}, idle, recorded = false, upstreamController;
    const record = { requestId, system: null, model: null, status: 500, stream: false, inputTokens: null, outputTokens: null };
    const scanner = new UsageScanner();
    const arm = () => { clearTimeout(idle); idle = setTimeout(() => upstreamController?.abort(new Error("upstream_idle_timeout")), idleTimeoutMs).unref(); };
    const disconnect = () => { if (!res.writableFinished) controller.abort(new Error("client_disconnected")); };
    res.on("close", disconnect);
    const log = () => {
      if (recorded) return; recorded = true;
      if (record.inference === false) return; // Model discovery is not inference usage.
      store.record({ ...record, inputTokens: scanner.inputTokens, outputTokens: scanner.outputTokens, durationMs: Date.now() - started }, key);
    };
    try {
      const authorization = req.headers.authorization;
      const bearer = typeof authorization === "string" ? /^Bearer\s+([^\s]+)$/i.exec(authorization)?.[1] : "";
      key = store.authenticate(bearer || req.headers["x-api-key"], req.socket.remoteAddress);
      const registry = await getRegistry(), routing = store.routing();
      if (url.pathname === "/v1/models" && req.method === "GET") {
        record.inference = false;
        const channels = await inventory(registry), models = new Map();
        for (const channel of channels) if (permitted(key, channel.system) && routing.enabled[channel.system] && channel.healthy)
          for (const model of channel.models) if (allowedModel(key, channel.system, model)) {
            const sources = models.get(model) ?? []; sources.push({ system: channel.system, stale: channel.stale }); models.set(model, sources);
          }
        record.status = 200;
        return json(res, 200, { object: "list", data: [...models].sort(([a], [b]) => a.localeCompare(b)).map(([id, channels]) => ({ id, object: "model", owned_by: "platform2api", channels })) }, { "X-Request-Id": requestId });
      }
      if (req.method !== "POST") throw failure("推理接口仅支持 POST", 405, "method_not_allowed");
      const raw = await readRawBody(req, bodyLimit);
      let body;
      try { body = JSON.parse(raw.toString("utf8")); } catch { throw failure("请求体须为 JSON", 400, "invalid_request"); }
      if (!body || Array.isArray(body) || typeof body.model !== "string" || !body.model || body.model.length > 500) throw failure("请提供模型名称", 400, "invalid_model");
      let model = body.model, explicit;
      const slash = model.indexOf("/");
      if (slash > 0 && registry.has(model.slice(0, slash))) { explicit = model.slice(0, slash); model = model.slice(slash + 1); }
      record.model = model; record.stream = body.stream === true;
      if (explicit && !permitted(key, explicit)) throw failure("密钥不允许访问此渠道", 403, "channel_not_allowed");
      if (key.limits.models?.length && !key.limits.models.includes(model) && !key.limits.models.includes(body.model) && !registry.systems().some((s) => allowedModel(key, s, model) && permitted(key, s))) throw failure("密钥不允许访问此模型", 403, "model_not_allowed");
      const inventoryRows = await inventory(registry);
      const supported = inventoryRows.filter((row) => row.inference.routes?.includes(url.pathname));
      if (!supported.length) throw failure("没有渠道支持此推理协议", 404, "route_not_found");
      const listed = supported.filter((row) => row.models.has(model) && (!explicit || row.system === explicit));
      if (listed.length && !listed.some((row) => permitted(key, row.system) && allowedModel(key, row.system, model))) throw failure("密钥不允许访问此模型所在渠道", 403, "model_not_allowed");
      let candidates = listed.filter((row) => permitted(key, row.system) && allowedModel(key, row.system, model) && routing.enabled[row.system] && row.healthy)
        .sort((a, b) => routing.order.indexOf(a.system) - routing.order.indexOf(b.system));
      if (!candidates.length) throw failure("没有可用模型：请检查模型目录、密钥范围、渠道健康、路由开关与协议支持", 404, "model_not_found");
      if (!routing.failover || explicit) candidates = candidates.slice(0, 1);
      release = store.reserve(key);
      const payload = explicit ? Buffer.from(JSON.stringify({ ...body, model })) : raw;
      let response, chosen, reader, first;
      for (let i = 0; i < candidates.length; i++) {
        const candidate = candidates[i]; chosen = candidate; record.system = candidate.system;
        upstreamController = new AbortController();
        let auth;
        try {
          auth = await credential(candidate.adapter);
          const send = async () => {
            arm();
            const headers = { "content-type": "application/json", authorization: `Bearer ${auth.secret}`, "x-api-key": auth.secret, "x-platform-request-id": requestId };
            for (const name of ["accept", "anthropic-version", "anthropic-beta", "openai-organization", "openai-project"]) if (typeof req.headers[name] === "string") headers[name] = req.headers[name];
            const base = candidate.inference.url ?? candidate.adapter.baseUrl;
            return fetchImpl(`${base.replace(/\/+$/, "")}${url.pathname}${url.search}`, { method: "POST", headers, body: payload, signal: AbortSignal.any([controller.signal, upstreamController.signal]), redirect: "manual" });
          };
          response = await send();
          if (response.status === 401) {
            await response.body?.cancel();
            auth = await credential(candidate.adapter, true);
            response = await send();
          }
          if (retryable.has(response.status) && i < candidates.length - 1) { await response.body?.cancel(); clearTimeout(idle); continue; }
          reader = response.body?.getReader();
          arm(); first = reader ? await reader.read() : { done: true };
        } catch (error) {
          clearTimeout(idle);
          await reader?.cancel().catch(() => {}); reader?.releaseLock(); reader = undefined;
          if (controller.signal.aborted || i === candidates.length - 1) throw failure(controller.signal.aborted ? "上游连接超时或客户端已断开" : "上游连接失败", 502, "upstream_unavailable");
          continue;
        }
        break;
      }
      if (!response) throw failure("上游不可用", 502, "upstream_unavailable");
      record.status = response.status; record.system = chosen.system;
      const headers = { "content-type": response.headers.get("content-type") || "application/json", "cache-control": "no-store", "x-request-id": requestId };
      if (response.headers.has("retry-after")) headers["retry-after"] = response.headers.get("retry-after");
      try {
        if (!reader) { log(); res.writeHead(response.status, headers); res.end(); return; }
        // Headers are committed with the first body chunk. Once committed no
        // upstream failure can replay the request against a different channel.
        let part = first;
        while (true) {
          const { done, value } = part;
          if (done) break;
          arm(); scanner.write(value);
          if (!res.headersSent) res.writeHead(response.status, headers);
          if (!res.write(value)) {
            clearTimeout(idle);
            await once(res, "drain", { signal: controller.signal });
          }
          arm(); part = await reader.read();
        }
        log();
        if (!res.headersSent) res.writeHead(response.status, headers);
        res.end();
      } finally { await reader?.cancel().catch(() => {}); reader?.releaseLock(); }
    } catch (error) {
      record.status = error instanceof InputError ? error.status : 502;
      try { log(); } catch { logger.error?.("[gateway] failed to persist request accounting"); }
      if (res.headersSent) res.destroy();
      else if (!res.destroyed) json(res, record.status, { error: { message: error instanceof InputError ? error.message : "推理请求失败", type: "gateway_error", code: error.code || "upstream_error" } }, { "X-Request-Id": requestId });
    } finally { clearTimeout(idle); res.off("close", disconnect); release(); }
  }
  return { matches, handle, invalidate: (system) => catalog.delete(system) };
}

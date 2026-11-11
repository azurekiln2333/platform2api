import { InputError, readRawBody } from "./http.mjs";
import { AdapterError } from "./adapters/index.mjs";

// `/api/p/<system>/<path>` normalizing proxy. Browsers never talk to a service
// directly (design: service auth), so every remaining management route of every
// system reaches the console through here (R8/AC8 escape hatch).
const FORWARD_HEADERS = {
  "content-type": "content-type",
  "if-match": "if-match",
  "if-none-match": "if-none-match",
  accept: "accept",
};

const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"]);

export const proxyTarget = (path) => {
  const match = /^\/api\/p\/([a-z][a-z0-9_-]{0,63})(\/.*)?$/.exec(path);
  if (!match) return null;
  return { system: match[1], path: match[2] && match[2] !== "" ? match[2] : "/" };
};

// Percent-encoded traversal must be rejected before it reaches an adapter.
export const assertSafePath = (path) => {
  for (const segment of path.split("/")) {
    if (!segment) continue;
    let decoded;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      throw new InputError("无效的服务路径", 400);
    }
    if (decoded === "." || decoded === ".." || /[\\/]/.test(decoded))
      throw new InputError("服务路径不得包含上级目录", 400);
  }
};

export async function proxyRequest({ req, registry, system, path, search, maxBytes, gatewayStore }) {
  if (!METHODS.has(req.method)) throw new InputError("method not allowed", 405);
  assertSafePath(path);
  const adapter = registry.get(system);
  const policy = adapter.console?.keyManagement ?? adapter.keyManagement;
  const canonical = `/${path.split("/").filter(Boolean).map(decodeURIComponent).join("/")}`;
  const internal = new Set(gatewayStore?.internalKeyIds(system) ?? []);
  if (policy) {
    const targetId = policy.prefix && canonical.startsWith(policy.prefix) ? canonical.slice(policy.prefix.length).split("/")[0] : null;
    if (targetId && internal.has(targetId)) throw new InputError("此密钥由统一入口管理", 403);
    if (policy.revealPaths?.includes(canonical) || targetId && policy.revealSuffix && canonical.endsWith(policy.revealSuffix))
      throw new InputError("完整密钥仅在创建或轮换时显示", 403);
  }
  if (typeof adapter.call !== "function")
    throw new AdapterError(`${system} 适配器不支持透传`, { status: 501, code: "adapter_not_implemented" });
  const headers = {};
  for (const [from, to] of Object.entries(FORWARD_HEADERS)) {
    const value = req.headers[from];
    if (value) headers[to] = value;
  }
  let body;
  if (!["GET", "HEAD"].includes(req.method)) {
    const raw = await readRawBody(req, maxBytes);
    body = raw.length ? raw : undefined;
  }
  const query = Object.fromEntries(search.entries());
  let result;
  try {
    result = await adapter.call(path, { method: req.method, query, body, headers });
  } catch (error) {
    if (error instanceof InputError) throw error;
    if (error instanceof AdapterError || error?.name === "AdapterError") throw error;
    throw new AdapterError(`${system} 服务请求失败`, { status: 502, code: "upstream_error", cause: error });
  }
  if (policy?.list === canonical && req.method === "GET" && internal.size && result.status >= 200 && result.status < 300) {
    let value = result.body;
    if (Buffer.isBuffer(value) || typeof value === "string") {
      try { value = JSON.parse(value.toString()); } catch { throw new AdapterError("渠道密钥列表格式不正确", { code: "upstream_shape" }); }
    }
    const rows = Array.isArray(value) ? value : value?.[policy.items];
    if (!Array.isArray(rows)) throw new AdapterError("渠道密钥列表格式不正确", { code: "upstream_shape" });
    const publicRows = rows.filter((row) => !internal.has(String(row.id ?? row.nativeId)));
    result = { ...result, body: Array.isArray(value) ? publicRows : { ...value, [policy.items]: publicRows, ...(typeof value.total === "number" ? { total: Math.max(0, value.total - rows.length + publicRows.length) } : {}) } };
  }
  return normalizeResult(result, { system, path });
}

const HEADER_ALLOW = /^(content-type|content-disposition|retry-after|etag|last-modified|x-[a-z0-9-]{1,40})$/i;
const HEADER_DENY = /^(set-cookie|content-length|transfer-encoding|connection|keep-alive)$/i;

function normalizeResult(result, { system, path }) {
  if (result === undefined || result === null)
    throw new AdapterError(`${system} 适配器对 ${path} 未返回结果`, { code: "adapter_contract" });
  if (typeof result !== "object" || Buffer.isBuffer(result) || result instanceof Uint8Array)
    return { status: 200, contentType: "application/json; charset=utf-8", body: result };
  const status = Number.isInteger(result.status) ? result.status : 200;
  const rawHeaders = result.headers && typeof result.headers === "object" ? result.headers : {};
  const headers = {};
  for (const [name, value] of Object.entries(rawHeaders)) {
    if (typeof value !== "string" || !HEADER_ALLOW.test(name) || HEADER_DENY.test(name)) continue;
    if (/[\r\n]/.test(value)) continue;
    headers[name.toLowerCase()] = value;
  }
  const contentType = result.contentType || headers["content-type"];
  return { status, contentType, headers, body: result.body };
}

export function writeProxyResult(res, { status, contentType, headers = {}, body }) {
  const outHeaders = { "Cache-Control": "no-store", ...headers };
  if (contentType) outHeaders["content-type"] = String(contentType).slice(0, 200);
  if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
    outHeaders["content-type"] ??= "application/octet-stream";
    outHeaders["content-length"] = String(body.length);
    res.writeHead(status, outHeaders);
    res.end(Buffer.from(body));
    return;
  }
  if (typeof body === "string") {
    outHeaders["content-type"] ??= "text/plain; charset=utf-8";
    res.writeHead(status, outHeaders);
    res.end(body);
    return;
  }
  outHeaders["content-type"] ??= "application/json; charset=utf-8";
  res.writeHead(status, outHeaders);
  res.end(JSON.stringify(body ?? null));
}

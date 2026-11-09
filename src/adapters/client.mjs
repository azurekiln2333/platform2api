import { InputError } from "../http.mjs";

// Shared service client for every adapter. Adapters never call bare fetch:
// this keeps bearer auth, timeouts and size caps in one place.

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 15000;

export class AdapterError extends Error {
  constructor(message, { status = 502, code, cause } = {}) {
    super(message);
    this.name = "AdapterError";
    this.status = status;
    if (code) this.code = code;
    if (cause) this.cause = cause;
  }
}

const joinPath = (baseUrl, path) => {
  const suffix = String(path || "/");
  if (/^[a-z][a-z0-9+.-]*:/i.test(suffix) || suffix.startsWith("//"))
    throw new InputError("服务路径不得为绝对地址", 400);
  const clean = suffix.startsWith("/") ? suffix : `/${suffix}`;
  // Traversal is rejected before the URL is built so a proxied path can never
  // escape the service prefix.
  if (clean.split("/").some((segment) => segment === ".."))
    throw new InputError("服务路径不得包含上级目录", 400);
  return `${baseUrl.replace(/\/+$/, "")}${clean}`;
};

export const buildUrl = (baseUrl, path, query) => {
  const url = new URL(joinPath(baseUrl, path));
  if (query && typeof query === "object") {
    const params = query instanceof URLSearchParams ? query : new URLSearchParams();
    if (!(query instanceof URLSearchParams))
      for (const [key, value] of Object.entries(query)) {
        if (value === undefined || value === null) continue;
        if (Array.isArray(value)) for (const item of value) params.append(key, String(item));
        else params.set(key, String(value));
      }
    const text = params.toString();
    if (text) url.search = text;
  }
  return url;
};

const readLimited = async (response, maxBytes) => {
  const reader = response.body?.getReader();
  if (!reader) return Buffer.alloc(0);
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new AdapterError("服务响应超出大小限制", { code: "response_too_large" });
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks, size);
};

const RELAY_HEADERS = ["content-type", "content-disposition", "retry-after", "etag", "last-modified"];

export function createServiceClient({
  system,
  baseUrl,
  token = "",
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxResponseBytes = MAX_RESPONSE_BYTES,
  fetchImpl = fetch,
}) {
  if (typeof baseUrl !== "string" || !baseUrl)
    throw new Error(`${system}: service base URL is required`);

  const request = async (path, options = {}) => {
    const {
      method = "GET",
      query,
      body,
      headers = {},
      timeoutMs: requestTimeout = timeoutMs,
      raw = false,
    } = options;
    const url = buildUrl(baseUrl, path, query);
    const outgoing = { ...headers };
    let payload = body;
    if (body !== undefined && body !== null && !Buffer.isBuffer(body) && typeof body === "object") {
      payload = JSON.stringify(body);
      if (!Object.keys(outgoing).some((key) => key.toLowerCase() === "content-type"))
        outgoing["Content-Type"] = "application/json";
    }
    if (token) outgoing.Authorization = `Bearer ${token}`;
    outgoing.Accept ??= "application/json, text/plain, */*";
    outgoing["X-Platform-System"] = system;

    let response;
    try {
      response = await fetchImpl(url, {
        method,
        headers: outgoing,
        body: payload,
        redirect: "manual",
        signal: AbortSignal.timeout(requestTimeout),
      });
    } catch (error) {
      const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
      throw new AdapterError(
        timedOut ? `${system} 服务响应超时` : `${system} 服务无法连接`,
        { status: 502, code: timedOut ? "upstream_timeout" : "upstream_unreachable", cause: error },
      );
    }

    let buffer;
    try {
      buffer = await readLimited(response, maxResponseBytes);
    } catch (error) {
      if (error instanceof AdapterError) throw error;
      throw new AdapterError(`${system} 服务响应读取失败`, { status: 502, code: "upstream_read_failed", cause: error });
    }

    const contentType = response.headers.get("content-type") || "";
    const relayHeaders = {};
    for (const name of RELAY_HEADERS) {
      const value = response.headers.get(name);
      if (value) relayHeaders[name] = value;
    }
    if (raw) {
      return {
        status: response.status,
        ok: response.ok,
        contentType,
        headers: relayHeaders,
        buffer,
        text: buffer.toString("utf8"),
      };
    }
    let parsed;
    if (/[+/]json\b/.test(contentType)) {
      try {
        parsed = buffer.length ? JSON.parse(buffer.toString("utf8")) : null;
      } catch {
        parsed = buffer.toString("utf8");
      }
    } else {
      parsed = buffer.toString("utf8");
    }
    return {
      status: response.status,
      ok: response.ok,
      contentType,
      headers: relayHeaders,
      body: parsed,
      buffer,
      text: buffer.toString("utf8"),
    };
  };

  return { system, baseUrl, token, timeoutMs, request };
}

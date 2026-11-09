import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, resolve, sep } from "node:path";

// Shared HTTP plumbing. Shapes mirror cnb2api-panel so the console contract
// (R12) stays identical: `{ error: { message, type, param?, code? } }`.

export const MAX_JSON_BYTES = 65536;
// Management uploads (credential import, key files) pass through byte-for-byte,
// so the passthrough budget is separate from the JSON budget.
export const MAX_PASSTHROUGH_BYTES = 32 * 1024 * 1024;

export class InputError extends Error {
  constructor(message, status = 400, { code, param } = {}) {
    super(message);
    this.name = "InputError";
    this.status = status;
    if (code) this.code = code;
    if (param) this.param = param;
  }
}

export const json = (res, status, data, headers = {}) => {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(JSON.stringify(data));
};

export const redirect = (res, location, headers = {}) => {
  if (res.writableEnded || res.destroyed) return;
  res.writeHead(302, { "Cache-Control": "no-store", Location: location, ...headers });
  res.end();
};

export const requestUrl = (req) => new URL(req.url, "http://panel.local");

export const cookieValue = (req, name) => {
  const prefix = `${name}=`;
  const header = (req.headers.cookie || "")
    .split(";")
    .map((value) => value.trim())
    .find((value) => value.startsWith(prefix));
  return header ? header.slice(prefix.length) : "";
};

export function readRawBody(req, maxBytes = MAX_PASSTHROUGH_BYTES) {
  return new Promise((resolveBody, rejectBody) => {
    let size = 0;
    let settled = false;
    const chunks = [];
    const reject = (error) => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      rejectBody(error);
    };
    req.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      // Keep draining after rejection so HTTP 413 still reaches the client.
      if (size > maxBytes) {
        reject(new InputError("请求体超出大小限制", 413));
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolveBody(Buffer.concat(chunks));
    });
    req.on("error", () => reject(new InputError("客户端连接已断开", 400)));
    req.on("close", () => {
      if (!req.complete) reject(new InputError("客户端连接已断开", 400));
    });
  });
}

export async function readJsonBody(req, maxBytes = MAX_JSON_BYTES) {
  const raw = await readRawBody(req, maxBytes);
  if (!raw.length) throw new InputError("请求体须为有效的 JSON");
  let value;
  try {
    value = JSON.parse(raw.toString("utf8"));
  } catch {
    throw new InputError("请求体须为有效的 JSON");
  }
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new InputError("请求体须为 JSON 对象");
  return value;
}

const STATIC_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".css": "text/css",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

// Serves the built console. Unknown extension-less paths fall back to
// index.html so the Vue router owns client-side routes.
export function serveStatic(req, res, root, path) {
  let decoded;
  try {
    decoded = decodeURIComponent(path);
  } catch {
    throw new InputError("无效的资源路径", 400);
  }
  const base = resolve(root);
  const requested = resolve(base, `.${decoded}`);
  if (requested !== base && !requested.startsWith(`${base}${sep}`))
    throw new InputError("无效的资源路径", 400);
  const isFile = existsSync(requested) && statSync(requested).isFile();
  const file = isFile ? requested : extname(decoded) ? null : resolve(base, "index.html");
  if (!file || !existsSync(file))
    return json(res, 404, {
      error: { message: "前端尚未构建，请先执行 npm --prefix web run build", type: "invalid_request_error" },
    });
  res.writeHead(200, {
    "Content-Type": STATIC_TYPES[extname(file)] || "application/octet-stream",
    "Cache-Control": file.includes(`${sep}assets${sep}`)
      ? "public, max-age=31536000, immutable"
      : "no-cache",
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
  });
  res.end(req.method === "HEAD" ? undefined : readFileSync(file));
}

const SAFE_PARAM = /^[A-Za-z_][A-Za-z0-9_]*(?:\.(?:[A-Za-z_][A-Za-z0-9_]*|\d+))*$/;
const SAFE_CODE = /^[a-z][a-z0-9_]{0,63}$/;

export function errorResponse(error) {
  const known = error instanceof InputError;
  const status = known ? error.status : Number.isInteger(error?.status) ? error.status : 500;
  const body = {
    message: known ? error.message : "服务处理失败，请检查服务端日志",
    type: status >= 500 ? "api_error" : status === 413 ? "request_too_large" : "invalid_request_error",
  };
  if (typeof error?.param === "string" && SAFE_PARAM.test(error.param)) body.param = error.param;
  if (typeof error?.code === "string" && SAFE_CODE.test(error.code)) body.code = error.code;
  return { status, body };
}

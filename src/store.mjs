import { randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { InputError } from "./http.mjs";
import {
  DEFAULT_SSO,
  sanitizeSso,
  ssoIsConfigured,
  validateSso,
  withSsoDefaults,
} from "./sso.mjs";

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);
const loopbackHost = (hostname) =>
  LOOPBACK_HOSTS.has(hostname) || hostname.endsWith(".localhost");
const printable = (value) => !/[\x00-\x1f\x7f]/.test(value);

const text = (value, limit, label) => {
  if (typeof value !== "string" || value.length > limit)
    throw new InputError(`${label}格式不正确`);
  return value.trim();
};

export const SYSTEMS = Object.freeze(["cnb", "codebuddy", "zcode"]);

export const DEFAULT_SERVICE_URLS = Object.freeze({
  cnb: "http://127.0.0.1:9002",
  codebuddy: "http://127.0.0.1:8787",
  zcode: "http://127.0.0.1:12283",
});

// Service base URLs are operator settings. Loopback HTTP stays available for
// local Compose and tests; anything else must be an HTTP(S) origin.
export function normalizeServiceUrl(input, { allowLocal = false, label = "服务地址" } = {}) {
  const value = text(input, 500, label);
  if (!value) return "";
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new InputError(`${label}须为完整的 HTTP(S) 地址`);
  }
  if (!["http:", "https:"].includes(url.protocol))
    throw new InputError(`${label}须为完整的 HTTP(S) 地址`);
  if (url.protocol === "http:" && !(allowLocal || loopbackHost(url.hostname)))
    throw new InputError(`${label}须使用 HTTPS 地址（本地部署或回环地址除外）`);
  if (url.username || url.password || url.search || url.hash)
    throw new InputError(`${label}不得包含凭据、查询或片段`);
  return `${url.origin}${url.pathname.replace(/\/+$/, "")}`;
}

const TAG_MAX = 12;
const TAG_LENGTH = 32;
const TAG_PATTERN = /^[\p{L}\p{N}_\- .:]+$/u;
const ACCOUNT_ID = /^[a-z]+\:[A-Za-z0-9._:-]{1,200}$/;

export function normalizeTags(input, { limit = TAG_MAX } = {}) {
  if (!Array.isArray(input)) throw new InputError("标签须为字符串数组");
  const result = [];
  for (const entry of input) {
    if (typeof entry !== "string") throw new InputError("标签须为字符串数组");
    const tag = entry.trim();
    if (!tag) continue;
    if (tag.length > TAG_LENGTH || !printable(tag) || !TAG_PATTERN.test(tag))
      throw new InputError(`标签「${tag.slice(0, TAG_LENGTH)}」格式不正确`);
    if (!result.includes(tag)) result.push(tag);
  }
  if (result.length > limit) throw new InputError(`每个账号最多 ${limit} 个标签`);
  return result;
}

const TAG_FILTER = /^[\p{L}\p{N}_\- .:]{1,32}$/u;

export function normalizeTagFilter(input) {
  if (typeof input !== "string" || !input.trim()) return "";
  const value = input.trim();
  if (!TAG_FILTER.test(value)) throw new InputError("标签筛选条件格式不正确");
  return value;
}

// Account ids on the wire are `<system>:<nativeId>` so the unified list can
// round-trip an id without a second lookup (design: unified Accounts page).
export function parseAccountId(input) {
  if (typeof input !== "string" || !ACCOUNT_ID.test(input))
    throw new InputError("账号 ID 须为 <system>:<原生 ID> 格式");
  const [system, ...rest] = input.split(":");
  if (!SYSTEMS.includes(system)) throw new InputError("账号 ID 中的系统不受支持");
  return { system, nativeId: rest.join(":") };
}

export const compositeId = (system, nativeId) => `${system}:${nativeId}`;

const atomicWrite = (file, value) => {
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(`${file}.tmp`, payload, { mode: 0o600, flush: true });
  renameSync(`${file}.tmp`, file);
};

// Panel-owned persistence only: SSO settings, service URL overrides and the
// user's account tags. Service data always stays inside each service container.
export class PanelStore {
  constructor(directory, { allowLocal = false } = {}) {
    this.directory = resolve(directory);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.allowLocal = allowLocal;
    this.file = join(this.directory, "panel.json");
    this.tagsFile = join(this.directory, "tags.json");
    const keyFile = join(this.directory, "master.key");
    if (!existsSync(keyFile)) {
      if (existsSync(this.file))
        throw new Error("data/panel/master.key is missing; restore the panel data backup");
      writeFileSync(keyFile, randomBytes(32), { mode: 0o600, flag: "wx" });
    }
    this.key = readFileSync(keyFile);
    if (this.key.length !== 32)
      throw new Error("data/panel/master.key is invalid; restore the panel data backup");
    this.state = this.load();
  }

  load() {
    const state = {
      version: 1,
      sso: { ...DEFAULT_SSO },
      serviceUrls: {},
      tags: {},
    };
    if (existsSync(this.file)) {
      const saved = JSON.parse(readFileSync(this.file, "utf8"));
      if (saved.version !== 1)
        throw new Error("Unsupported panel data version; restore the panel data backup");
      if (!saved.sso || typeof saved.sso !== "object")
        throw new Error("Invalid panel SSO settings; restore the panel data backup");
      const sso = withSsoDefaults(saved.sso);
      if (typeof saved.sso.clientSecret === "string" && saved.sso.clientSecret)
        sso.clientSecret = this.decrypt(saved.sso.clientSecret);
      state.sso = sso;
      if (saved.serviceUrls !== undefined) {
        if (typeof saved.serviceUrls !== "object" || Array.isArray(saved.serviceUrls))
          throw new Error("Invalid panel service settings; restore the panel data backup");
        for (const system of SYSTEMS) {
          const url = saved.serviceUrls[system];
          if (typeof url !== "string" || !url) continue;
          state.serviceUrls[system] = normalizeServiceUrl(url, {
            allowLocal: this.allowLocal,
            label: `${system} 服务地址`,
          });
        }
      }
    }
    if (existsSync(this.tagsFile)) {
      const saved = JSON.parse(readFileSync(this.tagsFile, "utf8"));
      if (saved.version !== 1 || !saved.tags || typeof saved.tags !== "object")
        throw new Error("Invalid panel tag store; restore the panel data backup");
      for (const [id, tags] of Object.entries(saved.tags)) {
        if (!ACCOUNT_ID.test(id)) continue;
        const normalized = normalizeTags(Array.isArray(tags) ? tags : []);
        if (normalized.length) state.tags[id] = normalized;
      }
    }
    return state;
  }

  encrypt(value) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
  }

  decrypt(value) {
    const raw = Buffer.from(value, "base64");
    const cipher = createDecipheriv("aes-256-gcm", this.key, raw.subarray(0, 12));
    cipher.setAuthTag(raw.subarray(12, 28));
    return JSON.parse(
      Buffer.concat([cipher.update(raw.subarray(28)), cipher.final()]).toString("utf8"),
    );
  }

  persist(state) {
    atomicWrite(this.file, {
      version: 1,
      sso: { ...withSsoDefaults(state.sso), clientSecret: this.encrypt(state.sso.clientSecret || "") },
      serviceUrls: state.serviceUrls,
    });
    atomicWrite(this.tagsFile, { version: 1, tags: state.tags });
  }

  // Publish state only after disk writes succeed.
  commit(mutate) {
    const next = structuredClone(this.state);
    const result = mutate(next);
    this.persist(next);
    this.state = next;
    return result;
  }

  ssoConfigured() {
    return ssoIsConfigured(this.state.sso);
  }

  seedSso(bootstrap) {
    if (this.ssoConfigured()) return;
    const seeded = validateSso(bootstrap, this.state.sso, { allowLocal: this.allowLocal });
    this.saveSso(seeded);
  }

  saveSso(candidate) {
    return this.commit((state) => {
      state.sso = candidate;
      return state.sso;
    });
  }

  viewSso(callbackUrl) {
    return sanitizeSso(this.state.sso, callbackUrl);
  }

  serviceUrls() {
    const result = {};
    for (const system of SYSTEMS)
      result[system] = this.state.serviceUrls[system] || DEFAULT_SERVICE_URLS[system];
    return result;
  }

  saveServiceUrls(input) {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new InputError("服务地址格式无效");
    return this.commit((state) => {
      for (const system of SYSTEMS) {
        if (input[system] === undefined) continue;
        const url = normalizeServiceUrl(input[system], {
          allowLocal: this.allowLocal,
          label: `${system} 服务地址`,
        });
        if (!url) delete state.serviceUrls[system];
        else state.serviceUrls[system] = url;
      }
      return state.serviceUrls;
    });
  }

  tags(id) {
    return [...(this.state.tags[id] || [])];
  }

  saveTags(id, input) {
    if (typeof id !== "string") throw new InputError("账号 ID 格式不正确");
    parseAccountId(id);
    const tags = normalizeTags(input);
    return this.commit((state) => {
      if (tags.length) state.tags[id] = tags;
      else delete state.tags[id];
      return [...tags];
    });
  }
}

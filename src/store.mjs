import { randomBytes, createCipheriv, createDecipheriv, createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { CHANNELS } from "./channels.mjs";
import { InputError } from "./http.mjs";
import { isAccountId } from "./account-id.mjs";
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

export const SYSTEMS = Object.freeze(CHANNELS.map(({ system }) => system));
export const DEFAULT_SERVICE_URLS = Object.freeze(
  Object.fromEntries(CHANNELS.map(({ system, defaultUrl }) => [system, defaultUrl])),
);

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
  if (!isAccountId(input))
    throw new InputError("账号 ID 须为 <system>:<原生 ID> 格式");
  const [system, ...rest] = input.split(":");
  return { system, nativeId: rest.join(":") };
}

export const compositeId = (system, nativeId) => `${system}:${nativeId}`;

const object = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const checksum = (buffer) => createHash("sha256").update(buffer).digest("hex");
const emptyState = () => ({ version: 1, sso: withSsoDefaults(DEFAULT_SSO), serviceUrls: {}, tags: {} });
const SCHEMA_MIGRATIONS = [
  `CREATE TABLE panel_settings (
     id INTEGER PRIMARY KEY CHECK (id = 1),
     sso TEXT NOT NULL,
     service_urls TEXT NOT NULL
   );
   CREATE TABLE account_tags (
     account_id TEXT NOT NULL,
     position INTEGER NOT NULL CHECK (position >= 0),
     tag TEXT NOT NULL,
     PRIMARY KEY (account_id, tag),
     UNIQUE (account_id, position)
   );
   CREATE TABLE legacy_imports (
     source TEXT PRIMARY KEY,
     checksum TEXT NOT NULL,
     backup TEXT NOT NULL,
     imported_at TEXT NOT NULL,
     completed INTEGER NOT NULL DEFAULT 0 CHECK (completed IN (0, 1))
   );`,
];

function parseStoredJson(value, label) {
  try {
    return JSON.parse(value);
  } catch {
    // JSON parser messages can include source text containing credentials.
    throw new Error(`Invalid ${label} JSON; restore the panel data backup`);
  }
}

// Panel-owned persistence only: SSO settings, service URL overrides and the
// user's account tags. Service data always stays inside each service container.
export class PanelStore {
  constructor(directory, { allowLocal = false, systems = CHANNELS } = {}) {
    this.directory = resolve(directory);
    mkdirSync(this.directory, { recursive: true, mode: 0o700 });
    this.allowLocal = allowLocal;
    this.systems = systems.map((entry) => typeof entry === "string" ? entry : entry.system);
    this.defaults = Object.fromEntries(systems.map((entry) => {
      const system = typeof entry === "string" ? entry : entry.system;
      return [system, typeof entry === "string" ? DEFAULT_SERVICE_URLS[system] || "" :
        entry.baseUrl || entry.defaultUrl || DEFAULT_SERVICE_URLS[system] || ""];
    }));
    this.file = join(this.directory, "panel.json");
    this.tagsFile = join(this.directory, "tags.json");
    this.databaseFile = join(this.directory, "panel.sqlite");
    const keyFile = join(this.directory, "master.key");
    if (!existsSync(keyFile)) {
      if (existsSync(this.file) || existsSync(this.databaseFile))
        throw new Error("data/panel/master.key is missing; restore the panel data backup");
      try {
        writeFileSync(keyFile, randomBytes(32), { mode: 0o600, flag: "wx", flush: true });
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
      }
    }
    this.key = readFileSync(keyFile);
    if (this.key.length !== 32)
      throw new Error("data/panel/master.key is invalid; restore the panel data backup");
    try {
      this.db = new DatabaseSync(this.databaseFile);
      chmodSync(this.databaseFile, 0o600);
      this.db.exec("PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;");
      this.initialize();
      this.finishLegacyBackups();
      this.state = this.load();
    } catch (error) {
      this.close();
      throw error;
    }
  }

  transaction(action) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = action();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  initialize() {
    this.transaction(() => {
      this.db.exec(`CREATE TABLE IF NOT EXISTS schema_version (
        version INTEGER PRIMARY KEY CHECK (version > 0), applied_at TEXT NOT NULL
      )`);
      const applied = this.db.prepare("SELECT version FROM schema_version ORDER BY version").all();
      if (applied.some((row, index) => row.version !== index + 1) || applied.length > SCHEMA_MIGRATIONS.length)
        throw new Error("Unsupported panel database schema; restore a compatible backup");
      for (let index = applied.length; index < SCHEMA_MIGRATIONS.length; index++) {
        this.db.exec(SCHEMA_MIGRATIONS[index]);
        this.db.prepare("INSERT INTO schema_version VALUES (?, ?)").run(index + 1, new Date().toISOString());
      }
      if (this.db.prepare("SELECT id FROM panel_settings WHERE id = 1").get()) return;
      if (this.db.prepare("SELECT 1 FROM account_tags UNION ALL SELECT 1 FROM legacy_imports LIMIT 1").get())
        throw new Error("Panel database settings are missing; restore the panel data backup");
      const imports = [];
      const readLegacy = (file, label) => {
        const data = readFileSync(file);
        const source = file === this.file ? "panel.json" : "tags.json";
        imports.push({ source, checksum: checksum(data), backup: `${source}.migrated-${Date.now()}.bak` });
        return parseStoredJson(data.toString("utf8"), label);
      };
      const state = this.loadLegacy(readLegacy);
      this.writeRows(state);
      const insert = this.db.prepare("INSERT INTO legacy_imports (source, checksum, backup, imported_at) VALUES (?, ?, ?, ?)");
      for (const imported of imports)
        insert.run(imported.source, imported.checksum, imported.backup, new Date().toISOString());
    });
  }

  loadLegacy(readLegacy) {
    const state = emptyState();
    if (existsSync(this.file)) {
      const saved = readLegacy(this.file, "legacy panel");
      if (!object(saved) || saved.version !== 1)
        throw new Error("Unsupported panel data version; restore the panel data backup");
      if (!object(saved.sso))
        throw new Error("Invalid panel SSO settings; restore the panel data backup");
      const sso = withSsoDefaults(saved.sso);
      if (saved.sso.clientSecret !== undefined && typeof saved.sso.clientSecret !== "string")
        throw new Error("Invalid panel SSO secret; restore the panel data backup");
      if (saved.sso.clientSecret) sso.clientSecret = this.decrypt(saved.sso.clientSecret);
      state.sso = sso;
      if (saved.serviceUrls !== undefined) {
        if (!object(saved.serviceUrls))
          throw new Error("Invalid panel service settings; restore the panel data backup");
        for (const [system, url] of Object.entries(saved.serviceUrls)) {
          const normalized = normalizeServiceUrl(url, {
            allowLocal: this.allowLocal,
            label: `${system} 服务地址`,
          });
          if (normalized) state.serviceUrls[system] = normalized;
        }
      }
    }
    if (existsSync(this.tagsFile)) {
      const saved = readLegacy(this.tagsFile, "legacy tags");
      if (!object(saved) || saved.version !== 1 || !object(saved.tags))
        throw new Error("Invalid panel tag store; restore the panel data backup");
      for (const [id, tags] of Object.entries(saved.tags)) {
        if (!isAccountId(id)) throw new Error("Invalid legacy account ID; restore the panel data backup");
        const normalized = normalizeTags(tags);
        if (normalized.length) state.tags[id] = normalized;
      }
    }
    return state;
  }

  finishLegacyBackups() {
    // SQLite commits before file renames. The manifest makes a crash between
    // these operations recoverable without reimporting or overwriting data.
    const imports = this.db.prepare("SELECT * FROM legacy_imports").all();
    for (const imported of imports) {
      if (!["panel.json", "tags.json"].includes(imported.source) ||
          !new RegExp(`^${imported.source.replace(".", "\\.")}\\.migrated-\\d+\\.bak$`).test(imported.backup))
        throw new Error("Invalid legacy import manifest; restore the panel data backup");
      const source = join(this.directory, imported.source);
      const backup = join(this.directory, imported.backup);
      if (imported.completed) {
        if (existsSync(source)) throw new Error("Legacy panel data reappeared after migration; preserve it and resolve the conflict before starting");
        continue;
      }
      if (existsSync(source)) {
        if (checksum(readFileSync(source)) !== imported.checksum)
          throw new Error("Legacy panel data changed during migration; preserve both copies before restarting");
        if (existsSync(backup)) throw new Error("Legacy panel backup already exists; preserve both copies before restarting");
        renameSync(source, backup);
      }
      if (!existsSync(backup) || checksum(readFileSync(backup)) !== imported.checksum)
        throw new Error("Legacy panel backup is missing or changed; restore it before restarting");
      this.transaction(() => this.db.prepare("UPDATE legacy_imports SET completed = 1 WHERE source = ?").run(imported.source));
    }
    // Never silently start with two independent sources of truth.
    for (const source of ["panel.json", "tags.json"])
      if (existsSync(join(this.directory, source)) && !imports.some((entry) => entry.source === source))
        throw new Error("Unimported legacy panel data exists beside SQLite; preserve both copies and resolve before starting");
  }

  load() {
    const row = this.db.prepare("SELECT sso, service_urls FROM panel_settings WHERE id = 1").get();
    if (!row) throw new Error("Panel settings are missing; restore the panel data backup");
    const state = emptyState();
    const saved = parseStoredJson(row.sso, "panel SSO");
    const urls = parseStoredJson(row.service_urls, "panel service settings");
    if (!object(saved) || !object(urls)) throw new Error("Invalid panel settings; restore the panel data backup");
    state.sso = withSsoDefaults(saved);
    state.sso.clientSecret = this.decrypt(saved.clientSecret);
    state.serviceUrls = urls;
    for (const row of this.db.prepare("SELECT account_id, tag FROM account_tags ORDER BY account_id, position").all())
      (state.tags[row.account_id] ??= []).push(row.tag);
    return state;
  }

  encrypt(value) {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(value), "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), data]).toString("base64");
  }

  decrypt(value) {
    try {
      const raw = Buffer.from(value, "base64");
      const cipher = createDecipheriv("aes-256-gcm", this.key, raw.subarray(0, 12));
      cipher.setAuthTag(raw.subarray(12, 28));
      const result = JSON.parse(Buffer.concat([cipher.update(raw.subarray(28)), cipher.final()]).toString("utf8"));
      if (typeof result !== "string") throw new Error("Invalid secret");
      return result;
    } catch {
      throw new Error("Cannot decrypt panel SSO secret; restore the matching master.key and panel data backup");
    }
  }

  writeRows(state) {
    const sso = { ...withSsoDefaults(state.sso), clientSecret: this.encrypt(state.sso.clientSecret || "") };
    this.db.prepare(`INSERT INTO panel_settings (id, sso, service_urls) VALUES (1, ?, ?)
      ON CONFLICT(id) DO UPDATE SET sso = excluded.sso, service_urls = excluded.service_urls`)
      .run(JSON.stringify(sso), JSON.stringify(state.serviceUrls));
    this.db.exec("DELETE FROM account_tags");
    const insert = this.db.prepare("INSERT INTO account_tags (account_id, position, tag) VALUES (?, ?, ?)");
    for (const [id, tags] of Object.entries(state.tags))
      tags.forEach((tag, position) => insert.run(id, position, tag));
  }

  persist(state) {
    this.transaction(() => this.writeRows(state));
  }

  // Publish state only after disk writes succeed.
  commit(mutate) {
    let next;
    const result = this.transaction(() => {
      // Read while holding the writer lock, so another store instance cannot
      // have its unrelated settings replaced by this instance's stale cache.
      next = this.load();
      const result = mutate(next);
      this.writeRows(next);
      return result;
    });
    this.state = next;
    return result;
  }

  close() {
    if (this.db && !this.closed) {
      this.db.close();
      this.closed = true;
    }
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
    for (const system of this.systems)
      result[system] = this.state.serviceUrls[system] || this.defaults[system];
    return result;
  }

  saveServiceUrls(input) {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new InputError("服务地址格式无效");
    return this.commit((state) => {
      for (const system of this.systems) {
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

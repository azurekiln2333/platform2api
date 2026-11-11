import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes, createCipheriv } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { PanelStore, parseAccountId, SYSTEMS, DEFAULT_SERVICE_URLS } from "../src/store.mjs";
import { CHANNELS } from "../src/channels.mjs";
import { DEFAULT_SSO } from "../src/sso.mjs";

function directory(t) {
  const value = mkdtempSync(join(tmpdir(), "platform-store-"));
  const opened = [];
  t.after(() => {
    for (const store of opened) store.close();
    rmSync(value, { recursive: true, force: true });
  });
  return { path: value, open(options) {
    const store = new PanelStore(value, options);
    opened.push(store);
    return store;
  } };
}

function legacyFixture(path, options = {}) {
  const key = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const secret = "fixture-secret-that-must-not-appear-in-sqlite";
  const encrypted = Buffer.concat([cipher.update(JSON.stringify(secret), "utf8"), cipher.final()]);
  const clientSecret = Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString("base64");
  const panel = {
    version: 1,
    sso: { ...DEFAULT_SSO, providerName: "Existing provider", clientSecret, allowedEmails: ["admin@example.test"] },
    serviceUrls: { cnb: "http://127.0.0.1:9902", future: "https://future.example.test" },
  };
  const tags = { version: 1, tags: { "cnb:old-1": ["production", "上海"], "fourth:account~2": ["future"] } };
  writeFileSync(join(path, "master.key"), key);
  writeFileSync(join(path, "panel.json"), options.panel ?? JSON.stringify(panel));
  writeFileSync(join(path, "tags.json"), options.tags ?? JSON.stringify(tags));
  return { secret, panel, tags };
}

test("panel data and encrypted SSO persist in SQLite with required pragmas", (t) => {
  const temp = directory(t);
  const store = temp.open();
  assert.equal(store.db.prepare("PRAGMA journal_mode").get().journal_mode, "wal");
  assert.equal(store.db.prepare("PRAGMA foreign_keys").get().foreign_keys, 1);
  assert.equal(store.db.prepare("PRAGMA busy_timeout").get().timeout, 5000);
  assert.deepEqual(store.db.prepare("SELECT version FROM schema_version").all().map((row) => row.version), [1]);
  store.saveTags("cnb:one", ["a", "b"]);
  store.saveServiceUrls({ cnb: "http://127.0.0.1:9902" });
  const secret = "new-client-secret-not-visible-on-disk";
  store.saveSso({ ...store.state.sso, clientSecret: secret, providerName: "Saved" });
  assert.equal(store.viewSso().hasClientSecret, true);
  assert.equal("clientSecret" in store.viewSso(), false);
  assert.equal(store.db.prepare("SELECT sso FROM panel_settings").get().sso.includes(secret), false);
  assert.equal(existsSync(join(temp.path, "panel.json")), false);
  assert.equal(existsSync(join(temp.path, "tags.json")), false);
  store.close();
  assert.equal(readFileSync(join(temp.path, "panel.sqlite")).includes(Buffer.from(secret)), false);
  const reopened = temp.open();
  assert.equal(reopened.state.sso.clientSecret, secret);
  assert.deepEqual(reopened.tags("cnb:one"), ["a", "b"]);
  assert.equal(reopened.serviceUrls().cnb, "http://127.0.0.1:9902");
});

test("legacy files import together, remain byte-identical backups, and do not reimport", (t) => {
  const temp = directory(t);
  const fixture = legacyFixture(temp.path);
  const panelBytes = readFileSync(join(temp.path, "panel.json"));
  const tagBytes = readFileSync(join(temp.path, "tags.json"));
  const store = temp.open();
  assert.equal(store.state.sso.clientSecret, fixture.secret);
  assert.equal(store.state.serviceUrls.future, "https://future.example.test");
  assert.deepEqual(store.tags("fourth:account~2"), ["future"]);
  assert.deepEqual(store.tags("cnb:old-1"), ["production", "上海"]);
  const backups = readdirSync(temp.path).filter((name) => name.endsWith(".bak"));
  assert.equal(backups.length, 2);
  assert.deepEqual(readFileSync(join(temp.path, backups.find((name) => name.startsWith("panel.json.")))), panelBytes);
  assert.deepEqual(readFileSync(join(temp.path, backups.find((name) => name.startsWith("tags.json.")))), tagBytes);
  assert.equal(existsSync(join(temp.path, "panel.json")), false);
  assert.equal(existsSync(join(temp.path, "tags.json")), false);
  store.saveTags("cnb:old-1", ["updated"]);
  store.close();
  const reopened = temp.open();
  assert.deepEqual(reopened.tags("cnb:old-1"), ["updated"]);
  assert.equal(reopened.db.prepare("SELECT COUNT(*) AS count FROM legacy_imports").get().count, 2);
  assert.deepEqual(readdirSync(temp.path).filter((name) => name.endsWith(".bak")), backups);
});

test("invalid legacy data fails startup without committing partial data or renaming files", (t) => {
  const temp = directory(t);
  legacyFixture(temp.path, { tags: '{"version":1,"tags":{"cnb:old-1":"invalid"}}' });
  const panelBytes = readFileSync(join(temp.path, "panel.json"));
  const tagBytes = readFileSync(join(temp.path, "tags.json"));
  assert.throws(() => temp.open(), /标签须为字符串数组/);
  assert.deepEqual(readFileSync(join(temp.path, "panel.json")), panelBytes);
  assert.deepEqual(readFileSync(join(temp.path, "tags.json")), tagBytes);
  const db = new DatabaseSync(join(temp.path, "panel.sqlite"));
  try {
    assert.equal(db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type='table'").get().count, 0);
  } finally { db.close(); }
  writeFileSync(join(temp.path, "tags.json"), JSON.stringify({ version: 1, tags: { "cnb:old-1": ["fixed"] } }));
  assert.deepEqual(temp.open().tags("cnb:old-1"), ["fixed"]);
});

test("invalid JSON reports no source text or secret", (t) => {
  const temp = directory(t);
  const secret = "do-not-print-this-client-secret";
  legacyFixture(temp.path, { panel: `{"clientSecret":"${secret}"` });
  assert.throws(() => temp.open(), (error) => /Invalid legacy panel JSON/.test(error.message) && !error.message.includes(secret));
  assert.equal(existsSync(join(temp.path, "panel.json")), true);
});

test("a restart completes backup renames after a committed import", (t) => {
  const temp = directory(t);
  legacyFixture(temp.path);
  class InterruptedStore extends PanelStore {
    finishLegacyBackups() { throw new Error("simulated crash before rename"); }
  }
  assert.throws(() => new InterruptedStore(temp.path), /simulated crash/);
  assert.equal(existsSync(join(temp.path, "panel.json")), true);
  const store = temp.open();
  assert.deepEqual(store.tags("cnb:old-1"), ["production", "上海"]);
  assert.equal(existsSync(join(temp.path, "panel.json")), false);
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM legacy_imports WHERE completed = 1").get().count, 2);
});

test("a restart recognizes files renamed before backup completion was recorded", (t) => {
  const temp = directory(t);
  legacyFixture(temp.path);
  class InterruptedStore extends PanelStore {
    finishLegacyBackups() {
      const imported = this.db.prepare("SELECT * FROM legacy_imports WHERE source='panel.json'").get();
      renameSync(join(this.directory, imported.source), join(this.directory, imported.backup));
      throw new Error("simulated crash after rename");
    }
  }
  assert.throws(() => new InterruptedStore(temp.path), /simulated crash/);
  assert.equal(existsSync(join(temp.path, "panel.json")), false);
  const store = temp.open();
  assert.equal(store.state.sso.providerName, "Existing provider");
  assert.equal(store.db.prepare("SELECT COUNT(*) AS count FROM legacy_imports WHERE completed = 1").get().count, 2);
});

test("changed legacy files after import cause a conflict without overwriting either copy", (t) => {
  const temp = directory(t);
  legacyFixture(temp.path);
  class InterruptedStore extends PanelStore {
    finishLegacyBackups() { throw new Error("simulated crash"); }
  }
  assert.throws(() => new InterruptedStore(temp.path), /simulated crash/);
  const replacement = JSON.stringify({ version: 1, tags: { "cnb:new": ["new"] } });
  writeFileSync(join(temp.path, "tags.json"), replacement);
  assert.throws(() => temp.open(), /changed during migration/);
  assert.equal(readFileSync(join(temp.path, "tags.json"), "utf8"), replacement);
});

test("SQLite failures roll back settings and tags and leave published state unchanged", (t) => {
  const temp = directory(t);
  const store = temp.open();
  store.saveTags("cnb:one", ["original"]);
  const before = structuredClone(store.state);
  store.db.exec("CREATE TRIGGER reject_tag BEFORE INSERT ON account_tags BEGIN SELECT RAISE(ABORT, 'disk fixture rejection'); END");
  assert.throws(() => store.saveServiceUrls({ cnb: "http://127.0.0.1:9999" }), /disk fixture rejection/);
  assert.deepEqual(store.state, before);
  assert.deepEqual(store.load(), before);
});

test("separate store instances do not overwrite unrelated changes", (t) => {
  const temp = directory(t);
  const first = temp.open();
  const second = temp.open();
  first.saveTags("cnb:one", ["first"]);
  second.saveServiceUrls({ cnb: "http://127.0.0.1:9999" });
  assert.deepEqual(second.tags("cnb:one"), ["first"]);
  first.saveTags("zcode:two", ["second"]);
  assert.equal(first.serviceUrls().cnb, "http://127.0.0.1:9999");
});

test("missing or mismatched encryption keys fail closed for existing SQLite", (t) => {
  const temp = directory(t);
  const store = temp.open();
  store.saveSso({ ...store.state.sso, clientSecret: "fixture secret" });
  store.close();
  const keyPath = join(temp.path, "master.key");
  rmSync(keyPath);
  assert.throws(() => temp.open(), /master.key is missing/);
  writeFileSync(keyPath, randomBytes(32));
  assert.throws(() => temp.open(), /Cannot decrypt/);
});

test("unsupported schemas fail startup without resetting data", (t) => {
  const temp = directory(t);
  const store = temp.open();
  store.saveTags("cnb:one", ["kept"]);
  store.db.prepare("INSERT INTO schema_version VALUES (2, ?)").run(new Date().toISOString());
  store.close();
  assert.throws(() => temp.open(), /Unsupported panel database schema/);
  const db = new DatabaseSync(join(temp.path, "panel.sqlite"));
  try { assert.equal(db.prepare("SELECT tag FROM account_tags").get().tag, "kept"); }
  finally { db.close(); }
});

test("channel defaults derive from the registry and a fourth channel round trips", (t) => {
  assert.deepEqual(SYSTEMS, CHANNELS.map((channel) => channel.system));
  assert.deepEqual(DEFAULT_SERVICE_URLS, Object.fromEntries(CHANNELS.map((channel) => [channel.system, channel.defaultUrl])));
  assert.deepEqual(parseAccountId("fourth_1:acc~123"), { system: "fourth_1", nativeId: "acc~123" });
  const temp = directory(t);
  const systems = [...CHANNELS, { system: "fourth_1", defaultUrl: "https://fourth.example.test" }];
  const store = temp.open({ systems });
  assert.equal(store.serviceUrls().fourth_1, "https://fourth.example.test");
  store.saveServiceUrls({ fourth_1: "https://custom.example.test" });
  store.saveTags("fourth_1:acc~123", ["dynamic"]);
  store.close();
  const reopened = temp.open({ systems });
  assert.equal(reopened.serviceUrls().fourth_1, "https://custom.example.test");
  assert.deepEqual(reopened.tags("fourth_1:acc~123"), ["dynamic"]);
});

test("native email and Unicode account IDs survive legacy import and SQLite restarts", (t) => {
  const temp = directory(t);
  const id = "zcode:中文 user+tag@example.test";
  legacyFixture(temp.path, { tags: JSON.stringify({ version: 1, tags: { [id]: ["production"] } }) });
  const store = temp.open();
  assert.deepEqual(parseAccountId(id), { system: "zcode", nativeId: "中文 user+tag@example.test" });
  assert.deepEqual(store.tags(id), ["production"]);
  store.saveTags(id, ["verified"]); store.close();
  assert.deepEqual(temp.open().tags(id), ["verified"]);
  for (const native of ["..", "../outside", "a\\b", "%2e%2e", "a\u0000b", "a\u007fb", "x".repeat(201)])
    assert.throws(() => parseAccountId(`zcode:${native}`));
});

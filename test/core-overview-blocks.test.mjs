import test from "node:test";
import assert from "node:assert/strict";
import { fakeAdapter, testPanel } from "./fixtures.mjs";
import { toEntry } from "../src/adapters/cnb.mjs";
import { SECTION_KINDS } from "../src/overview-sections.mjs";

const account = (system, index, extra = {}) => ({
  nativeId: `${system}-${index}`, label: `${system} 账号 ${index}`, status: "healthy", enabled: true,
  quota: { unit: "credits", total: 100, used: 25 }, ...extra,
});

test("GET /api/overview/:system derives blocks for a channel without its own builder", async (t) => {
  const p = await testPanel(t, {
    fourth: fakeAdapter("fourth", {
      overview: async () => ({ accounts: { total: 2, ready: 1 }, requestsToday: 4, tokensToday: 80, errorsToday: 1,
        quota: { unit: "credits", total: 200, used: 50, remaining: 150, syncedAt: "2026-11-11T00:00:00Z" },
        hourly: [{ hour: new Date().toISOString(), requests: 4, errors: 1 }] }),
      listAccounts: async () => [account("fourth", 1), account("fourth", 2, { status: "offline", enabled: true })],
    }),
  });
  const result = await p.request("/api/overview/fourth");
  assert.equal(result.status, 200);
  assert.equal(result.body.system, "fourth");
  assert.ok(result.body.generatedAt);
  assert.ok(Array.isArray(result.body.sections) && result.body.sections.length);
  for (const section of result.body.sections) assert.ok(SECTION_KINDS.includes(section.kind), section.kind);
  const ids = result.body.sections.map((section) => section.id);
  assert.ok(ids.includes("accounts") && ids.includes("today"));
  const quotaList = result.body.sections.find((section) => section.kind === "quotaList");
  assert.equal(quotaList.items.length, 2);
  // The adapter reported only total/used; the boundary derives `remaining`.
  assert.equal(quotaList.items[0].remaining, 75);
  assert.equal(quotaList.items[0].unit, "credits");
  const series = result.body.sections.find((section) => section.kind === "series");
  assert.equal(series.unit, "次");
  assert.equal(series.buckets.at(-1).values.请求, 4);
  // A per-system overview read must never probe the upstream service.
  assert.equal((await p.request("/api/overview/unknown")).status, 400);
});

test("adapter-declared blocks are normalized, redacted and never stall the poll", async (t) => {
  let healthCalls = 0;
  const p = await testPanel(t, {
    fourth: fakeAdapter("fourth", {
      health: async () => { healthCalls++; return { status: "ok" }; },
      overviewSections: async () => [
        { kind: "stats", id: "custom", title: "自定义区块", items: [
          { label: "剩余额度", value: 12, hint: "单位：credits", tone: "ok" },
          { label: "提示", value: "https://example.test/?token=DO-NOT-LEAK", hint: "Bearer DO-NOT-LEAK" },
        ] },
        { kind: "nonsense", id: "skip", title: "不支持的类型", items: [] },
        { kind: "table", id: "t", title: "明细", columns: [{ key: "a", label: "A", kind: "time" }, { key: "b", label: "B", kind: "nonsense" }], rows: [{ a: "x" }] },
      ],
    }),
  });
  const result = await p.request("/api/overview/fourth");
  assert.equal(result.status, 200);
  assert.deepEqual(result.body.sections.map((section) => section.id), ["custom", "t"]);
  assert.deepEqual(result.body.sections[1].columns, [{ key: "a", label: "A", kind: "time" }, { key: "b", label: "B" }]);
  const stats = result.body.sections[0].items;
  assert.equal(stats[0].tone, "ok");
  assert.equal(stats[1].hint, "Bearer [REDACTED]");
  assert.equal(stats[1].value, "https://example.test/?token=[REDACTED]");
  assert.equal(healthCalls, 0);
});

test("overview polling coalesces concurrent reads and serves a short cache", async (t) => {
  let overviewCalls = 0;
  const p = await testPanel(t, {
    fourth: fakeAdapter("fourth", {
      overview: async () => { overviewCalls++; return { requestsToday: 1, hourly: [] }; },
    }),
  }, { overviewCacheMs: 60_000 });
  const [a, b, c] = await Promise.all([p.request("/api/overview"), p.request("/api/overview"), p.request("/api/overview")]);
  assert.equal(a.status, 200); assert.equal(b.status, 200); assert.equal(c.status, 200);
  assert.equal(overviewCalls, 1);
  await p.request("/api/overview");
  assert.equal(overviewCalls, 1);
  // The per-system endpoint has its own cache entry and reads its own channel.
  await p.request("/api/overview/fourth");
  assert.equal(overviewCalls, 2);
});

test("a slow channel is cut off on its own deadline instead of blocking the page", async (t) => {
  const p = await testPanel(t, {
    fast: fakeAdapter("fast"),
    slow: fakeAdapter("slow", { overview: () => new Promise(() => {}), overviewSections: undefined }),
  }, { overviewTimeoutMs: 60 });
  const aggregate = await p.request("/api/overview");
  assert.equal(aggregate.status, 200);
  assert.equal(aggregate.body.fast.ok, true);
  assert.equal(aggregate.body.errors.find((error) => error.system === "slow").code, "upstream_timeout");
  const detail = await p.request("/api/overview/slow");
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.body.sections, []);
  assert.equal(detail.body.error.code, "upstream_timeout");
});

test("channel actions are declared in capabilities and fan out with bounded concurrency", async (t) => {
  let active = 0, peak = 0;
  const rows = Array.from({ length: 10 }, (_, index) => account("fourth", index));
  rows.push(account("fourth", 11, { enabled: false }), account("fourth", 12, { status: "disabled" }));
  const p = await testPanel(t, {
    fourth: fakeAdapter("fourth", {
      channelActions: [{ id: "wake-all", label: "唤醒全部工作区", accountAction: "wake" }],
      listAccounts: async () => rows,
      accountAction: async (id, action) => {
        active++; peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 5));
        active--;
        if (id === "fourth-3") throw new Error("upstream said no");
        return { id, action };
      },
    }),
  });
  const channels = (await p.request("/api/channels")).body;
  assert.deepEqual(channels[0].capabilities.accounts.channelActions, [{ id: "wake-all", label: "唤醒全部工作区" }]);
  const result = await p.request("/api/channels/fourth/actions/wake-all", { method: "POST", body: {} });
  assert.equal(result.status, 200);
  assert.equal(result.body.total, 10);
  assert.equal(result.body.started, 9);
  assert.equal(result.body.failed.length, 1);
  assert.equal(result.body.failed[0].id, "fourth:fourth-3");
  assert.equal(result.body.failed[0].message, "服务读取失败");
  assert.ok(peak <= 4, `concurrency peaked at ${peak}`);
  assert.ok(peak > 1, "fan-out must run in parallel");
  // Only declared operations are reachable, and unknown channels are rejected.
  assert.equal((await p.request("/api/channels/fourth/actions/delete-all", { method: "POST", body: {} })).status, 404);
  assert.equal((await p.request("/api/channels/unknown/actions/wake-all", { method: "POST", body: {} })).status, 400);
});

test("channels that declare no channel action advertise an empty list", async (t) => {
  const p = await testPanel(t, { fourth: fakeAdapter("fourth") });
  const channels = (await p.request("/api/channels")).body;
  assert.deepEqual(channels[0].capabilities.accounts.channelActions, []);
});

test("CNB accounts expose quick actions, a linked repository and remaining quota", async () => {
  const entry = toEntry({
    id: "7dde1520-0883-4a1f-9a54-0e28f8a1f000",
    name: "CNB 主账号",
    repo: "Quverse12/cnb2api",
    status: "healthy",
    enabled: true,
    endpoint: "https://7dde1520-0883-9001.cnb.run",
    quota: { credits: { total: 1000, used: 250, freeze: 50 }, syncedAt: "2026-11-11T00:00:00Z" },
    hasPat: true,
    hasProxyKey: true,
  });
  assert.deepEqual(entry.actions.filter((action) => action.quick).map((action) => action.id), ["probe", "quota", "wake"]);
  const repo = entry.display.find((field) => field.key === "repo");
  assert.equal(repo.kind, "link");
  assert.equal(repo.href, "https://cnb.cool/Quverse12/cnb2api");
  assert.equal(entry.quota.remaining, 700);
  assert.equal(entry.quota.unit, "credits");
  const noRepo = toEntry({ id: "b", name: "无仓库", status: "pending" });
  assert.equal(noRepo.display.find((field) => field.key === "repo").kind, "mono");
  assert.equal(noRepo.display.find((field) => field.key === "repo").href, undefined);
});

test("account quota normalization derives remaining for every channel", async (t) => {
  const p = await testPanel(t, {
    fourth: fakeAdapter("fourth", {
      listAccounts: async () => [
        account("fourth", 1, { quota: { unit: "credits", total: 100, used: 30 } }),
        account("fourth", 2, { quota: { unit: "credits", total: 100, remaining: 40 } }),
        account("fourth", 3, { quota: null }),
      ],
    }),
  });
  const items = (await p.request("/api/accounts?system=fourth")).body.items;
  assert.equal(items[0].quota.remaining, 70);
  assert.equal(items[1].quota.remaining, 40);
  assert.equal(items[1].quota.used, undefined);
  assert.equal(items[2].quota, null);
});
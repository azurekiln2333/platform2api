import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { once } from 'node:events';

const TOKEN = 'codebuddy-platform-token-0123456789';

/**
 * Stand-in for codebuddy2api's /admin contract. It pins the states the
 * inventory calls out: bearer-only auth, revisioned settings (409), an
 * unavailable audit store (503) and cursor-paginated logs.
 */
async function service(t, handlers = {}) {
  const state = { calls: [], revision: 7, auditUnavailable: false, token: TOKEN };
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://service.local');
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const raw = Buffer.concat(chunks).toString('utf8');
    const body = raw ? JSON.parse(raw) : null;
    state.calls.push({ method: req.method, path: url.pathname, query: url.search, headers: req.headers, body });

    const send = (status, payload) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify(payload));
    };

    if (req.headers.authorization !== `Bearer ${state.token}`) {
      return send(401, { detail: '管理认证无效或会话已过期' });
    }
    const custom = handlers[`${req.method} ${url.pathname}`];
    if (custom) return custom({ req, res, url, body, state, send });

    if (req.method === 'GET' && url.pathname === '/admin/session') {
      return send(200, { authenticated: true, csrf_token: null });
    }
    if (req.method === 'GET' && url.pathname === '/admin/dashboard') {
      if (state.auditUnavailable) return send(503, { detail: '审计数据不可用' });
      return send(200, {
        totals: { requests: 12, credits: null },
        health: { status: 'ok' },
        storage: { path: '/data/auth' },
      });
    }
    if (req.method === 'GET' && url.pathname === '/admin/credentials') {
      return send(200, {
        credentials: [
          { name: 'acc-1.json', nickname: '主账号', enabled: true, tags: ['vip'] },
          { name: 'acc-2.json', enabled: false },
          { name: 'acc/3', cooldown_until: '2026-11-10T00:00:00Z' },
        ],
      });
    }
    if (req.method === 'PATCH' && url.pathname.startsWith('/admin/credentials/')) {
      return send(200, { ok: true });
    }
    if (req.method === 'DELETE' && url.pathname.startsWith('/admin/credentials/')) {
      return send(200, { ok: true });
    }
    if (req.method === 'POST' && url.pathname === '/admin/oauth/start') {
      return send(200, { login_id: 'flow-1', verification_uri: 'https://example.com/oauth' });
    }
    if (req.method === 'GET' && url.pathname === '/admin/oauth/poll') {
      return send(200, { done: false });
    }
    if (req.method === 'GET' && url.pathname === '/admin/keys') {
      return send(200, { external: true, items: [{ id: 'k1' }] });
    }
    if (req.method === 'GET' && url.pathname === '/admin/models') {
      return send(200, { revision: state.revision, models: [{ id: 'gpt-x' }] });
    }
    if (req.method === 'GET' && url.pathname === '/admin/settings') {
      return send(200, { revision: state.revision, items: [{ key: 'audit_max_bytes', value: 1024 }] });
    }
    if (req.method === 'PATCH' && url.pathname === '/admin/settings') {
      if (body.revision !== state.revision) return send(409, { detail: '配置已更新，请刷新后重试' });
      state.revision += 1;
      return send(200, { revision: state.revision, applied: Object.keys(body.values || {}) });
    }
    if (req.method === 'GET' && url.pathname === '/admin/logs') {
      return send(200, { items: [{ id: 'log-1' }], next_cursor: 'c2' });
    }
    return send(404, { detail: 'not found' });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  return { state, baseUrl: `http://127.0.0.1:${server.address().port}` };
}

/** Build the adapter exactly the way the registry does. */
async function adapterFor(context, overrides = {}) {
  const { createRegistry } = await import('../src/adapters/index.mjs');
  const registry = await createRegistry({
    systems: [{ system: 'codebuddy', baseUrl: context.baseUrl, token: context.token, timeoutMs: 5000 }],
    ...overrides,
  });
  return registry.get('codebuddy');
}

test('the registry loads this module instead of the stub', async (t) => {
  const { baseUrl } = await service(t);
  const { createRegistry } = await import('../src/adapters/index.mjs');
  const registry = await createRegistry({
    systems: [{ system: 'codebuddy', baseUrl, token: TOKEN }],
    logger: { warn() {}, error(message) { throw new Error(message); } },
  });
  assert.equal(registry.isStub('codebuddy'), false);
  assert.equal(registry.get('codebuddy').system, 'codebuddy');
});

test('health distinguishes a reachable service from a rejected token', async (t) => {
  const { baseUrl } = await service(t);
  assert.deepEqual(await (await adapterFor({ baseUrl, token: TOKEN })).health(), { status: 'ok' });

  const rejected = await adapterFor({ baseUrl, token: 'wrong-token-value-000' });
  const health = await rejected.health();
  assert.equal(health.status, 'down');
  assert.match(health.detail, /PLATFORM_TOKEN/);
});

test('an unreachable service reports down without throwing', async () => {
  const adapter = await adapterFor({ baseUrl: 'http://127.0.0.1:1', token: TOKEN });
  const health = await adapter.health();
  assert.equal(health.status, 'down');
  assert.ok(health.detail);
});

test('credentials normalize to the panel account contract', async (t) => {
  const { baseUrl } = await service(t);
  const accounts = await (await adapterFor({ baseUrl, token: TOKEN })).listAccounts();

  assert.deepEqual(accounts.map((account) => account.nativeId), ['acc-1.json', 'acc-2.json', 'acc_3']);
  const [first, second, third] = accounts;
  assert.equal(first.label, '主账号');
  assert.equal(first.status, 'ready');
  assert.equal(first.enabled, true);
  assert.deepEqual(first.tags, ['vip'], 'the system tag is added by accounts.mjs, not here');

  assert.equal(second.status, 'disabled');
  assert.equal(second.enabled, false);
  assert.equal(third.status, 'cooldown');
});

test('native ids stay inside the panel id grammar', async (t) => {
  const { baseUrl } = await service(t);
  const accounts = await (await adapterFor({ baseUrl, token: TOKEN })).listAccounts();
  for (const account of accounts) {
    assert.match(account.nativeId, /^[A-Za-z0-9._:-]{1,200}$/);
  }
});

test('overview keeps this system\'s own numbers and units', async (t) => {
  const { baseUrl } = await service(t);
  const overview = await (await adapterFor({ baseUrl, token: TOKEN })).overview({ days: 30 });

  assert.equal(overview.system, 'codebuddy');
  assert.equal(overview.days, 30);
  assert.equal(overview.requests, 12);
  assert.equal(overview.credits, null);
  assert.deepEqual(overview.storage, { path: '/data/auth' });
});

test('an unavailable audit store throws instead of reporting zero usage', async (t) => {
  const { baseUrl, state } = await service(t);
  state.auditUnavailable = true;

  const adapter = await adapterFor({ baseUrl, token: TOKEN });
  await assert.rejects(
    () => adapter.overview(),
    (error) => error.code === 'upstream_unavailable' && /503/.test(error.message),
  );
});

test('credential updates accept exactly one supported field', async (t) => {
  const { baseUrl, state } = await service(t);
  const adapter = await adapterFor({ baseUrl, token: TOKEN });

  await adapter.accountAction('acc-2.json', 'update', { enabled: true });
  const patch = state.calls.find((call) => call.method === 'PATCH');
  assert.deepEqual(patch.body, { enabled: true });

  await assert.rejects(() => adapter.accountAction('acc-2.json', 'update', { enabled: true, auto_travel: true }),
    (error) => error.status === 400 && error.name === 'InputError');
  await assert.rejects(() => adapter.accountAction('acc-2.json', 'update', { nickname: 'x' }),
    (error) => error.status === 400);
  await assert.rejects(() => adapter.accountAction('acc-2.json', 'probe', {}),
    (error) => error.status === 400);
});

test('credential delete targets the native name', async (t) => {
  const { baseUrl, state } = await service(t);
  await (await adapterFor({ baseUrl, token: TOKEN })).accountAction('acc-1.json', 'delete');
  assert.ok(state.calls.some((call) => call.method === 'DELETE' && call.path === '/admin/credentials/acc-1.json'));
});

test('enrollment start/poll map onto flowId and status', async (t) => {
  const { baseUrl, state } = await service(t);
  const adapter = await adapterFor({ baseUrl, token: TOKEN });

  const started = await adapter.startAuth({ site: 'intl' });
  assert.equal(started.flowId, 'flow-1');
  assert.equal(started.verificationUri, 'https://example.com/oauth');
  const startCall = state.calls.find((call) => call.path === '/admin/oauth/start');
  assert.match(startCall.query, /site=intl/);

  assert.equal((await adapter.pollAuth('flow-1')).status, 'pending');
  await assert.rejects(() => adapter.pollAuth(''), (error) => error.status === 400);
});

test('a completed enrollment reports done with the imported credential', async (t) => {
  const done = ({ send }) => send(200, { done: true, uid: 'u1', nickname: '小明', imported: 'acc-9.json' });
  const failed = ({ send }) => send(200, { done: true, error: 'OAuth 登录失败，请重新发起' });
  const { baseUrl: okBase } = await service(t, { 'GET /admin/oauth/poll': done });
  const { baseUrl: badBase } = await service(t, { 'GET /admin/oauth/poll': failed });

  const ok = await (await adapterFor({ baseUrl: okBase, token: TOKEN })).pollAuth('flow');
  assert.equal(ok.status, 'done');
  assert.equal(ok.nickname, '小明');
  assert.equal(ok.imported, 'acc-9.json');

  const bad = await (await adapterFor({ baseUrl: badBase, token: TOKEN })).pollAuth('flow');
  assert.equal(bad.status, 'error');
});

test('keys and models keep their service envelopes', async (t) => {
  const { baseUrl } = await service(t);
  const adapter = await adapterFor({ baseUrl, token: TOKEN });

  assert.deepEqual(await adapter.listKeys(), { external: true, items: [{ id: 'k1' }] });
  const models = await adapter.listModels();
  assert.equal(models.revision, 7);
  assert.deepEqual(models.models, [{ id: 'gpt-x' }]);
});

test('settings writes stay revision aware and surface 409 untouched', async (t) => {
  const { baseUrl } = await service(t);
  const adapter = await adapterFor({ baseUrl, token: TOKEN });

  const current = await adapter.getSettings();
  assert.equal(current.revision, 7);

  const written = await adapter.patchSettings({ audit_max_bytes: 2048 }, current.revision);
  assert.equal(written.revision, 8);

  await assert.rejects(
    () => adapter.patchSettings({ audit_max_bytes: 4096 }, 7),
    (error) => error.status === 409 && error.code === 'revision_conflict',
  );
});

test('log pagination clamps the limit to the service window', async (t) => {
  const { baseUrl, state } = await service(t);
  const adapter = await adapterFor({ baseUrl, token: TOKEN });

  const page = await adapter.listLogs({ kind: 'credit', limit: 9999, cursor: 'c1' });
  assert.deepEqual(page.items, [{ id: 'log-1' }]);
  assert.equal(page.nextCursor, 'c2');
  const query = state.calls.find((call) => call.path === '/admin/logs').query;
  assert.match(query, /limit=200/);
  assert.match(query, /kind=credit/);
  assert.match(query, /cursor=c1/);

  await adapter.listLogs({ kind: 'nope', limit: 0 });
  const clamped = state.calls.filter((call) => call.path === '/admin/logs').pop().query;
  assert.match(clamped, /kind=request/);
  assert.match(clamped, /limit=50/);
});

test('passthrough preserves the service status so 409 stays a conflict', async (t) => {
  const { baseUrl } = await service(t);
  const adapter = await adapterFor({ baseUrl, token: TOKEN });

  const conflict = await adapter.call('/admin/settings', { method: 'PATCH', body: { values: {}, revision: 1 } });
  assert.equal(conflict.status, 409);

  const missing = await adapter.call('/admin/unknown');
  assert.equal(missing.status, 404);
  assert.equal(missing.body.detail, 'not found');
});

test('passthrough refuses absolute and traversal paths', async (t) => {
  const { baseUrl } = await service(t);
  const adapter = await adapterFor({ baseUrl, token: TOKEN });
  await assert.rejects(() => adapter.call('http://evil.example/x'), (error) => error.status === 400);
  await assert.rejects(() => adapter.call('/admin/../../etc/passwd'), (error) => error.status === 400);
});

test('the bearer credential is sent and never echoed to the panel', async (t) => {
  const { baseUrl, state } = await service(t);
  const adapter = await adapterFor({ baseUrl, token: TOKEN });
  const session = await adapter.call('/admin/session');

  assert.equal(state.calls[0].headers.authorization, `Bearer ${TOKEN}`);
  assert.ok(!JSON.stringify(session).includes(TOKEN));
});

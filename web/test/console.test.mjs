import assert from 'node:assert/strict'
import test from 'node:test'
import { parseRoute, routeHash, SHELL_NAV } from '../src/routes.ts'
import { registerSystems, systemMeta, systemTag, countBySystem } from '../src/systems.ts'
import { redact } from '../src/redact.ts'
test('exactly six pages and every old page redirects with a channel filter', () => {
  assert.deepEqual(
    SHELL_NAV.map((item) => item.id),
    ['overview', 'accounts', 'keys', 'models', 'logs', 'settings'],
  )
  for (const [old, page] of Object.entries({
    overview: 'overview',
    accounts: 'accounts',
    enroll: 'accounts',
    enrollment: 'accounts',
    keys: 'keys',
    access: 'keys',
    models: 'models',
    logs: 'logs',
    usage: 'logs',
    ops: 'settings',
    settings: 'settings',
  })) {
    const next = parseRoute(`#extra-channel/${old}?q=test`)
    assert.equal(next.page, page)
    assert.equal(next.query.system, 'extra-channel')
    assert.equal(next.query.q, 'test')
  }
  assert.equal(parseRoute('#cnb/does-not-exist').hash, '#overview')
  assert.equal(parseRoute('#no-such-page').hash, '#overview')
  assert.equal(parseRoute('#codebuddy/usage').query.tab, 'usage')
})
test('hash filters round-trip without losing unicode or colons', () => {
  const hash = routeHash('logs', {
    system: 'fourth',
    account: 'fourth:a:b',
    q: '测试 & 空格',
    via: 'unified',
    empty: undefined,
  })
  assert.deepEqual(parseRoute(hash).query, {
    system: 'fourth',
    account: 'fourth:a:b',
    q: '测试 & 空格',
    via: 'unified',
  })
})
test('channel helpers support an arbitrary registry and fourth channel', () => {
  registerSystems([{ system: 'new-provider', label: '新渠道' }])
  assert.equal(systemMeta('new-provider').label, '新渠道')
  assert.equal(systemTag('new-provider'), 'new-provider')
  assert.deepEqual(
    countBySystem([
      { id: 'new-provider:1', system: 'new-provider', tags: [], label: 'test', status: 'ok' },
    ]),
    { 'new-provider': 1 },
  )
})
test('diagnostic details redact nested credentials without changing counts', () => {
  assert.deepEqual(
    redact({
      requests: 5,
      headers: { Authorization: 'secret', cookie: 'session' },
      child: [{ access_token: 'secret', model: 'ok' }],
    }),
    {
      requests: 5,
      headers: { Authorization: '[已隐藏]', cookie: '[已隐藏]' },
      child: [{ access_token: '[已隐藏]', model: 'ok' }],
    },
  )
})

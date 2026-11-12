import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MAX_TAGS,
  registerSystems,
  allTags,
  countBySystem,
  filterAccounts,
  normalizeAccount,
  normalizeAccountList,
  normalizeAccountsErrors,
  normalizeTags,
  overviewCards,
  parseAccountId,
  quotaPercent,
  quotaProgress,
  serviceHealth,
  serviceInfo,
  statusLabel,
  statusTone,
  systemCard,
  systemTag,
} from '../src/systems.ts'

registerSystems([
  { system: 'cnb', label: 'CNB' },
  { system: 'codebuddy', label: 'CodeBuddy' },
  { system: 'zcode', label: 'ZCode' },
])

const overviewPayload = {
  cnb: {
    health: 'ok',
    accounts: { total: 4, ready: 3 },
    quota: {
      label: '组织额度',
      unit: ' credits',
      total: 2000,
      used: 500,
      remaining: 1500,
      syncedAt: '2026-11-09T10:00:00.000Z',
      metrics: [{ label: '开发额度', unit: ' credits', total: 100, used: 10, remaining: 90 }],
    },
    usage: [{ label: '今日请求', value: 42 }],
  },
  codebuddy: {
    health: 'degraded',
    accounts: { total: 2, ready: 1 },
    quota: { label: '积分', unit: ' 积分', total: 800, used: 200, remaining: 600 },
  },
  zcode: { error: { message: 'zcode 服务不可达' } },
}

test('overview keeps one card per system and never adds them together', () => {
  const cards = overviewCards(overviewPayload)
  assert.deepEqual(
    cards.map((card) => card.system),
    ['cnb', 'codebuddy', 'zcode'],
  )
  assert.equal(cards[0].quota.remaining, 1500)
  assert.equal(cards[0].quota.unit, ' credits')
  assert.equal(cards[1].quota.remaining, 600)
  assert.equal(cards[1].quota.unit, ' 积分')
  // Different units: a total would be meaningless, so no card exposes one.
  assert.equal('combined' in cards[0], false)
  assert.equal(cards[0].quota.metrics[0].remaining, 90)
  assert.equal(cards[0].usage[0].value, 42)
})

test('a failing system only blanks its own card', () => {
  const cards = overviewCards(overviewPayload)
  const zcode = cards.find((card) => card.system === 'zcode')
  assert.equal(zcode.available, false)
  assert.equal(zcode.error, 'zcode 服务不可达')
  assert.equal(zcode.quota, null)
  assert.equal(cards[0].available, true)
  assert.equal(cards[1].available, true)
})

test('missing overview data degrades to an unavailable card instead of throwing', () => {
  assert.equal(overviewCards(undefined).length, 3)
  assert.equal(systemCard('cnb', null).available, false)
  assert.equal(systemCard('cnb', { health: 'weird' }).health, 'unknown')
  assert.equal(systemCard('cnb', { error: 'boom' }).error, 'boom')
})

test('accounts are normalized from an envelope or a bare array', () => {
  const list = normalizeAccountList({
    accounts: [
      { id: 'cnb:a1', system: 'cnb', label: '主账号', status: 'healthy', tags: ['主力'] },
      { id: 'codebuddy:b:2', system: 'codebuddy', label: 'CB', status: 'pending' },
      { id: 'unknown:c1', label: 'dropped' },
      null,
    ],
  })
  assert.equal(list.length, 2)
  assert.equal(list[0].tags[0], systemTag('cnb'))
  assert.equal(list[0].tags[1], '主力')
  assert.equal(list[1].id, 'codebuddy:b:2')
  assert.equal(list[1].label, 'CB')
  assert.equal(normalizeAccountList([{ id: 'zcode:z1', system: 'zcode', label: 'Z' }]).length, 1)
  assert.equal(normalizeAccountList('nope').length, 0)
})

test('system tag is automatic and cannot be duplicated by a user tag', () => {
  const account = normalizeAccount({
    id: 'zcode:z1',
    system: 'zcode',
    label: 'Z',
    tags: ['zcode', '付费', '付费'],
  })
  assert.deepEqual(account.tags, ['zcode', '付费'])
  assert.deepEqual(normalizeTags(['cnb', 'cnb', '团队']), ['团队'])
  assert.deepEqual(normalizeTags(['ok', 'ok', 'ok2']), ['ok', 'ok2'])
  assert.equal(
    normalizeTags(Array.from({ length: 30 }, (_, index) => `t${index}`)).length,
    MAX_TAGS,
    registerSystems,
  )
})

test('parseAccountId keeps colons inside the native id', () => {
  assert.deepEqual(parseAccountId('cnb:a1'), { system: 'cnb', nativeId: 'a1' })
  assert.deepEqual(parseAccountId('zcode:team:9'), { system: 'zcode', nativeId: 'team:9' })
  assert.deepEqual(parseAccountId('nonsense'), { system: null, nativeId: 'nonsense' })
})

test('filters combine system, tag and query', () => {
  const accounts = normalizeAccountList([
    { id: 'cnb:a1', system: 'cnb', label: '主力工作区', status: 'healthy', tags: ['主力'] },
    { id: 'codebuddy:b1', system: 'codebuddy', label: '测试', status: 'pending', tags: ['测试'] },
    { id: 'zcode:z1', system: 'zcode', label: '主号', status: 'healthy', tags: ['主力'] },
  ])
  assert.deepEqual(
    filterAccounts(accounts, { system: 'all', tag: '' }).map((item) => item.id),
    ['cnb:a1', 'codebuddy:b1', 'zcode:z1'],
  )
  assert.deepEqual(
    filterAccounts(accounts, { system: 'cnb', tag: '' }).map((item) => item.id),
    ['cnb:a1'],
  )
  assert.deepEqual(
    filterAccounts(accounts, { system: 'all', tag: '主力' }).map((item) => item.id),
    ['cnb:a1', 'zcode:z1'],
  )
  assert.deepEqual(
    filterAccounts(accounts, { system: 'all', tag: '主力', query: '工作区' }).map(
      (item) => item.id,
    ),
    ['cnb:a1'],
  )
  // System tags are real tags on the row, so they are offered as filters too.
  assert.deepEqual(
    allTags(accounts),
    ['codebuddy', 'cnb', 'zcode', '主力', '测试'].sort((a, b) => a.localeCompare(b, 'zh-CN')),
  )
  assert.deepEqual(countBySystem(accounts), { cnb: 1, codebuddy: 1, zcode: 1 })
})

test('the panel server card shape (flat, with ok/detail/health) is read as-is', () => {
  const cards = overviewCards({
    generatedAt: '2026-11-09T10:00:00.000Z',
    cnb: {
      system: 'cnb',
      ok: true,
      health: 'ok',
      detail: '',
      accounts: { total: 2, ready: 1, paused: 0 },
      quota: { label: 'CNB 组织额度', unit: 'credits', total: 10, used: 4, remaining: 6 },
    },
    codebuddy: { system: 'codebuddy', ok: true, health: 'degraded', healthMessage: '审计不可用' },
    zcode: {
      system: 'zcode',
      ok: false,
      health: 'down',
      detail: '服务不可达',
      healthMessage: '服务不可达',
      error: { message: '服务不可达', code: 'upstream_error' },
    },
  })
  const cnb = cards.find((card) => card.system === 'cnb')
  assert.equal(cnb.available, true)
  assert.equal(cnb.quota.remaining, 6)
  assert.equal(cnb.accounts.paused, 0)
  const codebuddy = cards.find((card) => card.system === 'codebuddy')
  assert.equal(codebuddy.health, 'degraded')
  assert.equal(codebuddy.healthMessage, '审计不可用')
  // `down` is the panel's health token for an unreachable service.
  const zcode = cards.find((card) => card.system === 'zcode')
  assert.equal(zcode.available, false)
  assert.equal(zcode.health, 'offline')
  assert.equal(zcode.error, '服务不可达')
})

test('settings read a systems array, a services map and a urls fallback', () => {
  const settings = {
    serviceUrls: { zcode: 'http://zcode:12283' },
    systems: [
      { system: 'cnb', url: 'http://cnb:9002', tokenConfigured: true },
      { system: 'codebuddy', tokenConfigured: true, stub: true },
    ],
  }
  assert.equal(serviceInfo(settings, 'cnb').tokenConfigured, true)
  assert.equal(serviceInfo(settings, 'codebuddy').stub, true)
  assert.equal(serviceInfo(settings, 'zcode').url, 'http://zcode:12283')
  assert.equal(serviceInfo(null, 'cnb'), null)
  assert.equal(serviceHealth({ health: 'down' }), 'offline')
  assert.equal(serviceHealth({ health: 'healthy' }), 'ok')
  assert.equal(serviceHealth({}), null)
})

test('per-system account read failures stay isolated', () => {
  assert.deepEqual(
    normalizeAccountsErrors([
      { system: 'codebuddy', error: { message: '凭证读取失败', code: 'upstream_error' } },
      { system: 'zcode', error: '服务不可达' },
      { system: 'nope', error: 'ignored' },
      null,
    ]),
    [
      { system: 'codebuddy', error: { message: '凭证读取失败', code: 'upstream_error' } },
      { system: 'zcode', error: { message: '服务不可达' } },
    ],
  )
  assert.deepEqual(normalizeAccountsErrors(undefined), [])
})

test('quota percent prefers an explicit value and stays inside 0-100', () => {
  assert.equal(quotaPercent({ total: 100, used: 25 }), 25)
  assert.equal(quotaPercent({ total: 0, used: 25 }), null)
  assert.equal(quotaPercent({ percent: 140 }), 100)
  assert.equal(quotaPercent({ percent: -3 }), 0)
  assert.equal(quotaPercent(null), null)
})

// F4: the console shows "remaining / total" and the bar length is that share.
test('quota progress shows the remaining share of the total', () => {
  assert.deepEqual(quotaProgress({ total: 1000, used: 680, remaining: 320 }), {
    remaining: 320,
    total: 1000,
    percent: 32,
    tone: 'ok',
  })
  // A server that only sends used/total still gets a remaining value.
  assert.deepEqual(quotaProgress({ total: 1000, used: 980 }), {
    remaining: 20,
    total: 1000,
    percent: 2,
    tone: 'low',
  })
  assert.equal(quotaProgress({ total: 100, used: 85 }).tone, 'warn')
  assert.equal(quotaProgress({ remaining: 0, total: 100 }).tone, 'low')
  // No total means no bar: the caller must fall back to text only.
  assert.deepEqual(quotaProgress({ remaining: 320 }), {
    remaining: 320,
    total: null,
    percent: null,
    tone: 'ok',
  })
  assert.equal(quotaProgress({ percent: 90, total: 100 }).remaining, 10)
  assert.equal(quotaProgress({ total: 100, remaining: 500 }).percent, 100)
  assert.equal(quotaProgress({ total: 100, used: 500 }).remaining, 0)
  assert.equal(quotaProgress(null).percent, null)
})

// F8: only "normal" is green; a cooling account warns instead.
test('cooling reads as a warning tone, not a healthy one', () => {
  assert.equal(statusLabel('cooling'), '冷却中')
  assert.equal(statusTone('cooling'), 'amber')
  assert.equal(statusTone('quota'), 'amber')
  assert.equal(statusTone('healthy'), 'green')
  assert.equal(statusTone('ready'), 'green')
  assert.equal(statusTone('offline'), 'gray')
  assert.equal(statusTone('unknown'), 'slate')
})

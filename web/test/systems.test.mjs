import assert from 'node:assert/strict'
import test from 'node:test'
import {
  MAX_TAGS,
  allTags,
  countBySystem,
  filterAccounts,
  normalizeAccount,
  normalizeAccountList,
  normalizeTags,
  overviewCards,
  parseAccountId,
  quotaPercent,
  systemCard,
  systemTag,
} from '../src/systems.ts'

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

test('quota percent prefers an explicit value and stays inside 0-100', () => {
  assert.equal(quotaPercent({ total: 100, used: 25 }), 25)
  assert.equal(quotaPercent({ total: 0, used: 25 }), null)
  assert.equal(quotaPercent({ percent: 140 }), 100)
  assert.equal(quotaPercent({ percent: -3 }), 0)
  assert.equal(quotaPercent(null), null)
})

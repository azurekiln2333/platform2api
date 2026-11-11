// Deterministic console-contract fixture. No service, credentials or data directories are used.
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { resolve, extname } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = resolve(fileURLToPath(new URL('../../dist/', import.meta.url)))
const port = 19300
const channelIds = ['cnb', 'codebuddy', 'zcode', 'fourth']
const labels = { cnb: 'CNB', codebuddy: 'CodeBuddy', zcode: 'ZCode', fourth: '第四渠道' }
const colors = { cnb: '#3169df', codebuddy: '#209d77', zcode: '#b88125', fourth: '#dd5726' }
const now = new Date().toISOString()
const caps = {
  accounts: { add: ['oauth'], batch: ['enable', 'disable', 'probe', 'tags', 'delete'] },
  keys: {
    create: true,
    update: true,
    delete: true,
    reveal: false,
    rotate: true,
    resetUsage: true,
    fields: [{ key: 'models', label: '模型白名单', type: 'list' }],
  },
  models: { toggle: true },
  logs: {
    kinds: ['request', 'system'],
    filters: ['via', 'from', 'to', 'result', 'model', 'account', 'key', 'q'],
  },
  usage: { extras: [] },
}
const channels = channelIds.map((system) => ({
  system,
  label: labels[system],
  color: colors[system],
  health: system === 'zcode' ? 'down' : 'ok',
  detail: system === 'zcode' ? '测试渠道离线' : '',
  unifiedUrl: `http://127.0.0.1:${port}/v1`,
  inferenceUrl: `https://${system}.example.invalid/v1`,
  inference: { url: `https://${system}.example.invalid/v1`, routes: ['/v1/chat/completions'] },
  capabilities: caps,
}))
const partial = [{ system: 'zcode', message: '测试渠道离线', code: 'upstream_unavailable' }]
let accounts,
  keys,
  routing,
  auth,
  serviceUrls,
  settingsValue,
  settingsRevision,
  failDelete,
  failSave,
  keySequence,
  modelRevision,
  catalog
function reset() {
  accounts = channelIds
    .filter((id) => id !== 'zcode')
    .map((system, index) => ({
      id: `${system}:account-${index}`,
      system,
      label: `${labels[system]} 主账号`,
      status: 'ok',
      enabled: true,
      quota: { unit: index === 0 ? 'credits' : '积分', total: 1000, used: 100, remaining: 900 },
      lastUsedAt: now,
      tags: [system, '测试'],
      primary: `${labels[system]} 账号信息`,
      display: [
        { key: 'identity', label: '账号标识', kind: 'mono', value: `account-${index}` },
        { key: 'probe', label: '最近探测', kind: 'text', value: '成功' },
      ],
      actions: [
        { id: 'edit', label: '编辑' },
        { id: 'probe', label: '探测' },
        { id: 'disable', label: '停用', danger: true },
        { id: 'delete', label: '删除', danger: true },
      ],
    }))
  keys = [
    {
      id: 'codebuddy:direct-1',
      via: 'direct',
      system: 'codebuddy',
      channels: ['codebuddy'],
      name: '直连测试密钥',
      masked: 'sk-••••1234',
      enabled: true,
      builtin: false,
      limits: { models: ['shared-model'] },
      createdAt: now,
      lastUsedAt: now,
      usage: { requests: 12 },
    },
  ]
  routing = {
    order: [...channelIds],
    enabled: Object.fromEntries(channelIds.map((id) => [id, true])),
    failover: true,
  }
  auth = {
    ssoEnabled: false,
    keyLoginEnabled: true,
    issuer: '',
    clientId: '',
    hasClientSecret: false,
    scope: 'openid profile email',
    providerName: '测试 SSO',
    allowedSubjects: [],
    allowedEmails: [],
    callbackUrl: `http://127.0.0.1:${port}/api/auth/oidc/callback`,
  }
  serviceUrls = Object.fromEntries(channelIds.map((id) => [id, `http://${id}:9000`]))
  settingsValue = 7
  settingsRevision = 3
  failDelete = false
  failSave = false
  keySequence = 0
  modelRevision = 7
  catalog = [
    {
      id: 'vendor/shared-model',
      public_id: 'shared-model',
      upstream_id: 'vendor/shared-model',
      enabled: true,
      custom: false,
      routes: ['chat'],
      credits_override: 0,
      credential_ids: [],
    },
  ]
}
reset()
const baseModels = channelIds
  .filter((id) => id !== 'zcode')
  .map((system) => ({
    id: `${system}:${system === 'codebuddy' ? 'vendor/' : ''}shared-model`,
    system,
    model: 'shared-model',
    enabled: true,
    display: [{ key: 'alias', label: '别名', kind: 'text', value: `${labels[system]} 模型` }],
    actions: system === 'codebuddy' ? [{ id: 'update', label: '编辑' }] : [],
  }))
const logs = Array.from({ length: 65 }, (_, index) => ({
  id: `fourth:log-${index}`,
  system: index % 2 ? 'fourth' : 'cnb',
  via: index % 2 ? 'unified' : 'direct',
  at: new Date(Date.now() - index * 60000).toISOString(),
  model: 'shared-model',
  account: '测试账号',
  key: '日志密钥',
  status: index % 3 ? 200 : 503,
  durationMs: 50,
  inputTokens: 1234,
  outputTokens: 456,
  stream: false,
}))
const sessions = new Set()
async function body(req) {
  let raw = ''
  for await (const chunk of req) raw += chunk
  return raw ? JSON.parse(raw) : {}
}
function json(res, status, value, headers = {}) {
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    ...headers,
  })
  res.end(JSON.stringify(value))
}
function keyLimits(input) {
  return Object.fromEntries(
    ['models', 'quota', 'expiresAt', 'ipAllow']
      .filter((key) => key in input)
      .map((key) => [key, input[key]]),
  )
}
function settings() {
  return {
    version: 'test',
    auth,
    services: channels.map((c) => ({
      system: c.system,
      url: serviceUrls[c.system],
      health: c.health,
      detail: c.detail,
    })),
    common: [
      {
        id: 'retention',
        title: '日志保留',
        revision: settingsRevision,
        fields: [
          {
            key: 'days',
            label: '保留天数',
            type: 'number',
            value: settingsValue,
            min: 1,
            max: 365,
          },
        ],
      },
    ],
    channels: channels.map((c) => ({ system: c.system, groups: [], embeds: [] })),
    errors: partial,
  }
}
const server = createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://127.0.0.1:${port}`),
      path = decodeURIComponent(url.pathname),
      method = req.method
    if (path === '/__reset') {
      reset()
      return json(res, 200, { ok: true })
    }
    if (path === '/__failure') {
      const input = await body(req)
      failDelete = !!input.delete
      failSave = !!input.save
      return json(res, 200, { ok: true })
    }
    if (path === '/api/auth/config')
      return json(res, 200, {
        keyLoginEnabled: auth.keyLoginEnabled,
        sso: {
          enabled: auth.ssoEnabled,
          providerName: auth.providerName,
          loginUrl: '/api/auth/oidc/login',
        },
      })
    if (path === '/api/session') {
      if (method === 'POST') {
        const input = await body(req)
        if (input.key !== 'browser-test-admin-key')
          return json(res, 401, { error: { message: '密钥错误' } })
        const token = `session-${Math.random()}`
        sessions.add(token)
        return json(
          res,
          200,
          { authenticated: true },
          { 'set-cookie': `fixture=${token}; HttpOnly; Path=/; SameSite=Lax` },
        )
      }
      const token = req.headers.cookie?.match(/fixture=([^;]+)/)?.[1],
        authenticated = sessions.has(token)
      if (method === 'DELETE') {
        sessions.delete(token)
        return json(res, 200, { ok: true }, { 'set-cookie': 'fixture=; Max-Age=0; Path=/' })
      }
      return json(res, authenticated ? 200 : 401, {
        authenticated,
        user: authenticated
          ? { name: '测试管理员', email: 'admin@example.invalid', provider: 'key', picture: '' }
          : null,
      })
    }
    if (path === '/api/channels') return json(res, 200, channels)
    if (path === '/api/overview')
      return json(res, 200, {
        generatedAt: now,
        totals: {
          accounts: { total: 3, ok: 3, error: 0, disabled: 0 },
          requestsToday: 120,
          tokensToday: 34000,
          errorsToday: 3,
        },
        channels: channels.map((c) => ({
          ...c,
          ok: c.health === 'ok',
          accounts: { total: 1, ok: 1, error: 0, disabled: 0 },
          quota: {
            unit: c.system === 'cnb' ? 'credits' : '积分',
            total: 1000,
            used: 100,
            remaining: 900,
          },
          requestsToday: 40,
          tokensToday: 10000,
        })),
        hourly: [
          { hour: '08:00', cnb: 5, codebuddy: 8, fourth: 3 },
          { hour: '09:00', cnb: 8, codebuddy: 3, fourth: 12 },
        ],
        attention: [
          {
            system: 'zcode',
            kind: 'offline',
            message: '检查测试渠道',
            link: '#accounts?system=zcode',
          },
        ],
        errors: partial,
      })
    if (path === '/api/accounts') return json(res, 200, { items: accounts, errors: partial })
    const tag = /^\/api\/accounts\/([^/]+)\/tags$/.exec(path)
    if (tag) {
      const input = await body(req)
      const account = accounts.find((a) => a.id === tag[1])
      if (account) account.tags = input.tags
      return json(res, 200, { ok: true })
    }
    const action = /^\/api\/accounts\/([^/]+)\/actions\/([^/]+)$/.exec(path)
    if (action) return json(res, 200, { ok: true })
    const accountRoute = /^\/api\/accounts\/([^/]+)$/.exec(path)
    if (accountRoute) {
      const item = accounts.find((a) => a.id === accountRoute[1])
      if (method === 'DELETE') {
        accounts = accounts.filter((a) => a !== item)
        return json(res, 200, { ok: true })
      }
      if (item) Object.assign(item, await body(req))
      return json(res, 200, { item })
    }
    const authFlow = /^\/api\/accounts\/auth\/([^/]+)\/(start|poll|complete)$/.exec(path)
    if (authFlow)
      return json(res, 200, {
        system: authFlow[1],
        flowId: 'flow-fixture',
        result: {
          flowId: 'flow-fixture',
          status: authFlow[2] === 'start' ? 'pending' : 'success',
          message: '测试授权',
          pollIntervalMs: 1000,
        },
      })
    if (path === '/api/keys') {
      if (method === 'GET') return json(res, 200, { items: keys, errors: partial })
      const input = await body(req)
      const id = `${input.via === 'unified' ? 'unified' : input.system}:key-${++keySequence}`
      const item = {
        id,
        via: input.via,
        system: input.via === 'unified' ? null : input.system,
        channels: input.via === 'unified' ? input.channels : [input.system],
        name: input.name,
        enabled: true,
        builtin: false,
        masked: 'p2a-••••test',
        limits: keyLimits(input),
        usage: 0,
        createdAt: now,
      }
      keys.push(item)
      return json(res, 201, { item, secret: `fixture-secret-${keySequence}-once-only` })
    }
    const keyRoute = /^\/api\/keys\/([^/]+)(?:\/actions\/(.+))?$/.exec(path)
    if (keyRoute) {
      const item = keys.find((k) => k.id === keyRoute[1])
      if (!item) return json(res, 404, { error: { message: '密钥不存在' } })
      if (method === 'DELETE') {
        if (failDelete) return json(res, 503, { error: { message: '模拟删除失败，请重试' } })
        keys = keys.filter((k) => k !== item)
        return json(res, 200, { ok: true })
      }
      if (keyRoute[2] === 'rotate')
        return json(res, 200, { item, secret: 'fixture-rotated-secret-once-only' })
      if (method === 'PATCH') {
        const input = await body(req)
        for (const key of ['name', 'enabled', 'channels']) if (key in input) item[key] = input[key]
        Object.assign(item.limits, keyLimits(input))
        return json(res, 200, { item })
      }
      return json(res, 200, { ok: true })
    }
    if (path === '/api/models')
      return json(res, 200, {
        items: baseModels.map((item) =>
          item.system === 'codebuddy'
            ? {
                ...item,
                revision: modelRevision,
                enabled: catalog[0].enabled,
                model: catalog[0].public_id,
              }
            : item,
        ),
        errors: partial,
      })
    if (path.startsWith('/api/models/')) return json(res, 200, { ok: true })
    if (path === '/api/logs') {
      let filtered = logs.filter(
        (item) =>
          (!url.searchParams.get('via') || item.via === url.searchParams.get('via')) &&
          (!url.searchParams.get('system') || item.system === url.searchParams.get('system')),
      )
      if (url.searchParams.get('result') === 'failure')
        filtered = filtered.filter((item) => item.status >= 400)
      const signature = ['from', 'to', 'via', 'system', 'result']
        .map((k) => url.searchParams.get(k) || '')
        .join('|')
      const cursor = url.searchParams.get('cursor'),
        decoded = cursor ? JSON.parse(Buffer.from(cursor, 'base64url').toString()) : null
      if (decoded && decoded.signature !== signature)
        return json(res, 400, { error: { message: '游标与筛选不匹配' } })
      const offset = decoded?.offset || 0,
        end = offset + 50
      return json(res, 200, {
        items: filtered.slice(offset, end),
        nextCursor:
          end < filtered.length
            ? Buffer.from(JSON.stringify({ offset: end, signature })).toString('base64url')
            : null,
        errors: partial,
      })
    }
    if (path.startsWith('/api/logs/')) {
      const item = logs.find((row) => row.id === path.slice('/api/logs/'.length))
      return json(res, 200, {
        item,
        display: [{ key: 'model', label: '模型', kind: 'mono', value: item?.model }],
        raw: { ...item, authorization: 'MUST-NOT-APPEAR' },
      })
    }
    if (path === '/api/usage')
      return json(res, 200, {
        series: [
          {
            bucket: '2026-11-11',
            system: 'fourth',
            requests: 9,
            inputTokens: 900,
            outputTokens: 90,
          },
        ],
        byModel: [{ name: 'shared-model', requests: 9 }],
        byKey: [{ name: '统一测试密钥', requests: 9 }],
        byAccount: [{ name: '测试账号', requests: 9 }],
        extras: {},
        errors: partial,
      })
    if (path === '/api/settings') {
      if (method === 'PATCH') Object.assign(serviceUrls, (await body(req)).serviceUrls)
      return json(res, 200, settings())
    }
    if (path === '/api/settings/common') {
      const input = await body(req)
      if (failSave) return json(res, 422, { error: { message: '保留天数无效' } })
      if (input.values.revision !== settingsRevision)
        return json(res, 409, { error: { message: '设置已被其他会话修改，请刷新' } })
      settingsValue = input.values.days
      return json(res, 200, { ok: true, revision: ++settingsRevision })
    }
    if (path === '/api/gateway/routing') {
      if (method === 'PATCH') routing = await body(req)
      return json(res, 200, routing)
    }
    if (/^\/api\/channels\/[^/]+\/test$/.test(path))
      return json(res, 200, { status: 'ok', detail: '连接正常' })
    if (path === '/api/auth/settings') {
      if (method === 'PATCH') {
        const input = await body(req)
        if (input.keyLoginEnabled === false && !input.ssoEnabled)
          return json(res, 400, { error: { message: '至少启用一种登录方式' } })
        Object.assign(auth, input, {
          clientSecret: undefined,
          hasClientSecret: !!input.clientSecret || auth.hasClientSecret,
        })
      }
      return json(res, 200, auth)
    }
    if (path === '/api/p/codebuddy/admin/models' && method === 'GET')
      return json(res, 200, { revision: modelRevision, models: catalog })
    if (
      ['/api/p/codebuddy/admin/models/scan', '/api/p/codebuddy/admin/models/rate-probe'].includes(
        path,
      )
    )
      return json(res, 200, { ok: true })
    if (path === '/api/p/codebuddy/admin/models' && method === 'POST') {
      const input = await body(req)
      if (input.revision !== modelRevision)
        return json(res, 409, { error: { message: '模型目录已更新' } })
      catalog.push({ ...input, id: input.public_id, custom: true })
      return json(res, 200, { revision: ++modelRevision })
    }
    if (path.startsWith('/api/p/codebuddy/admin/models/') && method === 'PUT') {
      const input = await body(req)
      if (input.revision !== modelRevision)
        return json(res, 409, { error: { message: '模型目录已更新' } })
      const item = catalog.find(
        (row) => row.id === path.slice('/api/p/codebuddy/admin/models/'.length),
      )
      if (!item) return json(res, 404, { error: { message: '模型不存在' } })
      Object.assign(item, input)
      return json(res, 200, { revision: ++modelRevision })
    }
    if (path.startsWith('/api/p/codebuddy/admin/'))
      return json(res, 200, { status: '正常', count: 1 })
    if (path.startsWith('/api/'))
      return json(res, 404, { error: { message: '测试夹具未提供此能力' } })
    const file = resolve(root, `.${path === '/' ? '/index.html' : path}`)
    if (!file.startsWith(root)) return json(res, 403, { error: { message: 'Forbidden' } })
    const content = await readFile(file).catch(() => readFile(resolve(root, 'index.html')))
    const types = {
      '.html': 'text/html; charset=utf-8',
      '.js': 'application/javascript',
      '.css': 'text/css',
      '.svg': 'image/svg+xml',
      '.woff2': 'font/woff2',
    }
    res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' })
    res.end(content)
  } catch (error) {
    json(res, 500, { error: { message: error.message } })
  }
})
server.listen(port, '127.0.0.1', () => console.log('Isolated console fixture ready'))
for (const signal of ['SIGINT', 'SIGTERM'])
  process.on(signal, () => {
    server.closeAllConnections()
    server.close()
    process.exit(0)
  })

// Isolated browser-test backend for the platform2api shell.
// It implements the panel API surface the shell consumes (see web/README.md) with
// fixtures only: no real service, no credentials, no upstream calls.
import http from 'node:http'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { extname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)))
const DIST = join(ROOT, 'dist')
const PORT = Number(process.env.PANEL_FIXTURE_PORT ?? 19300)
const ADMIN_KEY = 'browser-test-admin-key'
const SESSION_COOKIE = 'platform_session=fixture-session'

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
}

if (!existsSync(join(DIST, 'index.html'))) {
  console.error('dist/ is missing; run `npm run build` before the browser tests.')
  process.exit(1)
}

let accounts = [
  {
    id: 'cnb:cnb-a1',
    system: 'cnb',
    label: '主力工作区',
    status: 'healthy',
    quota: { unit: ' credits', total: 2000, used: 500, remaining: 1500 },
    tags: ['cnb', '主力'],
  },
  {
    id: 'codebuddy:cb-b1',
    system: 'codebuddy',
    label: 'CodeBuddy 主号',
    status: 'pending',
    quota: { unit: ' 积分', total: 800, used: 200, remaining: 600 },
    tags: ['codebuddy'],
  },
  {
    id: 'zcode:zc-team:1',
    system: 'zcode',
    label: 'ZCode 团队号',
    status: 'cooling',
    quota: { unit: ' 点', total: 500, used: 450, remaining: 50 },
    tags: ['zcode', '测试'],
  },
]

const overview = () => ({
  cnb: {
    health: 'ok',
    accounts: { total: 1, ready: 1 },
    quota: {
      label: '组织额度',
      unit: ' credits',
      total: 2000,
      used: 500,
      remaining: 1500,
      syncedAt: new Date().toISOString(),
    },
    usage: [{ label: '今日请求', value: 42 }],
    generatedAt: new Date().toISOString(),
  },
  codebuddy: {
    health: 'degraded',
    accounts: { total: 1, ready: 0 },
    quota: { label: '积分余额', unit: ' 积分', total: 800, used: 200, remaining: 600 },
    usage: [{ label: '今日调用', value: 7 }],
  },
  zcode: { error: { message: 'zcode2api 暂时不可达' } },
})

const settings = () => ({
  services: {
    cnb: { url: 'http://cnb:9002', tokenConfigured: true, health: 'ok' },
    codebuddy: { url: 'http://codebuddy:8787', tokenConfigured: true, health: 'degraded' },
    zcode: { url: 'http://zcode:12283', tokenConfigured: false, message: '尚未探测' },
  },
  panelUrl: 'http://127.0.0.1:9000',
  version: '0.1.0',
  dataDir: 'data/panel',
})

/** Adapter-driven authorization flows: `start` -> `poll` (+inputs) -> `success`. */
const flows = new Map()
const flowSpec = {
  cnb: { steps: [{ title: '打开 CNB 授权页', url: 'https://example.invalid/cnb/auth' }] },
  codebuddy: {
    steps: [{ title: '在 CodeBuddy 完成 OAuth 登录', url: 'https://example.invalid/cb/oauth' }],
  },
  zcode: { inputs: [{ name: 'code', label: '授权码', required: true }] },
}

function json(res, status, body) {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

async function body(req) {
  const chunks = []
  for await (const chunk of req) chunks.push(chunk)
  const text = Buffer.concat(chunks).toString('utf8')
  if (!text) return {}
  try {
    return JSON.parse(text)
  } catch {
    return {}
  }
}

const authed = (req) => (req.headers.cookie ?? '').includes(SESSION_COOKIE)

async function api(req, res, url) {
  const { pathname } = url
  const method = req.method ?? 'GET'
  if (pathname === '/api/login' && method === 'POST') {
    const { key } = await body(req)
    if (key !== ADMIN_KEY) return json(res, 403, { error: { message: '管理密钥不正确' } })
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}; Path=/; HttpOnly; SameSite=Strict`)
    return json(res, 200, { authenticated: true })
  }
  if (pathname === '/api/logout' && method === 'POST') {
    res.setHeader('Set-Cookie', 'platform_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict')
    return json(res, 200, { authenticated: false })
  }
  if (pathname === '/api/session' && method === 'DELETE') {
    res.setHeader('Set-Cookie', 'platform_session=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict')
    return json(res, 200, { authenticated: false })
  }
  if (pathname === '/api/auth/config') {
    return json(res, 200, {
      keyLoginEnabled: true,
      sso: { enabled: false, providerName: '', loginUrl: '' },
    })
  }
  if (!authed(req)) return json(res, 401, { error: { message: '未登录或会话已过期' } })
  if (pathname === '/api/session') return json(res, 200, { authenticated: true })
  if (pathname === '/api/overview') return json(res, 200, overview())
  if (pathname === '/api/settings') return json(res, 200, settings())
  if (pathname === '/api/accounts' && method === 'GET') {
    const system = url.searchParams.get('system')
    return json(res, 200, {
      accounts: system ? accounts.filter((account) => account.system === system) : accounts,
    })
  }
  const tagMatch = pathname.match(/^\/api\/accounts\/(.+)\/tags$/)
  if (tagMatch && method === 'PATCH') {
    const id = decodeURIComponent(tagMatch[1])
    const target = accounts.find((account) => account.id === id)
    if (!target) return json(res, 404, { error: { message: '账号不存在' } })
    const { tags } = await body(req)
    target.tags = [target.system, ...(Array.isArray(tags) ? tags : [])]
    return json(res, 200, { account: target })
  }
  const authMatch = pathname.match(
    /^\/api\/accounts\/auth\/(cnb|codebuddy|zcode)\/(start|poll|complete)$/,
  )
  if (authMatch && method === 'POST') {
    const [, system, step] = authMatch
    const payload = await body(req)
    if (step === 'start') {
      const flowId = `${system}-flow-1`
      flows.set(flowId, { system, polls: 0, values: null })
      return json(res, 200, { flowId, system, status: 'pending', ...flowSpec[system] })
    }
    const flowId = String(payload.flowId ?? '')
    const flow = flows.get(flowId)
    if (!flow) return json(res, 404, { error: { message: '授权流程不存在或已过期' } })
    if (step === 'complete') return json(res, 200, { flowId, system, status: 'success' })
    flow.polls += 1
    if (payload.values) flow.values = payload.values
    const needsInput = Boolean(flowSpec[system].inputs)
    if (needsInput && !flow.values)
      return json(res, 200, {
        flowId,
        system,
        status: 'pending',
        inputs: flowSpec[system].inputs,
        message: '等待输入授权码',
      })
    return json(res, 200, { flowId, system, status: 'success', message: '授权完成' })
  }
  return json(res, 404, { error: { message: `未实现的测试接口 ${method} ${pathname}` } })
}

async function serveStatic(res, pathname) {
  const relative = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '')
  const file = join(DIST, relative)
  const target = file.startsWith(DIST) && existsSync(file) ? file : join(DIST, 'index.html')
  const data = await readFile(target)
  res.writeHead(200, { 'Content-Type': MIME[extname(target)] ?? 'application/octet-stream' })
  res.end(data)
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`)
  if (url.pathname.startsWith('/api/')) {
    try {
      await api(req, res, url)
    } catch (error) {
      json(res, 500, {
        error: { message: error instanceof Error ? error.message : 'fixture error' },
      })
    }
    return
  }
  await serveStatic(res, url.pathname)
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`platform2api shell fixture ready at http://127.0.0.1:${PORT}`)
})

const shutdown = () => {
  server.closeAllConnections()
  server.close()
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

// Isolated browser-test backend for the platform2api shell.
//
// It boots the REAL panel server (`src/app.mjs`) with three fake adapters and a
// temp data dir, then serves the built console from `dist/`. No real service, no
// credentials, no upstream calls: the adapters answer from fixtures only.
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(fileURLToPath(new URL('../../', import.meta.url)))
const PORT = Number(process.env.PANEL_FIXTURE_PORT ?? 19300)
const ADMIN_KEY = 'browser-test-admin-key'
const dataDir = mkdtempSync(join(tmpdir(), 'platform2api-shell-'))

const { createPanelServer } = await import(new URL('../../../src/app.mjs', import.meta.url))

const accounts = () => [
  {
    nativeId: 'cnb-a1',
    label: '主力工作区',
    status: 'healthy',
    enabled: true,
    quota: { unit: 'credits', total: 2000, used: 500, remaining: 1500 },
    raw: {},
  },
  {
    nativeId: 'cb-b1',
    label: 'CodeBuddy 主号',
    status: 'pending',
    enabled: true,
    quota: { unit: '积分', total: 800, used: 200, remaining: 600 },
    raw: {},
  },
  {
    nativeId: 'zc-team:1',
    label: 'ZCode 团队号',
    status: 'cooling',
    enabled: true,
    quota: { unit: '点', total: 500, used: 450, remaining: 50 },
    raw: {},
  },
]

const overviewPayloads = {
  cnb: {
    accounts: { total: 1, ready: 1, paused: 0 },
    // CNB credits only; the panel never converts or sums across systems (R10).
    quota: {
      label: 'CNB 组织额度',
      unit: 'credits',
      total: 2000,
      used: 500,
      remaining: 1500,
      syncedAt: new Date().toISOString(),
      metrics: [{ label: '额度组织', unit: '个', total: null, used: null, remaining: 1 }],
    },
    usage: [{ label: '今日请求', value: 42 }],
  },
  codebuddy: {
    accounts: { total: 1, ready: 0 },
    quota: { label: '积分余额', unit: '积分', total: 800, used: 200, remaining: 600 },
    usage: [{ label: '今日调用', value: 7 }],
  },
  // ZCode stays down so the shell's per-system failure isolation is exercised.
  zcode: null,
}

const flows = new Map()
const flowSteps = {
  cnb: [{ title: '打开 CNB 授权页', url: 'https://example.invalid/cnb/auth' }],
  codebuddy: [{ title: '在 CodeBuddy 完成 OAuth 登录', url: 'https://example.invalid/cb/oauth' }],
  zcode: [{ title: '在 ZCode 控制台完成登录', url: 'https://example.invalid/zc/login' }],
}

function fakeAdapter(system) {
  return {
    system,
    async health() {
      if (system === 'zcode') return { status: 'down', detail: 'zcode2api 暂时不可达' }
      return { status: system === 'codebuddy' ? 'degraded' : 'ok', detail: '' }
    },
    async overview() {
      const payload = overviewPayloads[system]
      if (!payload) {
        const error = new Error('zcode2api 暂时不可达')
        error.name = 'AdapterError'
        error.code = 'upstream_error'
        throw error
      }
      return payload
    },
    async listAccounts() {
      return accounts().filter((entry) =>
        entry.nativeId.startsWith(system === 'cnb' ? 'cnb' : system === 'codebuddy' ? 'cb' : 'zc'),
      )
    },
    async accountAction() {
      return { ok: true }
    },
    async startAuth() {
      const flowId = `${system}-flow-1`
      flows.set(flowId, { system, values: null })
      return { flowId, status: 'pending', ...flowSteps[system] }
    },
    async pollAuth(flowId, payload = {}) {
      const flow = flows.get(flowId)
      if (!flow) return { flowId, status: 'expired', error: '授权流程不存在或已过期' }
      if (payload?.values) flow.values = payload.values
      // One system needs an adapter-driven input step, the others complete on poll.
      if (system === 'zcode' && !flow.values)
        return {
          flowId,
          status: 'pending',
          message: '等待输入授权码',
          inputs: [{ name: 'code', label: '授权码', required: true }],
        }
      return { flowId, status: 'success', message: '授权完成' }
    },
    async completeAuth(flowId) {
      return { flowId, status: 'success' }
    },
    async call() {
      return { status: 200, headers: {}, body: {} }
    },
  }
}

const { server } = createPanelServer({
  adminKey: ADMIN_KEY,
  dataDir,
  allowLocal: true,
  logger: { warn() {}, error() {}, info() {} },
  // SSO is seeded with a loopback issuer that nothing listens on, so the login
  // page shows the SSO entry point and the OIDC discovery failure notice is a
  // real server response (no IdP fixture is needed for the shell test).
  ssoBootstrap: {
    enabled: true,
    issuer: 'http://127.0.0.1:19399',
    clientId: 'platform-shell-test',
    clientSecret: 'platform-shell-secret',
    scope: 'openid profile email',
    providerName: '测试 SSO',
    allowedSubjects: ['admin-subject-1'],
    allowedEmails: ['admin@example.com'],
    keyLoginEnabled: true,
  },
  systems: ['cnb', 'codebuddy', 'zcode'].map((system) => ({
    system,
    baseUrl:
      system === 'cnb'
        ? 'http://cnb:9002'
        : system === 'codebuddy'
          ? 'http://codebuddy:8787'
          : 'http://zcode:12283',
    token: system === 'zcode' ? '' : 'test-platform-token',
  })),
  adapters: {
    cnb: fakeAdapter('cnb'),
    codebuddy: fakeAdapter('codebuddy'),
    zcode: fakeAdapter('zcode'),
  },
  webRoot: join(ROOT, 'dist'),
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`platform2api shell fixture (real panel server) ready at http://127.0.0.1:${PORT}`)
})

const shutdown = () => {
  server.closeAllConnections?.()
  server.close()
  rmSync(dataDir, { recursive: true, force: true })
  process.exit(0)
}
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

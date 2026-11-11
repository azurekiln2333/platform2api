import { computed, ref } from 'vue'
import { api, ApiError, type ApiDiagnostics } from './api.ts'
import {
  normalizeAccountList,
  normalizeAccountsErrors,
  normalizeTags,
  overviewCards,
  parseAccountId,
  serviceHealth,
  serviceInfo,
  systemTag,
  type SystemCard,
} from './systems.ts'
import type {
  AccountsError,
  AuthConfig,
  AuthFlow,
  AuthFlowStatus,
  PanelAccount,
  PanelSettings,
  SessionUser,
  SystemId,
} from './types.ts'

const DEFAULT_AUTH_CONFIG: AuthConfig = {
  keyLoginEnabled: true,
  sso: { enabled: false, providerName: '', loginUrl: '' },
}
export const OVERVIEW_POLL_MS = 15000

export const session = ref<{ authenticated: boolean; user: SessionUser | null }>({
  authenticated: false,
  user: null,
})
export const authConfig = ref<AuthConfig>({ ...DEFAULT_AUTH_CONFIG })
export const cards = ref<SystemCard[]>([])
export const accounts = ref<PanelAccount[]>([])
export const panelSettings = ref<PanelSettings | null>(null)
export const overviewLoading = ref(false)
export const accountsLoading = ref(false)
export const lastUpdated = ref<Date | null>(null)
export const refreshError = ref('')
/** Per-system account read failures reported alongside the unified list. */
export const accountsErrors = ref<AccountsError[]>([])

export const toasts = ref<
  { id: number; text: string; error: boolean; diagnostics?: ApiDiagnostics }[]
>([])
let notificationId = 0

export function notify(text: string, error = false, diagnostics?: ApiDiagnostics) {
  const id = ++notificationId
  toasts.value.push({ id, text, error, diagnostics })
  window.setTimeout(
    () => {
      toasts.value = toasts.value.filter((toast) => toast.id !== id)
    },
    diagnostics ? 15000 : 4500,
  )
}

export function dismissToast(id: number) {
  toasts.value = toasts.value.filter((toast) => toast.id !== id)
}

export function reportError(error: unknown, fallback: string) {
  notify(
    error instanceof Error ? error.message : fallback,
    true,
    error instanceof ApiError ? error.diagnostics : undefined,
  )
}

export async function copy(text: string) {
  try {
    if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text)
    else {
      const input = document.createElement('textarea')
      input.value = text
      input.readOnly = true
      input.style.position = 'fixed'
      input.style.opacity = '0'
      document.body.appendChild(input)
      input.select()
      const copied = document.execCommand('copy')
      input.remove()
      if (!copied) throw new Error('clipboard unavailable')
    }
    notify('已复制到剪贴板')
    return true
  } catch {
    notify('复制失败，请手动选择内容复制', true)
    return false
  }
}

/**
 * Login contract is `POST /api/session` (cnb2api-panel naming, R13). `POST
 * /api/login` is tried as a fallback so an alternate server shape still works.
 */
async function sessionRequest(
  variants: { path: string; method: 'POST' | 'DELETE' }[],
  data?: unknown,
) {
  for (const [index, variant] of variants.entries()) {
    try {
      await api(variant.path, variant.method, data)
      return
    } catch (error) {
      const last = index === variants.length - 1
      if (last || !(error instanceof ApiError) || error.status !== 404) throw error
    }
  }
}

export async function loadAuthConfig(force = false) {
  try {
    const config = await api<AuthConfig>('/auth/config')
    if (config && typeof config.keyLoginEnabled === 'boolean' && config.sso) {
      authConfig.value = {
        keyLoginEnabled: config.keyLoginEnabled,
        sso: {
          enabled: config.sso.enabled === true,
          providerName: typeof config.sso.providerName === 'string' ? config.sso.providerName : '',
          loginUrl: typeof config.sso.loginUrl === 'string' ? config.sso.loginUrl : '',
        },
      }
      return authConfig.value
    }
  } catch {
    /* A panel without SSO metadata still allows key login. */
  }
  if (force) authConfig.value = { ...DEFAULT_AUTH_CONFIG }
  return authConfig.value
}

export async function loadSession() {
  try {
    const result = await api<{ authenticated?: boolean; user?: SessionUser }>('/session')
    session.value = {
      authenticated: result?.authenticated !== false,
      user: result?.user ?? null,
    }
  } catch {
    session.value = { authenticated: false, user: null }
  }
  return session.value
}

export async function signIn(key: string) {
  await sessionRequest(
    [
      { path: '/session', method: 'POST' },
      { path: '/login', method: 'POST' },
    ],
    {
      key,
    },
  )
  await loadSession()
}

export async function signOut() {
  await sessionRequest([
    { path: '/session', method: 'DELETE' },
    { path: '/logout', method: 'POST' },
    { path: '/login', method: 'DELETE' },
  ])
  reset()
}

export function reset() {
  session.value = { authenticated: false, user: null }
  cards.value = []
  accounts.value = []
  accountsErrors.value = []
  panelSettings.value = null
  lastUpdated.value = null
  refreshError.value = ''
}

/** `/api/overview` keeps systems apart; a failing system only blanks its own card. */
export async function refreshOverview() {
  if (!session.value.authenticated) return
  overviewLoading.value = true
  try {
    const payload = await api<unknown>('/overview')
    cards.value = overviewCards(payload)
    lastUpdated.value = new Date()
    refreshError.value = ''
  } catch (error) {
    refreshError.value = error instanceof Error ? error.message : '概览数据加载失败'
    if (!cards.value.length) cards.value = overviewCards({})
  } finally {
    overviewLoading.value = false
  }
}

export interface AccountQuery {
  system?: SystemId | 'all'
  tag?: string
}

export async function refreshAccounts(query: AccountQuery = {}) {
  if (!session.value.authenticated) return
  accountsLoading.value = true
  try {
    const params = new URLSearchParams()
    if (query.system && query.system !== 'all') params.set('system', query.system)
    const path = `/accounts${params.size ? `?${params}` : ''}`
    const payload = (await api<unknown>(path)) as { errors?: unknown } | null
    accounts.value = normalizeAccountList(payload)
    accountsErrors.value = normalizeAccountsErrors(payload?.errors)
  } catch (error) {
    reportError(error, '账号列表加载失败')
  } finally {
    accountsLoading.value = false
  }
}

export function replaceAccount(next: PanelAccount) {
  accounts.value = accounts.value.map((account) => (account.id === next.id ? next : account))
}

export async function saveTags(account: PanelAccount, tags: string[]) {
  const response = (await api<unknown>(
    `/accounts/${encodeURIComponent(account.id)}/tags`,
    'PATCH',
    { tags },
  )) as { tags?: unknown; userTags?: unknown; account?: unknown } | null
  // The panel answers `{ id, tags, userTags }`; a full account row is also accepted.
  const saved = [response?.userTags, response?.tags]
    .find((value) => Array.isArray(value))
    ?.filter((tag): tag is string => typeof tag === 'string')
    .filter((tag) => tag !== account.system)
  const updated =
    normalizeAccountList(response).find((item) => item.id === account.id) ??
    normalizeAccountList(response?.account ? [response.account] : []).find(
      (item) => item.id === account.id,
    )
  replaceAccount(
    updated ?? {
      ...account,
      tags: normalizeTags([systemTag(account.system), ...(saved ?? tags)]),
    },
  )
  notify('标签已保存')
}

export async function loadPanelSettings() {
  try {
    panelSettings.value = (await api<PanelSettings>('/settings')) ?? null
  } catch (error) {
    if (!(error instanceof ApiError) || error.status !== 404) reportError(error, '面板设置读取失败')
    panelSettings.value = null
  }
}

const AUTH_POLL_MS = 2000

function authPath(system: SystemId, step: 'start' | 'poll' | 'complete') {
  return `/accounts/auth/${system}/${step}`
}

/**
 * The panel wraps the adapter payload as `{ system, flowId, result }`;
 * `result` carries the flow itself, so it is unwrapped here.
 */
function flowOf(system: SystemId, payload: unknown, fallbackFlowId = ''): AuthFlow {
  const body = (payload ?? {}) as {
    flowId?: unknown
    result?: unknown
    status?: unknown
    system?: unknown
  }
  const flow = (body.result && typeof body.result === 'object' ? body.result : body) as Record<
    string,
    unknown
  >
  const flowId =
    typeof flow.flowId === 'string'
      ? flow.flowId
      : typeof body.flowId === 'string'
        ? body.flowId
        : fallbackFlowId
  const status =
    typeof flow.status === 'string' &&
    ['pending', 'success', 'failed', 'expired'].includes(flow.status)
      ? (flow.status as AuthFlowStatus)
      : 'pending'
  return { ...(flow as unknown as AuthFlow), system, flowId, status }
}

export async function startAuth(system: SystemId, accountId?: string) {
  const payload = await api<unknown>(
    authPath(system, 'start'),
    'POST',
    accountId ? { accountId } : {},
  )
  return flowOf(system, payload)
}

export async function pollAuth(system: SystemId, flowId: string) {
  return flowOf(system, await api<unknown>(authPath(system, 'poll'), 'POST', { flowId }), flowId)
}

export async function submitAuth(system: SystemId, flowId: string, values: Record<string, string>) {
  return flowOf(
    system,
    await api<unknown>(authPath(system, 'poll'), 'POST', { flowId, values }),
    flowId,
  )
}

export async function completeAuth(system: SystemId, flowId: string) {
  return flowOf(
    system,
    await api<unknown>(authPath(system, 'complete'), 'POST', { flowId }),
    flowId,
  )
}

export const authPollMs = (flow: AuthFlow) =>
  Number.isFinite(flow.pollIntervalMs) && (flow.pollIntervalMs ?? 0) > 0
    ? Math.max(1000, flow.pollIntervalMs!)
    : AUTH_POLL_MS

export function flowFinished(status: AuthFlowStatus) {
  return status === 'success' || status === 'failed' || status === 'expired'
}

export const accountTotals = computed(() => ({
  all: accounts.value.length,
  bySystem: accounts.value.reduce<Record<string, number>>((counts, account) => {
    counts[account.system] = (counts[account.system] ?? 0) + 1
    return counts
  }, {}),
}))

export const systemAccounts = (system: SystemId) =>
  accounts.value.filter((account) => account.system === system)

export function accountSystem(id: string) {
  return parseAccountId(id).system
}

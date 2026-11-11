import { api } from '../../api.ts'
import { statusLabel } from '../../systems.ts'
import type { CnbAccount } from './types.ts'

/**
 * Every CNB page talks to the panel proxy, never to the service directly:
 * `/api/p/cnb/<service path>`. `api()` adds the session cookie, error
 * diagnostics and the 401 session-expiry event.
 */
export const cnb = <T>(path: string, method = 'GET', data?: unknown): Promise<T> =>
  api<T>(`/p/cnb${path}`, method, data)

/** Same as `cnb()` but for endpoints whose body is an array or an empty 204. */
export const cnbRaw = (path: string, method = 'GET', data?: unknown): Promise<unknown> =>
  api<unknown>(`/p/cnb${path}`, method, data)

/** Mirrors cnb2api-panel `web/src/console.ts` `accountState`. */
export function accountState(account: CnbAccount): string {
  if (!account.enabled) return 'disabled'
  if (account.quotaProtection?.suspended) return 'quota'
  if (account.cooldownUntil && Date.parse(account.cooldownUntil) > Date.now()) return 'cooling'
  if (account.status === 'healthy' && account.endpoint) return 'healthy'
  if (account.status === 'unhealthy') return 'offline'
  return 'pending'
}

export function accountStateLabel(account: CnbAccount): string {
  return statusLabel(accountState(account))
}

export function quotaProtectionMessage(account: CnbAccount): string {
  const state = account.quotaProtection
  if (!state?.suspended) return ''
  if (state.reason === 'low') return `剩余额度低于 ${state.thresholdPercent ?? ''}%，达标后自动恢复`
  if (state.reason === 'sync-error') return '额度同步失败，验证成功后自动恢复'
  if (state.reason === 'invalid') return '额度数据无效，验证成功后自动恢复'
  return '等待额度验证，验证成功后自动恢复'
}

export const quotaInfo = (account: CnbAccount) => {
  const credits = account.quota?.credits
  if (!credits || !Number.isFinite(credits.total) || credits.total <= 0) return null
  const used = Math.max(0, (credits.used ?? 0) + (credits.freeze ?? 0))
  return {
    total: credits.total,
    used,
    remaining: Math.max(0, credits.total - used),
    percent: Math.min(100, (used / credits.total) * 100),
  }
}

export const modelsOf = (account: CnbAccount): string[] =>
  account.models?.length ? account.models : (account.discoveredModels ?? [])

export const formatTime = (value?: string | null): string =>
  value
    ? new Date(value).toLocaleString('zh-CN', {
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
      })
    : '—'

/** `[开始, 结束]` window for a paginated log page, clamped to sane bounds. */
export function pageWindow(offset: number, limit: number, total: number) {
  const start = total === 0 ? 0 : Math.min(offset + 1, total)
  const end = Math.min(offset + limit, total)
  return { start, end }
}

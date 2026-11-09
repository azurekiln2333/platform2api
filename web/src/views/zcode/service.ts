import { api } from '../../api.ts'
import { statusLabel } from '../../systems.ts'
import type { ZcodeAccount, ZcodeQuota } from './types.ts'

/**
 * Every ZCode page talks to the panel proxy, never to the service directly:
 * `/api/p/zcode/<service path>`. Console routes and the root legacy routes
 * (`/keys`, `/stats`, `/quota`, `/security`, `/pool/*`) both pass through.
 */
export const zcode = <T>(path: string, method = 'GET', data?: unknown): Promise<T> =>
  api<T>(`/p/zcode${path}`, method, data)

export const zcodeRaw = (path: string, method = 'GET', data?: unknown): Promise<unknown> =>
  api<unknown>(`/p/zcode${path}`, method, data)

/** ZCode stores the switch inverted: `disabled: true` means the account is off. */
export function accountState(account: ZcodeAccount): string {
  if (account.enabled === false || account.disabled === true) return 'disabled'
  const cooldown = Number(account.cooldownUntil ?? 0)
  if (cooldown && cooldown > Date.now()) return 'cooling'
  if (account.status === 'healthy' || account.status === 'ready') return 'healthy'
  if (account.status === 'unhealthy' || account.status === 'offline') return 'offline'
  if (account.lastErr) return 'offline'
  return 'pending'
}

export const accountStateLabel = (account: ZcodeAccount): string => statusLabel(accountState(account))

export const accountIdentity = (account: ZcodeAccount): string =>
  account.email || account.phone || account.identity || account.label

export const quotaInfo = (quota?: ZcodeQuota | null) => {
  const credits = quota?.credits
  if (!credits || !Number.isFinite(credits.total) || credits.total <= 0) return null
  const used = Math.max(0, (credits.used ?? 0) + (credits.freeze ?? 0))
  return {
    total: credits.total,
    used,
    remaining: Math.max(0, credits.total - used),
    percent: Math.min(100, (used / credits.total) * 100),
  }
}

export const formatTime = (value?: string | number | null): string => {
  if (value === null || value === undefined || value === '') return '—'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  })
}

export const ONBOARD_PROVIDERS = [
  { id: 'zai', label: 'Z.ai（国际）' },
  { id: 'bigmodel', label: 'BigModel（国内）' },
] as const

export const SETTINGS_FIELDS = [
  { key: 'topN', label: '候选账号数', min: 1, max: 20 },
  { key: 'maxInFlight', label: '单账号并发上限', min: 1, max: 20 },
  { key: 'breakerThreshold', label: '熔断失败次数', min: 1, max: 20 },
  { key: 'breakerCooldownMin', label: '熔断冷却（分钟）', min: 1, max: 120 },
  { key: 'quotaCooldownMin', label: '额度冷却（分钟）', min: 1, max: 240 },
  { key: 'busyCooldownSec', label: '忙碌冷却（秒）', min: 1, max: 300 },
  { key: 'stickyTtlMin', label: '会话保持（分钟）', min: 0, max: 240 },
  { key: 'minPickGapMs', label: '最小选取间隔（毫秒）', min: 0, max: 5000 },
] as const

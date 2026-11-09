import { api } from '../../api.ts'

/**
 * Every CodeBuddy page talks to the panel proxy, never to the service:
 * `/api/p/codebuddy/<service path>`. `api()` adds the session cookie, error
 * diagnostics and the 401 session-expiry event.
 *
 * Management authorization happens server-side with the service's
 * `PLATFORM_TOKEN`; the browser never sees it, and SSO/CSRF are irrelevant here.
 */
export const codebuddy = <T>(path: string, method = 'GET', data?: unknown): Promise<T> =>
  api<T>(`/p/codebuddy${path}`, method, data)

/** Same as `codebuddy()` but for endpoints whose body may be empty. */
export const codebuddyRaw = (path: string, method = 'GET', data?: unknown): Promise<unknown> =>
  api<unknown>(`/p/codebuddy${path}`, method, data)

export interface CodeBuddyCredential {
  name: string
  nickname?: string
  enabled?: boolean
  disabled?: boolean
  cooldown_until?: string | null
  tags?: string[]
  quota?: unknown
  [key: string]: unknown
}

export interface CodeBuddyDashboard {
  days?: number
  granularity?: string
  totals?: { requests?: number | null; credits?: number | null; [key: string]: unknown }
  health?: unknown
  storage?: unknown
  [key: string]: unknown
}

export interface CodeBuddySettingsItem {
  key: string
  label?: string
  value: unknown
  mode?: string
  source?: string
  locked?: boolean
  sensitive?: boolean
  type?: string
}

export interface CodeBuddyLogEntry {
  id?: string
  [key: string]: unknown
}

/** Credential state mirrored from `app/admin_api.py` field semantics. */
export function credentialState(credential: CodeBuddyCredential): string {
  if (credential.disabled === true || credential.enabled === false) return 'disabled'
  const cooldown = credential.cooldown_until
  if (typeof cooldown === 'string' && cooldown && Date.parse(cooldown) > Date.now())
    return 'cooling'
  return 'ready'
}

/** The service accepts exactly one boolean field per credential PATCH. */
export const CREDENTIAL_TOGGLES = [
  { key: 'enabled', label: '启用' },
  { key: 'auto_checkin', label: '自动签到' },
  { key: 'auto_travel', label: '自动旅行' },
  { key: 'auto_daily_chat', label: '每日对话' },
  { key: 'auto_growth', label: '自动成长' },
] as const

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

/** A 409 from the service means another session saved first. */
export const isRevisionConflict = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : String(error ?? '')
  return /409|配置已更新|revision/i.test(message)
}

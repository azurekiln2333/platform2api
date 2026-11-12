import type {
  AccountsError,
  OverviewAccountCounts,
  PanelAccount,
  PanelServiceInfo,
  PanelSettings,
  QuotaSnapshot,
  SystemHealth,
  SystemId,
  SystemOverview,
} from './types.ts'

export interface SystemMeta {
  id: SystemId
  /** Product name shown in the sidebar section and on cards. */
  label: string
  /** Two-to-four character badge content. */
  badge: string
  /** Local service the panel proxies to, for operator-facing copy. */
  service: string
}

export const SYSTEMS: SystemMeta[] = []
export const SYSTEM_IDS: SystemId[] = []
export function registerSystems(channels: { system: string; label: string }[]) {
  SYSTEMS.splice(
    0,
    SYSTEMS.length,
    ...channels.map((item) => ({
      id: item.system,
      label: item.label,
      badge: item.label,
      service: item.label,
    })),
  )
  SYSTEM_IDS.splice(0, SYSTEM_IDS.length, ...channels.map((item) => item.system))
}

export function systemMeta(id: SystemId): SystemMeta {
  return (
    SYSTEMS.find((system) => system.id === id) ?? {
      id,
      label: id,
      badge: id.slice(0, 2).toUpperCase(),
      service: id,
    }
  )
}

export function isSystemId(value: unknown): value is SystemId {
  return typeof value === 'string' && SYSTEM_IDS.includes(value as SystemId)
}

/** One card on the overview page. `error` is isolated to its own system. */
export interface SystemCard {
  system: SystemId
  available: boolean
  health: SystemHealth
  healthMessage: string
  accounts: OverviewAccountCounts | null
  quota: QuotaSnapshot | null
  usage: NonNullable<SystemOverview['usage']>
  generatedAt: string | null
  error: string
}

const HEALTH_TOKENS: Record<string, SystemHealth> = {
  ok: 'ok',
  healthy: 'ok',
  up: 'ok',
  ready: 'ok',
  degraded: 'degraded',
  warning: 'degraded',
  partial: 'degraded',
  offline: 'offline',
  down: 'offline',
  error: 'offline',
  unknown: 'unknown',
}

const finite = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : null

function normalizeHealth(value: unknown, fallback: SystemHealth): SystemHealth {
  if (typeof value !== 'string') return fallback
  return HEALTH_TOKENS[value.trim().toLowerCase()] ?? fallback
}

function errorMessage(entry: unknown): string {
  if (!entry || typeof entry !== 'object') return ''
  const error = (entry as { error?: unknown }).error
  if (!error) return ''
  if (typeof error === 'string') return error
  if (typeof error === 'object') {
    const message = (error as { message?: unknown }).message
    if (typeof message === 'string') return message
  }
  return '该系统的管理接口暂不可用'
}

function normalizeAccounts(value: unknown): OverviewAccountCounts | null {
  if (!value || typeof value !== 'object') return null
  const counts = value as Record<string, unknown>
  const total = finite(counts.total)
  const ready = finite(counts.ready)
  if (total === null && ready === null) return null
  return { total, ready, paused: finite(counts.paused) }
}

function normalizeQuota(value: unknown): QuotaSnapshot | null {
  if (!value || typeof value !== 'object') return null
  const quota = value as Record<string, unknown>
  const total = finite(quota.total)
  const used = finite(quota.used)
  const remaining = finite(quota.remaining)
  if (total === null && used === null && remaining === null) return null
  const metrics = Array.isArray(quota.metrics)
    ? quota.metrics.flatMap((metric) => {
        if (!metric || typeof metric !== 'object') return []
        const item = metric as Record<string, unknown>
        return [
          {
            label: typeof item.label === 'string' && item.label ? item.label : '额度',
            unit: typeof item.unit === 'string' ? item.unit : '',
            total: finite(item.total),
            used: finite(item.used),
            remaining: finite(item.remaining),
          },
        ]
      })
    : undefined
  return {
    label: typeof quota.label === 'string' && quota.label ? quota.label : '额度',
    unit: typeof quota.unit === 'string' ? quota.unit : '',
    total,
    used,
    remaining,
    syncedAt: typeof quota.syncedAt === 'string' ? quota.syncedAt : null,
    ...(metrics && metrics.length ? { metrics } : {}),
    ...(typeof quota.note === 'string' && quota.note ? { note: quota.note } : {}),
  }
}

function normalizeUsage(value: unknown): NonNullable<SystemOverview['usage']> {
  if (!Array.isArray(value)) return []
  return value.flatMap((metric) => {
    if (!metric || typeof metric !== 'object') return []
    const item = metric as Record<string, unknown>
    if (typeof item.label !== 'string' || !item.label) return []
    return [
      {
        label: item.label,
        value: finite(item.value),
        ...(typeof item.unit === 'string' && item.unit ? { unit: item.unit } : {}),
        ...(Number.isFinite(item.digits as number) ? { digits: item.digits as number } : {}),
      },
    ]
  })
}

export function systemCard(system: SystemId, entry: unknown): SystemCard {
  const message = errorMessage(entry)
  if (!entry || typeof entry !== 'object' || message) {
    return {
      system,
      available: false,
      health: 'offline',
      healthMessage: '无法读取该系统',
      accounts: null,
      quota: null,
      usage: [],
      generatedAt: null,
      error: message || '该系统未返回数据',
    }
  }
  const payload = entry as Record<string, unknown>
  return {
    system,
    available: true,
    health: normalizeHealth(payload.health, 'unknown'),
    healthMessage: typeof payload.healthMessage === 'string' ? payload.healthMessage : '',
    accounts: normalizeAccounts(payload.accounts),
    quota: normalizeQuota(payload.quota),
    usage: normalizeUsage(payload.usage),
    generatedAt: typeof payload.generatedAt === 'string' ? payload.generatedAt : null,
    error: '',
  }
}

/** Build one card per system, in display order. Never merges or sums systems. */
export function overviewCards(payload: unknown): SystemCard[] {
  const source = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {}
  return SYSTEM_IDS.map((system) => systemCard(system, source[system]))
}

export interface AccountFilter {
  system: SystemId | 'all'
  tag: string
  query?: string
}

/** Channel IDs are the immutable automatic tags. */
export function systemTag(system: SystemId): string {
  return system
}

export function allTags(accounts: PanelAccount[]): string[] {
  const tags = new Set<string>()
  for (const account of accounts) for (const tag of account.tags) tags.add(tag)
  return [...tags].sort((a, b) => a.localeCompare(b, 'zh-CN'))
}

export function matchesFilter(account: PanelAccount, filter: AccountFilter): boolean {
  if (filter.system !== 'all' && account.system !== filter.system) return false
  if (filter.tag && !account.tags.includes(filter.tag)) return false
  const query = filter.query?.trim().toLowerCase()
  if (
    query &&
    ![account.label, account.id, account.detail ?? ''].some((value) =>
      value.toLowerCase().includes(query),
    )
  )
    return false
  return true
}

export function filterAccounts(accounts: PanelAccount[], filter: AccountFilter): PanelAccount[] {
  return accounts.filter((account) => matchesFilter(account, filter))
}

/** Counts per system for the sidebar badge and the filter chips. */
export function countBySystem(accounts: PanelAccount[]): Record<SystemId, number> {
  const counts: Record<SystemId, number> = Object.fromEntries(SYSTEM_IDS.map((id) => [id, 0]))
  for (const account of accounts) if (isSystemId(account.system)) counts[account.system]++
  return counts
}

export const MAX_TAG_LENGTH = 24
export const MAX_TAGS = 8

/** Trim, de-duplicate and bound user tags. The system tag is never a user tag. */
export function normalizeTags(input: readonly string[]): string[] {
  const tags: string[] = []
  for (const raw of input) {
    const tag = String(raw ?? '')
      .trim()
      .slice(0, MAX_TAG_LENGTH)
    if (!tag || tags.includes(tag)) continue
    if (SYSTEM_IDS.includes(tag as SystemId)) continue
    tags.push(tag)
    if (tags.length >= MAX_TAGS) break
  }
  return tags
}

/** Split `"<system>:<nativeId>"`; the native id may itself contain colons. */
export function parseAccountId(id: string): { system: SystemId | null; nativeId: string } {
  const separator = id.indexOf(':')
  if (separator < 0) return { system: null, nativeId: id }
  const head = id.slice(0, separator)
  return {
    system: isSystemId(head) ? head : null,
    nativeId: id.slice(separator + 1),
  }
}

export function normalizeAccount(entry: unknown): PanelAccount | null {
  if (!entry || typeof entry !== 'object') return null
  const raw = entry as Record<string, unknown>
  const parsed =
    typeof raw.id === 'string' ? parseAccountId(raw.id) : { system: null, nativeId: '' }
  const system = isSystemId(raw.system) ? raw.system : parsed.system
  if (!system) return null
  const id =
    typeof raw.id === 'string' && raw.id.includes(':') ? raw.id : `${system}:${parsed.nativeId}`
  const tags = Array.isArray(raw.tags)
    ? normalizeTags(raw.tags.filter((tag): tag is string => typeof tag === 'string'))
    : []
  const quota = raw.quota && typeof raw.quota === 'object' ? raw.quota : null
  return {
    id,
    system,
    label: typeof raw.label === 'string' && raw.label ? raw.label : parsed.nativeId || '未命名账号',
    status: typeof raw.status === 'string' && raw.status ? raw.status : 'unknown',
    quota: quota ? (quota as PanelAccount['quota']) : null,
    tags: tags.includes(systemTag(system)) ? tags : [systemTag(system), ...tags],
    detail: typeof raw.detail === 'string' ? raw.detail : null,
    error: typeof raw.error === 'string' ? raw.error : null,
  }
}

/** Accept both `{ accounts: [...] }` and a bare array, as cnb2api-panel does. */
export function normalizeAccountList(payload: unknown): PanelAccount[] {
  const list = Array.isArray(payload)
    ? payload
    : payload &&
        typeof payload === 'object' &&
        Array.isArray((payload as { accounts?: unknown }).accounts)
      ? (payload as { accounts: unknown[] }).accounts
      : []
  return list.flatMap((entry) => {
    const account = normalizeAccount(entry)
    return account ? [account] : []
  })
}

/** Used share of the total, 0-100. Legacy: the console now shows remaining. */
export function quotaPercent(quota: PanelAccount['quota']): number | null {
  if (!quota) return null
  if (typeof quota.percent === 'number' && Number.isFinite(quota.percent))
    return Math.max(0, Math.min(100, quota.percent))
  const total = finite(quota.total)
  const used = finite(quota.used)
  if (total === null || total <= 0 || used === null) return null
  return Math.max(0, Math.min(100, (used / total) * 100))
}

/** Anything the console may receive as a quota object, per-channel or not. */
export type QuotaLike =
  | {
      total?: number | null
      used?: number | null
      remaining?: number | null
      percent?: number | null
    }
  | null
  | undefined

export interface QuotaProgress {
  /** Filled from `remaining`, or from `total - used` when only those were sent. */
  remaining: number | null
  total: number | null
  /** Remaining share of the total, 0-100; `null` when the total is unknown. */
  percent: number | null
  /** `low` = nearly exhausted, `warn` = getting low, `ok` = healthy. */
  tone: 'ok' | 'warn' | 'low'
}

/**
 * The whole console shows "remaining / total", so the bar length is the remaining
 * share. A server that only reports `used` still gets a remaining value by
 * subtracting, which keeps older payloads working.
 */
export function quotaProgress(quota: QuotaLike): QuotaProgress {
  const total = finite(quota?.total)
  const used = finite(quota?.used)
  const usedPercent = finite(quota?.percent)
  let remaining = finite(quota?.remaining)
  if (remaining === null && total !== null && used !== null) remaining = total - used
  if (remaining === null && total !== null && usedPercent !== null)
    // `total * (1 - p)` loses precision; subtract the used amount instead.
    remaining = total - (total * usedPercent) / 100
  if (remaining !== null) remaining = Math.max(0, remaining)
  if (remaining !== null && total !== null && total > 0) remaining = Math.min(remaining, total)
  const percent =
    remaining === null || total === null || total <= 0
      ? null
      : Math.max(0, Math.min(100, Math.round((remaining / total) * 10000) / 100))
  const tone: QuotaProgress['tone'] =
    remaining === 0 || (percent !== null && percent < 5)
      ? 'low'
      : percent !== null && percent < 20
        ? 'warn'
        : 'ok'
  return { remaining, total, percent, tone }
}

const STATUS_LABELS: Record<string, string> = {
  healthy: '可用',
  ready: '可用',
  ok: '可用',
  active: '可用',
  cooling: '冷却中',
  pending: '待接入',
  disabled: '已停用',
  offline: '离线',
  unhealthy: '异常',
  error: '异常',
  expired: '已过期',
  quota: '额度暂停',
  unknown: '未知',
}

export function statusLabel(status: string): string {
  return STATUS_LABELS[status.trim().toLowerCase()] ?? status
}

const STATUS_TONES: Record<string, 'green' | 'amber' | 'slate' | 'gray'> = {
  healthy: 'green',
  ready: 'green',
  ok: 'green',
  active: 'green',
  cooling: 'amber',
  quota: 'amber',
  pending: 'slate',
  unknown: 'slate',
  disabled: 'gray',
  expired: 'gray',
  offline: 'gray',
  unhealthy: 'gray',
  error: 'gray',
}

export function statusTone(status: string): 'green' | 'amber' | 'slate' | 'gray' {
  return STATUS_TONES[status.trim().toLowerCase()] ?? 'slate'
}

const HEALTH_LABELS: Record<SystemHealth, string> = {
  ok: '运行正常',
  degraded: '部分降级',
  offline: '离线',
  unknown: '状态未知',
}

export function healthLabel(health: SystemHealth): string {
  return HEALTH_LABELS[health]
}

export function healthTone(health: SystemHealth): 'green' | 'amber' | 'slate' | 'gray' {
  if (health === 'ok') return 'green'
  if (health === 'degraded') return 'amber'
  if (health === 'offline') return 'gray'
  return 'slate'
}

/**
 * `GET /api/settings` answers with a `systems` array; a `services` map and a
 * `serviceUrls` map are also accepted so an alternative server shape works.
 */
export function serviceInfo(
  settings: PanelSettings | null,
  system: SystemId,
): PanelServiceInfo | null {
  if (!settings) return null
  const entry =
    settings.systems?.find((item) => item.system === system) ?? settings.services?.[system]
  const url = entry?.url ?? settings.serviceUrls?.[system]
  // A panel that only lists configured systems still reports its URLs.
  if (!entry && !url) return null
  return { ...entry, ...(url ? { url } : {}) }
}

/** Settings health tokens differ per system; the page renders one vocabulary. */
export function serviceHealth(info: PanelServiceInfo | null): SystemHealth | null {
  const value = typeof info?.health === 'string' ? info.health.trim().toLowerCase() : ''
  if (value === 'down') return 'offline'
  if (value === 'healthy' || value === 'up' || value === 'ready') return 'ok'
  if (value === 'warning' || value === 'partial') return 'degraded'
  return HEALTH_TOKENS[value] ?? null
}

/** `GET /api/accounts` reports per-system read failures next to the list. */
export function normalizeAccountsErrors(value: unknown): AccountsError[] {
  if (!Array.isArray(value)) return []
  return value.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return []
    const item = entry as { system?: unknown; error?: unknown }
    if (!isSystemId(item.system)) return []
    const raw = item.error
    const message =
      typeof raw === 'string'
        ? raw
        : typeof (raw as { message?: unknown } | null)?.message === 'string'
          ? (raw as { message: string }).message
          : '该系统账号读取失败'
    const code =
      typeof (raw as { code?: unknown } | null)?.code === 'string'
        ? (raw as { code: string }).code
        : ''
    return [{ system: item.system, error: { message, ...(code ? { code } : {}) } }]
  })
}

/** Localized number with an em dash for missing values. */
export function formatNumber(value: number | null | undefined, digits = 0): string {
  return value == null || !Number.isFinite(value)
    ? '—'
    : value.toLocaleString('zh-CN', { maximumFractionDigits: digits })
}

export function formatPercent(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value)
    ? '—'
    : `${value.toLocaleString('zh-CN', { maximumFractionDigits: 1 })}%`
}

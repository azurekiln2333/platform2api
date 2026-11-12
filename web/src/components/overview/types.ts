/**
 * Overview sections are declared by the backend (contract in
 * `.trellis/tasks/11-11-true-unified-console/ui-fixes.md` §3). Rendering is
 * driven by `kind`, so a new channel only has to return sections; this module
 * owns the local types and the request helper, kept out of `api.ts` /
 * `console-types.ts` on purpose (parallel UI work package U2).
 */
import { api } from '../../api.ts'
import type { ConsoleOverview } from '../../console-types.ts'

export type SectionTone = 'ok' | 'warn' | 'error' | 'muted'

export interface StatsItem {
  label: string
  value: unknown
  hint?: string
  tone?: SectionTone
}
export interface StatsSection {
  kind: 'stats'
  id: string
  title: string
  items: StatsItem[]
}

export interface QuotaListItem {
  id: string
  label: string
  remaining?: number | null
  used?: number | null
  total?: number | null
  unit?: string
  status?: string
}
export interface QuotaListSection {
  kind: 'quotaList'
  id: string
  title: string
  items: QuotaListItem[]
}

export interface SeriesBucket {
  t: string
  values: Record<string, number>
}
export interface SeriesSection {
  kind: 'series'
  id: string
  title: string
  unit?: string
  buckets: SeriesBucket[]
}

export interface TableColumn {
  key: string
  label: string
  kind?: string
}
export interface TableSection {
  kind: 'table'
  id: string
  title: string
  columns: TableColumn[]
  rows: Record<string, unknown>[]
}

/** Unknown future kinds stay visible as a labelled placeholder instead of failing. */
export interface UnsupportedSection {
  kind: 'unsupported'
  id: string
  title: string
  source: string
}

export type OverviewSection =
  StatsSection | QuotaListSection | SeriesSection | TableSection | UnsupportedSection

export interface SystemOverview {
  system: string
  generatedAt: string
  sections: OverviewSection[]
  /** True when the payload came from the aggregate overview instead of `/overview/:system`. */
  fallback?: boolean
}

const TONES: SectionTone[] = ['ok', 'warn', 'error', 'muted']

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : [])
const asRecord = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {}
const asText = (value: unknown) =>
  value === null || value === undefined ? '' : typeof value === 'string' ? value : String(value)
const asNumber = (value: unknown): number | null => {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null
  if (typeof value === 'string' && value.trim() && Number.isFinite(Number(value)))
    return Number(value)
  return null
}
const asTone = (value: unknown): SectionTone | undefined =>
  typeof value === 'string' && (TONES as string[]).includes(value)
    ? (value as SectionTone)
    : undefined

/** `remaining` wins; when the backend only knows `used`/`total`, derive it here. */
export function quotaRemaining(
  quota:
    | {
        remaining?: number | null
        used?: number | null
        total?: number | null
      }
    | null
    | undefined,
) {
  if (!quota) return null
  if (quota.remaining !== null && quota.remaining !== undefined) return quota.remaining
  if (
    quota.total !== null &&
    quota.total !== undefined &&
    quota.used !== null &&
    quota.used !== undefined
  )
    return Math.max(0, quota.total - quota.used)
  return null
}

function normalizeStats(record: Record<string, unknown>, fallbackId: string): StatsSection {
  const items: StatsItem[] = []
  for (const raw of asArray(record.items)) {
    const item = asRecord(raw)
    const label = asText(item.label) || asText(item.key)
    if (!label) continue
    items.push({
      label,
      value: item.value ?? null,
      hint: asText(item.hint) || undefined,
      tone: asTone(item.tone),
    })
  }
  return {
    kind: 'stats',
    id: asText(record.id) || fallbackId,
    title: asText(record.title) || '统计',
    items,
  }
}

function normalizeQuotaList(record: Record<string, unknown>, fallbackId: string): QuotaListSection {
  const items: QuotaListItem[] = []
  const raw = asArray(record.items)
  for (let index = 0; index < raw.length; index++) {
    const item = asRecord(raw[index])
    const label = asText(item.label) || asText(item.name) || asText(item.id)
    if (!label) continue
    items.push({
      id: asText(item.id) || `${fallbackId}-${index}`,
      label,
      remaining: asNumber(item.remaining),
      used: asNumber(item.used),
      total: asNumber(item.total),
      unit: asText(item.unit) || undefined,
      status: asText(item.status) || undefined,
    })
  }
  return {
    kind: 'quotaList',
    id: asText(record.id) || fallbackId,
    title: asText(record.title) || '额度',
    items,
  }
}

function normalizeSeries(record: Record<string, unknown>, fallbackId: string): SeriesSection {
  const buckets = asArray(record.buckets).map((raw) => {
    const bucket = asRecord(raw)
    const values: Record<string, number> = {}
    for (const [key, value] of Object.entries(asRecord(bucket.values)))
      values[key] = asNumber(value) ?? 0
    return { t: asText(bucket.t), values }
  })
  return {
    kind: 'series',
    id: asText(record.id) || fallbackId,
    title: asText(record.title) || '趋势',
    unit: asText(record.unit) || undefined,
    buckets,
  }
}

function normalizeTable(record: Record<string, unknown>, fallbackId: string): TableSection {
  const columns: TableColumn[] = []
  for (const raw of asArray(record.columns)) {
    const column = asRecord(raw)
    const key = asText(column.key)
    if (!key) continue
    columns.push({
      key,
      label: asText(column.label) || key,
      kind: asText(column.kind) || undefined,
    })
  }
  const rows = asArray(record.rows).map((raw) => asRecord(raw))
  return {
    kind: 'table',
    id: asText(record.id) || fallbackId,
    title: asText(record.title) || '列表',
    columns,
    rows,
  }
}

export function parseSections(value: unknown): OverviewSection[] {
  const sections: OverviewSection[] = []
  const raw = asArray(value)
  for (let index = 0; index < raw.length; index++) {
    const record = asRecord(raw[index])
    const kind = asText(record.kind)
    const fallbackId = `${kind || 'section'}-${index}`
    if (kind === 'stats') sections.push(normalizeStats(record, fallbackId))
    else if (kind === 'quotaList') sections.push(normalizeQuotaList(record, fallbackId))
    else if (kind === 'series') sections.push(normalizeSeries(record, fallbackId))
    else if (kind === 'table') sections.push(normalizeTable(record, fallbackId))
    else {
      const title = asText(record.title)
      if (!title && !kind) continue
      sections.push({
        kind: 'unsupported',
        id: asText(record.id) || fallbackId,
        title: title || '概览区块',
        source: kind || 'unknown',
      })
    }
  }
  return sections
}

export function parseSystemOverview(payload: unknown, system: string): SystemOverview {
  const record = asRecord(payload)
  return {
    system: asText(record.system) || system,
    generatedAt: asText(record.generatedAt) || new Date().toISOString(),
    sections: parseSections(record.sections),
  }
}

export async function fetchSystemOverview(system: string): Promise<SystemOverview> {
  const payload = await api<unknown>(`/overview/${encodeURIComponent(system)}`)
  return parseSystemOverview(payload, system)
}

/**
 * Until `/api/overview/:system` is served, or when that channel is unreachable,
 * the detail view degrades to what the aggregate overview already knows.
 */
export function buildFallbackSections(
  system: string,
  overview: ConsoleOverview | null,
): OverviewSection[] {
  const channel = overview?.channels?.find((item) => item.system === system)
  if (!channel) return []
  const sections: OverviewSection[] = []
  const accounts = channel.accounts
  if (accounts) {
    sections.push({
      kind: 'stats',
      id: 'accounts',
      title: '账号',
      items: [
        { label: '账号（可用 / 总数）', value: `${accounts.ok ?? 0} / ${accounts.total ?? 0}` },
        { label: '异常账号', value: accounts.error ?? 0, tone: accounts.error ? 'error' : 'ok' },
        { label: '已停用', value: accounts.disabled ?? 0, tone: 'muted' },
      ],
    })
  }
  const remaining = quotaRemaining(channel.quota)
  if (channel.quota && (remaining !== null || (channel.quota.total ?? null) !== null)) {
    sections.push({
      kind: 'quotaList',
      id: 'quota',
      title: '额度',
      items: [
        {
          id: `${system}:quota`,
          label: '渠道额度',
          remaining,
          total: channel.quota.total ?? null,
          unit: channel.quota.unit,
        },
      ],
    })
  }
  const buckets = asArray(overview?.hourly).map((raw) => {
    const row = asRecord(raw)
    return { t: asText(row.hour), values: { [system]: asNumber(row[system]) ?? 0 } }
  })
  if (buckets.length)
    sections.push({ kind: 'series', id: 'hourly', title: '今日请求分布', unit: '次', buckets })
  const attention = asArray(overview?.attention).filter(
    (item) => asText(asRecord(item).system) === system,
  )
  if (attention.length)
    sections.push({
      kind: 'table',
      id: 'attention',
      title: '待处理',
      columns: [
        { key: 'message', label: '说明' },
        { key: 'kind', label: '类型', kind: 'mono' },
      ],
      rows: attention.map((item) => {
        const row = asRecord(item)
        return { message: asText(row.message), kind: asText(row.kind) }
      }),
    })
  return sections
}

export interface Descriptor {
  key: string
  label: string
  value: unknown
  kind: 'text' | 'mono' | 'time' | 'badge' | 'quota' | 'bool' | 'link'
  /** Only for `kind: "link"`; opened in a new tab. */
  href?: string
}
export interface Action {
  id: string
  label: string
  danger?: boolean
  confirm?: string | boolean
  /** `true` renders the action as a card shortcut instead of the ⋯ menu. */
  quick?: boolean
}
export interface Field {
  key: string
  label: string
  type: string
  value?: unknown
  help?: string
  options?: (string | { value: string | number; label: string })[]
  min?: number
  max?: number
  required?: boolean
}
export interface Channel {
  system: string
  label: string
  color: string
  health: string
  detail?: string
  inferenceUrl: string
  unifiedUrl?: string
  inference?: { url: string; routes: string[] }
  capabilities: {
    accounts: {
      add: string[]
      batch: string[]
      /** Channel-level operations declared by the server (e.g. wake every workspace). */
      channelActions?: ChannelAction[]
    }
    keys: {
      create: boolean
      update: boolean
      delete: boolean
      reveal: boolean
      rotate: boolean
      resetUsage: boolean
      fields: Field[]
    }
    models: { toggle: boolean }
    logs: { kinds: string[]; filters: string[] }
    usage: { extras: string[] }
  }
}
export interface ChannelsResponse {
  channels: Channel[]
  unifiedUrl: string
}
/** A channel-level operation, declared by the server — never hard-coded per channel. */
export interface ChannelAction {
  id: string
  label: string
}
export interface ChannelActionFailure {
  id: string
  label: string
  message: string
}
export interface ChannelActionResponse {
  total: number
  started: number
  failed: ChannelActionFailure[]
}
export interface AggregateError {
  system: string
  message: string
  code?: string
}
export interface Aggregate<T> {
  items: T[]
  errors: AggregateError[]
}
export interface Quota {
  unit?: string
  total?: number | null
  used?: number | null
  remaining?: number | null
  percent?: number | null
  metrics?: (Quota & { label?: string })[]
  label?: string
  note?: string
}
export interface Account {
  id: string
  system: string
  label: string
  status: string
  enabled: boolean
  quota?: Quota | null
  lastUsedAt?: string | null
  tags: string[]
  primary?: string | Descriptor[]
  display: Descriptor[]
  actions: Action[]
}
export interface KeyItem {
  revision?: number
  id: string
  via: 'unified' | 'direct'
  system: string | null
  channels: '*' | string[]
  name: string
  masked: string
  enabled: boolean
  builtin: boolean
  createdAt?: string | null
  lastUsedAt?: string | null
  usage?: number | Record<string, unknown> | null
  limits: {
    models?: string[]
    quota?: number | { requests?: number; tokens?: number } | null
    expiresAt?: string | null
    ipAllow?: string[]
    [key: string]: unknown
  }
}
export interface Routing {
  order: string[]
  enabled: Record<string, boolean>
  failover: boolean
}
export interface ModelItem {
  revision?: number
  id: string
  system: string
  model: string
  enabled: boolean | null
  display: Descriptor[]
  actions: Action[]
}
export interface LogItem {
  id: string
  via: 'unified' | 'direct'
  system: string
  at: string
  model?: string
  account?: string
  key?: string
  status?: number
  durationMs?: number
  inputTokens?: number
  outputTokens?: number
  stream?: boolean
  error?: string
}
export interface LogsResponse extends Aggregate<LogItem> {
  nextCursor: string | null
}
export interface LogDetail {
  item: LogItem
  display: Descriptor[]
  raw: unknown
}
export interface UsageRow {
  bucket: string
  system: string
  requests: number
  inputTokens: number
  outputTokens: number
}
export interface UsageTop {
  system?: string
  name?: string
  model?: string
  key?: string
  account?: string
  requests?: number
  inputTokens?: number
  outputTokens?: number
  [key: string]: unknown
}
export interface UsageResponse {
  series: UsageRow[]
  byModel: UsageTop[]
  byKey: UsageTop[]
  byAccount: UsageTop[]
  extras: Record<string, unknown>
  errors: AggregateError[]
}
export interface AccountCounts {
  total: number
  ok: number
  error: number
  disabled: number
}
export interface OverviewChannel {
  system: string
  ok: boolean
  health: string
  detail?: string
  accounts: AccountCounts
  quota: Quota | null
  requestsToday: number | null
  tokensToday: number | null
  errorsToday?: number | null
  partial?: boolean
  error?: string | { message?: string }
}
export interface ConsoleOverview {
  generatedAt: string
  totals: {
    accounts: AccountCounts
    requestsToday: number
    tokensToday: number
    errorsToday: number
    partial?: boolean
  }
  channels: OverviewChannel[]
  hourly: { hour: string; [system: string]: string | number }[]
  attention: { system: string; kind: string; message: string; link: string }[]
  errors?: AggregateError[]
}
export interface SettingsGroup {
  revision?: number
  id: string
  title: string
  description?: string
  fields: Field[]
}
export interface ConsoleSettings {
  version: string
  auth?: unknown
  services: { system: string; url: string; health?: string; detail?: string }[]
  common: SettingsGroup[]
  channels: { system: string; groups: SettingsGroup[]; embeds: string[] }[]
  errors?: AggregateError[]
}

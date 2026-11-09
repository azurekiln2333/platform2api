/** One managed upstream system. System tags are automatic, never user-edited. */
export type SystemId = 'cnb' | 'codebuddy' | 'zcode'

export type SystemHealth = 'ok' | 'degraded' | 'offline' | 'unknown'

/** A single quota figure. Each system keeps its own unit; values are never merged. */
export interface QuotaMetric {
  label: string
  unit: string
  total: number | null
  used: number | null
  remaining: number | null
}

export interface QuotaSnapshot extends QuotaMetric {
  syncedAt: string | null
  metrics?: QuotaMetric[]
  note?: string
}

export interface OverviewAccountCounts {
  total: number | null
  ready: number | null
  paused?: number | null
}

export interface OverviewUsageMetric {
  label: string
  value: number | null
  unit?: string
  digits?: number
}

/** Per-system overview payload as consumed by the shell. */
export interface SystemOverview {
  health: SystemHealth
  healthMessage?: string
  accounts?: OverviewAccountCounts | null
  quota?: QuotaSnapshot | null
  usage?: OverviewUsageMetric[] | null
  generatedAt?: string | null
  error?: { message: string } | null
  [key: string]: unknown
}

export type OverviewResponse = Partial<Record<SystemId, SystemOverview | null>>

export interface AccountQuota {
  unit?: string
  total?: number | null
  used?: number | null
  remaining?: number | null
  percent?: number | null
}

/** Unified account row: `id` is `<system>:<nativeId>`. */
export interface PanelAccount {
  id: string
  system: SystemId
  label: string
  status: string
  quota?: AccountQuota | null
  tags: string[]
  detail?: string | null
  error?: string | null
}

export type AuthFlowStatus = 'pending' | 'success' | 'failed' | 'expired'

export interface AuthFlowInput {
  name: string
  label: string
  placeholder?: string
  secret?: boolean
  required?: boolean
}

export interface AuthFlowStep {
  title?: string
  message?: string
  url?: string
  urlLabel?: string
}

/** Adapter-driven authorization flow rendered by the shell. */
export interface AuthFlow {
  flowId: string
  system: SystemId
  status: AuthFlowStatus
  message?: string
  url?: string
  steps?: AuthFlowStep[]
  inputs?: AuthFlowInput[]
  accountId?: string | null
  pollIntervalMs?: number
  error?: string
}

export interface AuthConfig {
  keyLoginEnabled: boolean
  sso: { enabled: boolean; providerName: string; loginUrl: string }
}

export interface SessionUser {
  name: string
  email: string
  picture: string
  provider: 'key' | 'oidc'
}

export interface PanelServiceInfo {
  system?: SystemId
  url?: string
  tokenConfigured?: boolean
  health?: SystemHealth
  message?: string
  stub?: boolean
}

/**
 * `GET /api/settings`: the panel server returns a `systems` array; a `services`
 * map is also accepted so the console works against either shape.
 */
export interface PanelSettings {
  systems?: PanelServiceInfo[]
  services?: Partial<Record<SystemId, PanelServiceInfo>>
  serviceUrls?: Partial<Record<SystemId, string>>
  ssoCallbackUrl?: string
  panelUrl?: string
  version?: string
  dataDir?: string
}

/** Per-system account read failure reported by `GET /api/accounts`. */
export interface AccountsError {
  system: SystemId
  error: { message?: string; code?: string }
}

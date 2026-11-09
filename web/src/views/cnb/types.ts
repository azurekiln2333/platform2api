/**
 * CNB management payloads as returned by the cnb2api-panel service through
 * `/api/p/cnb/*`. Shapes mirror the source console (research/cnb-management.md);
 * fields the console does not read stay `unknown` on purpose.
 */

export interface CnbCredits {
  total: number
  used: number
  freeze: number
}

export interface CnbQuota {
  org?: string
  credits: CnbCredits
  dev?: Partial<CnbCredits>
  ci?: { total?: number; used?: number }
  syncedAt?: string | null
  plans?: Array<Record<string, unknown>>
}

export interface CnbQuotaProtection {
  suspended?: boolean
  reason?: 'low' | 'sync-error' | 'invalid' | string
  thresholdPercent?: number
}

export interface CnbAccount {
  id: string
  name: string
  repo?: string
  group?: string
  endpoint?: string | null
  enabled: boolean
  status: 'healthy' | 'unhealthy' | 'pending' | string
  models?: string[]
  discoveredModels?: string[]
  branch?: string
  weight?: number
  priority?: number
  upstreamMode?: 'inherit' | 'auto' | 'ide' | 'classic' | string
  autoWake?: boolean
  quotaProtectionOverride?: boolean
  cooldownUntil?: string | null
  lastError?: string | null
  quota?: CnbQuota | null
  quotaProtection?: CnbQuotaProtection | null
  checkedAt?: string | null
  registeredAt?: string | null
  latencyMs?: number | null
  createdAt?: string | null
  updatedAt?: string | null
  secrets?: Record<string, string>
}

export interface CnbHourlyBucket {
  at: string
  requests: number
  errors: number
  durationMs?: number
  tokenUsage?: Record<string, number> | null
}

export interface CnbTokenUsage {
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  total?: number
}

export interface CnbStats {
  total?: number
  ready?: number
  cooling?: number
  requests?: number
  errors?: number
  successRate?: number | null
  remainingCredits?: number | null
  quotaOrganizations?: number
  averageDurationMs?: number | null
  activeRequests?: number
  tokenUsage?: { today?: CnbTokenUsage; total?: CnbTokenUsage; startedAt?: string | null } | null
}

export interface CnbSettings {
  strategy?: 'weighted' | 'least-connections' | 'failover'
  sessionAffinity?: boolean
  maxAttempts?: number
  cooldownSeconds?: number
  healthIntervalSeconds?: number
  connectTimeoutSeconds?: number
  idleTimeoutSeconds?: number
  dshCompat?: boolean
  claudeCodeCompat?: boolean
  requestOverrides?: { operations?: Array<Record<string, unknown>> }
  upstreamHeaders?: Record<string, string>
  quotaProtection?: { enabled?: boolean; thresholdPercent?: number }
  inferenceProbe?: { enabled?: boolean; intervalMinutes?: number }
  registrationRelay?: { enabled?: boolean; servers?: Array<Record<string, unknown>> }
  [key: string]: unknown
}

export interface CnbOverview {
  accounts: CnbAccount[]
  settings: CnbSettings
  hourly: CnbHourlyBucket[]
  creditRates?: Record<string, unknown> | null
  stats: CnbStats
}

export interface CnbModelAccount {
  id: string
  name: string
}

export interface CnbModelEntry {
  id: string
  listed: boolean
  configuredAccounts: CnbModelAccount[]
  discoveredAccounts: CnbModelAccount[]
  eligibleAccounts: CnbModelAccount[]
}

export type CnbLogChannel = 'requests' | 'audit' | 'system'

export interface CnbLogEntry {
  id: string
  at?: string
  createdAt?: string
  kind?: string
  outcome?: string
  message?: string
  method?: string
  path?: string
  status?: number | string
  durationMs?: number | null
  account?: string | null
  model?: string | null
  actor?: string | null
  target?: string | null
  detail?: unknown
  [key: string]: unknown
}

export interface CnbLogPage {
  logs: CnbLogEntry[]
  total?: number
  limit?: number
  offset?: number
}

export interface CnbLogQuery {
  limit: number
  offset: number
  q: string
  outcome: string
  kind: string
}

export interface CnbCreditRateWindow {
  window?: string
  accounts?: Array<Record<string, unknown>>
  totals?: Record<string, unknown>
  series?: Array<Record<string, unknown>>
  [key: string]: unknown
}

export interface CnbUsageHistoryDay {
  date: string
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
  requests?: number
  errors?: number
  partial?: boolean
  [key: string]: unknown
}

export interface CnbUsageHistory {
  days?: number
  totals?: Record<string, unknown>
  series?: CnbUsageHistoryDay[]
  accounts?: Array<Record<string, unknown>>
  [key: string]: unknown
}

export interface CnbUsageComparison {
  accounts?: Array<Record<string, unknown>>
  totals?: Record<string, unknown>
  generatedAt?: string
  [key: string]: unknown
}

export interface CnbRegistrationRelayServer {
  id: string
  name: string
  origin: string
  enabled: boolean
  status?: string
  pending?: number
  failed?: number
  lastAttemptAt?: string | null
  lastSuccessAt?: string | null
  lastError?: string
}

export interface CnbRegistrationRelayStatus {
  enabled: boolean
  servers: CnbRegistrationRelayServer[]
}

export interface CnbAccess {
  publicUrl?: string
  maskedKey: string
}

export interface CnbSsoSettings {
  enabled?: boolean
  providerName?: string
  issuer?: string
  clientId?: string
  clientSecret?: string
  scope?: string
  keyLoginEnabled?: boolean
  allowedSubjects?: string[]
  allowedEmails?: string[]
  callbackUrl?: string
  hasClientSecret?: boolean
  loginUrl?: string
  sso?: { enabled?: boolean; providerName?: string; loginUrl?: string }
  [key: string]: unknown
}

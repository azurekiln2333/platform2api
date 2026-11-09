/**
 * ZCode management payloads as returned by zcode2api through `/api/p/zcode/*`.
 * Shapes follow the console's `buildOverview()` and the root legacy routes
 * (research/zcode-management.md); unread fields stay `unknown` on purpose.
 */

export interface ZcodeCredits {
  total: number
  used: number
  freeze: number
}

export interface ZcodeQuota {
  org?: string
  credits: ZcodeCredits
  syncedAt?: string | null
  plans?: Array<Record<string, unknown>>
  balances?: Array<Record<string, unknown>>
}

export interface ZcodeQuotaSource {
  id: string
  name: string
  status: string
  plans?: Array<Record<string, unknown>>
  syncedAt?: string | null
  error?: string | null
}

export interface ZcodeAccount {
  label: string
  name?: string
  email?: string
  phone?: string
  identity?: string
  realm?: string
  enabled?: boolean
  disabled?: boolean
  status?: string
  cooldownUntil?: number | string | null
  degradeUntil?: number | null
  lastErr?: string | null
  lastSuccess?: string | null
  weight?: number
  quota?: ZcodeQuota | null
  quotaSources?: ZcodeQuotaSource[]
  eligibility?: Record<string, unknown> | null
  eligibilityRefreshing?: boolean
  hasCodingPlanKey?: boolean
  codingPlanProvider?: string
  plans?: Array<Record<string, unknown>>
  requests?: number
  errors?: number
  activeRequests?: number
  inFlight?: number
  createdAt?: string
  updatedAt?: string
  tokenUsage?: Record<string, number>
  failures?: number
  consecutiveFails?: number
  available?: boolean
  cooling?: boolean
}

export interface ZcodeHourlyBucket {
  at?: string
  t?: number
  requests: number
  errors?: number
  fails?: number
  tokens?: number
}

export interface ZcodeStats {
  total?: number
  ready?: number
  cooling?: number
  disabled?: number
  requests?: number
  errors?: number
  successRate?: number | null
  remainingCredits?: number | null
  totalCredits?: number | null
  quotaOrganizations?: number
  averageDurationMs?: number | null
  activeRequests?: number
  tokenUsage?: Record<string, unknown>
}

export interface ZcodeClaimAutomation {
  settings?: Record<string, unknown>
  nextRunAt?: string | null
  running?: boolean
  lastRun?: Record<string, unknown> | null
  error?: string | null
  browser?: Record<string, unknown> | null
}

export interface ZcodeSettings {
  strategy?: string
  sessionAffinity?: boolean
  stickyTtlMin?: number
  topN?: number
  maxInFlight?: number
  breakerThreshold?: number
  breakerCooldownMin?: number
  blockedCooldownMin?: number
  quotaCooldownMin?: number
  busyCooldownSec?: number
  minPickGapMs?: number
  idleWeightPerHour?: number
  idleWeightMax?: number
  weightBalFactor?: number
  weightSuccFactor?: number
  weekendGrab?: boolean
  limits?: Record<string, [number, number] | number>
  [key: string]: unknown
}

export interface ZcodeOverview {
  accounts: ZcodeAccount[]
  settings: ZcodeSettings
  hourly: ZcodeHourlyBucket[]
  stats: ZcodeStats
  claimAutomation?: ZcodeClaimAutomation
}

export interface ZcodeModelAccount {
  id: string
  name: string
}

export interface ZcodeModelEntry {
  id: string
  listed?: boolean
  configuredAccounts?: ZcodeModelAccount[]
  discoveredAccounts?: ZcodeModelAccount[]
  eligibleAccounts?: ZcodeModelAccount[]
}

export interface ZcodeLogRow {
  t?: number
  at?: string
  key?: string
  acc?: string
  model?: string
  ok?: boolean
  status?: number
  ms?: number
  in?: number
  out?: number
  cacheRead?: number
  cacheCreate?: number
  [key: string]: unknown
}

export interface ZcodeLogPage {
  logs: ZcodeLogRow[]
  total?: number
  limit?: number
  offset?: number
}

export interface ZcodeAccess {
  publicUrl?: string
  maskedKey: string
  gatewayKeySet?: boolean
  models?: Array<{ id: string; name?: string; context?: number; maxOutput?: number }>
}

export interface ZcodeKey {
  id: number
  name: string
  prefix?: string
  enabled?: boolean
  realm?: string
  expiresAt?: number
  models?: string[]
  ipAllowlist?: string[]
  quotaTokens?: number
  usedTokens?: number
  requests?: number
  createdAt?: number
  lastUsedAt?: number
  note?: string
}

export interface ZcodeKeysPage {
  keys: ZcodeKey[]
  total: number
  masterKeyEnabled?: boolean
  openMode?: boolean
}

export interface ZcodeSecurityRule {
  type: 'allow' | 'deny'
  cidr: string
  note?: string
  createdAt?: number
}

export interface ZcodeSecurity {
  enabled: boolean
  mode: 'blacklist' | 'whitelist'
  rules: ZcodeSecurityRule[]
  blocked?: Array<Record<string, unknown>>
  blockedTotal?: number
}

export interface ZcodeStatsPage {
  from?: number
  to?: number
  bucketMs?: number
  totals?: Record<string, number>
  buckets?: Array<{ t: number; requests: number; tokens: number; fails: number }>
  byModel?: Array<Record<string, unknown>>
  byKey?: Array<Record<string, unknown>>
  byAccount?: Array<Record<string, unknown>>
  recent?: ZcodeLogRow[]
}

export interface ZcodeOnboardFlow {
  flowId: string
  status: 'pending' | 'ready' | string
  authorizeUrl?: string
  expiresAt?: string
  pollIntervalSec?: number
  provider?: string
  label?: string
  userId?: string
  email?: string
  added?: boolean
  claim?: Record<string, unknown> | null
  error?: string
  code?: string
}

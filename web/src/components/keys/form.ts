import type { Field, KeyItem } from '../../console-types.ts'

export function dateTimeInput(value: unknown): string {
  if (!value) return ''
  const date = new Date(String(value))
  if (Number.isNaN(date.getTime())) return ''
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60000)
  return local.toISOString().slice(0, 16)
}

/** The gateway persists one quota object; form fields are only a presentation. */
export function keyFormLimits(item: KeyItem | null, fields: Field[]) {
  const values: Record<string, unknown> = { ...item?.limits }
  if (item?.via === 'unified') {
    const quota = item.limits.quota
    values.quotaTokens = typeof quota === 'number' ? quota : (quota?.tokens ?? null)
    values.quotaRequests = typeof quota === 'object' && quota ? (quota.requests ?? null) : null
  }
  for (const field of fields) {
    if (field.type === 'secret') values[field.key] = ''
    if (field.key === 'expiresAt') values[field.key] = dateTimeInput(values[field.key])
  }
  return values
}

export function keyLimitPayload(
  values: Record<string, unknown>,
  fields: Field[],
  unified: boolean,
) {
  const result: Record<string, unknown> = {}
  for (const field of fields) {
    const value = values[field.key]
    if (field.type === 'secret' && !value) continue
    if (field.key === 'expiresAt') {
      const date = value ? new Date(String(value)) : null
      if (date && Number.isNaN(date.getTime())) throw new Error('请填写有效的到期时间')
      result.expiresAt = date?.toISOString() ?? null
    } else if (field.type === 'list') result[field.key] = Array.isArray(value) ? value : []
    else if (field.type === 'number') {
      if (value === null || value === undefined || value === '') {
        result[field.key] = field.key === 'quota' ? 0 : null
      } else {
        const number = Number(value)
        if (
          !Number.isSafeInteger(number) ||
          (field.min !== undefined && number < field.min) ||
          (field.max !== undefined && number > field.max)
        ) {
          throw new Error(`${field.label}须为${field.min === 0 ? '非负' : '有效'}整数`)
        }
        result[field.key] = number
      }
    } else if (value !== undefined) result[field.key] = value
  }
  if (unified) {
    result.quota = Object.fromEntries(
      [
        ['requests', result.quotaRequests],
        ['tokens', result.quotaTokens],
      ].filter(([, value]) => value !== null && value !== undefined),
    )
    delete result.quotaRequests
    delete result.quotaTokens
  }
  return result
}

/** Never retain unknown response properties (especially plaintext secrets) in the list. */
export function keyListItem(item: KeyItem): KeyItem {
  return {
    id: item.id,
    revision: item.revision,
    via: item.via,
    system: item.system,
    channels: item.channels,
    name: item.name,
    masked: item.masked || '••••••••',
    enabled: item.enabled,
    builtin: item.builtin,
    createdAt: item.createdAt,
    lastUsedAt: item.lastUsedAt,
    usage: item.usage,
    limits: item.limits || {},
  }
}

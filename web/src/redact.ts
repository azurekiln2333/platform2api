/** Extra diagnostic payloads must never surface credential values. */
export function redact(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redact)
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        /(?:authorization|cookie|password|secret|refresh.?token|access.?token|api.?key|credential)/i.test(
          key,
        )
          ? '[已隐藏]'
          : redact(item),
      ]),
    )
  return value
}

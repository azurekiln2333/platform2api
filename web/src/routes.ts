export type PageId = 'overview' | 'accounts' | 'keys' | 'models' | 'logs' | 'settings'
/** Every label is exactly four characters so the sidebar never looks ragged. */
export const SHELL_NAV: readonly { id: PageId; label: string }[] = [
  { id: 'overview', label: '运行概览' },
  { id: 'accounts', label: '账号管理' },
  { id: 'keys', label: '密钥管理' },
  { id: 'models', label: '模型列表' },
  { id: 'logs', label: '请求日志' },
  { id: 'settings', label: '系统设置' },
]
const legacy: Record<string, PageId> = {
  overview: 'overview',
  accounts: 'accounts',
  enroll: 'accounts',
  enrollment: 'accounts',
  keys: 'keys',
  access: 'keys',
  models: 'models',
  logs: 'logs',
  usage: 'logs',
  ops: 'settings',
  settings: 'settings',
}
export function parseRoute(hash: string) {
  const [path, search = ''] = hash.replace(/^#\/?/, '').split('?')
  const params = new URLSearchParams(search)
  const parts = (path || 'overview').split('/')
  let page: PageId = 'overview'
  if (parts.length === 2 && /^[a-z][\w-]*$/i.test(parts[0]) && legacy[parts[1]]) {
    page = legacy[parts[1]]
    params.set('system', parts[0])
    if (parts[1] === 'usage') params.set('tab', 'usage')
    if (parts[1] === 'enroll' || parts[1] === 'enrollment') params.set('add', '1')
    if (parts[1] === 'access') params.set('access', '1')
  } else if (SHELL_NAV.some((item) => item.id === path)) page = path as PageId
  else return { page, query: {} as Record<string, string>, hash: '#overview' }
  const suffix = params.toString()
  return { page, query: Object.fromEntries(params), hash: `#${page}${suffix ? `?${suffix}` : ''}` }
}
export function routeHash(page: PageId, query: Record<string, string | undefined> = {}) {
  const params = new URLSearchParams()
  Object.entries(query).forEach(([key, value]) => {
    if (value && value !== 'all') params.set(key, value)
  })
  return `#${page}${params.size ? `?${params}` : ''}`
}

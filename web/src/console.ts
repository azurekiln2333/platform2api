import { computed, onBeforeUnmount, ref, unref, type Ref } from 'vue'
import { consoleApi } from './api.ts'
import type { Channel } from './console-types.ts'
import { parseRoute, routeHash, type PageId } from './routes.ts'
import { registerSystems } from './systems.ts'
export { formatNumber, quotaProgress, type QuotaProgress } from './systems.ts'
const initial = parseRoute(typeof location === 'undefined' ? '' : location.hash)
export const page = ref<PageId>(initial.page)
export const query = ref<Record<string, string>>(initial.query)
export const channels = ref<Channel[]>([])
export const unifiedUrl = ref('')
export const channelsLoading = ref(false)
export const channelsError = ref('')
export const version = ref('')
let channelRequest: Promise<void> | undefined
export function loadChannels() {
  if (channelRequest) return channelRequest
  channelsLoading.value = true
  channelRequest = consoleApi
    .channels()
    .then((payload) => {
      channels.value = payload.channels
      registerSystems(payload.channels)
      unifiedUrl.value = payload.unifiedUrl
      channelsError.value = ''
    })
    .catch((error: unknown) => {
      channelsError.value = errorText(error)
    })
    .finally(() => {
      channelsLoading.value = false
      channelRequest = undefined
    })
  return channelRequest
}
export const channelLabel = (system: string) =>
  channels.value.find((item) => item.system === system)?.label || system
export const channelOnline = (system: string) =>
  !['offline', 'down', 'error', 'unknown'].includes(
    channels.value.find((item) => item.system === system)?.health ?? 'unknown',
  )
export function errorText(error: unknown) {
  return error instanceof Error ? error.message : '操作失败，请重试'
}
const guards = new Set<() => boolean>()
export function useUnsavedChanges(dirty: Ref<boolean>) {
  const guard = () => unref(dirty)
  guards.add(guard)
  const unload = (event: BeforeUnloadEvent) => {
    if (guard()) {
      event.preventDefault()
      event.returnValue = ''
    }
  }
  window.addEventListener('beforeunload', unload)
  onBeforeUnmount(() => {
    guards.delete(guard)
    window.removeEventListener('beforeunload', unload)
  })
}
export const hasUnsavedChanges = () => [...guards].some((guard) => guard())
export function canLeave() {
  // Self-contained editors (including the login settings package) also register
  // beforeunload. Honor that standard guard during hash navigation as well.
  const event = new Event('beforeunload', { cancelable: true })
  const editorBlocked = !window.dispatchEvent(event)
  return (
    (!hasUnsavedChanges() && !editorBlocked) ||
    window.confirm('离开当前页面将丢失未保存的修改，仍要离开吗？')
  )
}
let acceptedHash = initial.hash
export function syncRoute() {
  const next = parseRoute(location.hash)
  if (next.page !== page.value && !canLeave()) {
    history.replaceState(null, '', acceptedHash)
    return
  }
  page.value = next.page
  query.value = next.query
  acceptedHash = next.hash
  if (location.hash !== next.hash) history.replaceState(null, '', next.hash)
}
export function navigate(target: string) {
  const next = parseRoute(target.startsWith('#') ? target : `#${target}`)
  if (next.page !== page.value && !canLeave()) return
  acceptedHash = next.hash
  page.value = next.page
  query.value = next.query
  location.hash = next.hash
}
export function setQuery(patch: Record<string, string | undefined>) {
  navigate(routeHash(page.value, { ...query.value, ...patch }))
}
export function queryValue(key: string, fallback = '') {
  return computed({
    get: () => query.value[key] ?? fallback,
    set: (value: string) => setQuery({ [key]: value }),
  })
}
export function absoluteTime(value: unknown) {
  if (value === null || value === undefined || value === '') return '—'
  const date = new Date(
    typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : String(value),
  )
  return Number.isNaN(date.getTime())
    ? String(value)
    : date.toLocaleString('zh-CN', { hour12: false })
}
export function relativeTime(value: unknown) {
  if (!value) return '—'
  const time =
    typeof value === 'number' ? (value < 1e12 ? value * 1000 : value) : Date.parse(String(value))
  if (!Number.isFinite(time)) return '—'
  const minutes = Math.round((Date.now() - time) / 60000)
  if (minutes < 0) return absoluteTime(value)
  if (minutes < 1) return '刚刚'
  if (minutes < 60) return `${minutes} 分钟前`
  if (minutes < 1440) return `${Math.floor(minutes / 60)} 小时前`
  return `${Math.floor(minutes / 1440)} 天前`
}

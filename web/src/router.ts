import { computed, defineComponent, h, ref, shallowRef, type Component } from 'vue'
import { SYSTEM_IDS, isSystemId, systemMeta } from './systems.ts'
import type { SystemId } from './types.ts'

export type ShellPageId = 'overview' | 'accounts' | 'settings'

export interface SystemPage {
  /** Hash route without the leading `#`, e.g. `cnb/logs`. */
  route: string
  system: SystemId
  slug: string
  label: string
  component: Component | null
}

export const SHELL_NAV: readonly { id: ShellPageId; label: string }[] = [
  { id: 'overview', label: '运行概览' },
  { id: 'accounts', label: '账号管理' },
  { id: 'settings', label: '面板设置' },
]

/**
 * Per-system pages live in `src/views/<system>/<Slug>View.vue` and are owned by
 * the system adapter teams: dropping a file in adds the sidebar entry and route.
 * The slug comes from the file name (`LogsView.vue` -> `logs`).
 */
const SYSTEM_PAGE_MODULES = import.meta.glob('./views/{cnb,codebuddy,zcode}/*View.vue') as Record<
  string,
  () => Promise<{ default: Component }>
>

/** Sidebar labels for the slugs named by the coverage matrix. Unknown slugs are prettified. */
export const SLUG_LABELS: Record<string, string> = {
  overview: '运行概览',
  accounts: '账号管理',
  models: '模型列表',
  keys: '密钥管理',
  settings: '服务设置',
  logs: '请求日志',
  usage: '用量统计',
  access: '接入配置',
  enroll: '账号授权',
  enrollment: '账号授权',
  ops: '运维工具',
  media: '媒体资源',
  storage: '存储与备份',
  updates: '版本更新',
  automation: '自动化',
  workers: '工作节点',
  backup: '备份',
  deploy: '部署',
}

export function slugLabel(slug: string) {
  if (SLUG_LABELS[slug]) return SLUG_LABELS[slug]
  return slug
    .split(/[-_]/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function slugFromPath(path: string) {
  const file = path.slice(path.lastIndexOf('/') + 1)
  const base = file.replace(/View\.vue$/, '')
  return base.replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase()
}

const discovered = (): SystemPage[] => {
  const pages: SystemPage[] = []
  for (const [path, loader] of Object.entries(SYSTEM_PAGE_MODULES)) {
    const system = path.split('/')[2]
    if (!isSystemId(system)) continue
    // `lazy` keeps the sidebar cheap while the page chunk loads on first visit.
    pages.push({
      route: `${system}/${slugFromPath(path)}`,
      system,
      slug: slugFromPath(path),
      label: slugLabel(slugFromPath(path)),
      component: lazy(loader),
    })
  }
  return pages.sort((a, b) => a.route.localeCompare(b.route))
}

function lazy(loader: () => Promise<{ default: Component }>): Component {
  return defineComponent({
    name: 'LazySystemPage',
    setup() {
      const resolved = shallowRef<Component | null>(null)
      loader()
        .then((module) => {
          resolved.value = module.default
        })
        .catch(() => {
          resolved.value = null
        })
      return () => (resolved.value ? h(resolved.value) : null)
    },
  })
}

export const systemPages = ref<SystemPage[]>(discovered())

export function pagesOf(system: SystemId) {
  return systemPages.value.filter((page) => page.system === system)
}

export const systemSections = computed(() =>
  SYSTEM_IDS.map((system) => ({
    system,
    label: systemMeta(system).label,
    pages: pagesOf(system),
  })),
)

/** Route exists but no component has been contributed yet. */
export interface PendingRoute {
  system: SystemId
  slug: string
  label: string
}

export type Resolved =
  | { kind: 'shell'; id: ShellPageId; label: string }
  | { kind: 'system'; page: SystemPage }
  | { kind: 'pending'; pending: PendingRoute }
  | { kind: 'missing' }

const SHELL_LABEL = new Map(SHELL_NAV.map((item) => [item.id, item.label]))

export function resolveRoute(hash: string): Resolved {
  const route = hash.replace(/^#\/?/, '')
  if (!route) return { kind: 'shell', id: 'overview', label: SHELL_LABEL.get('overview')! }
  const [head, ...rest] = route.split('/')
  if (isSystemId(head)) {
    const slug = rest.join('/') || 'overview'
    const page = systemPages.value.find((item) => item.route === `${head}/${slug}`)
    if (page?.component) return { kind: 'system', page }
    return { kind: 'pending', pending: { system: head, slug, label: slugLabel(slug) } }
  }
  if (head && SHELL_LABEL.has(head as ShellPageId)) {
    return { kind: 'shell', id: head as ShellPageId, label: SHELL_LABEL.get(head as ShellPageId)! }
  }
  return { kind: 'missing' }
}

export function routeTitle(resolved: Resolved) {
  switch (resolved.kind) {
    case 'shell':
      return resolved.label
    case 'system':
      return `${systemMeta(resolved.page.system).label} · ${resolved.page.label}`
    case 'pending':
      return `${systemMeta(resolved.pending.system).label} · ${resolved.pending.label}`
    default:
      return '未找到页面'
  }
}

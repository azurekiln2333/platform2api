<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import {
  Braces,
  Check,
  CircleAlert,
  ChevronDown,
  ChevronRight,
  LayoutDashboard,
  LoaderCircle,
  LogOut,
  Moon,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  Settings,
  Sun,
  UserRound,
  UsersRound,
  X,
} from '@lucide/vue'
import { formatApiDiagnostics, type ApiDiagnostics } from './api.ts'
import ModalShell from './components/ModalShell.vue'
import SystemBadge from './components/SystemBadge.vue'
import LoginView from './views/LoginView.vue'
import OverviewView from './views/OverviewView.vue'
import AccountsView from './views/AccountsView.vue'
import SettingsView from './views/SettingsView.vue'
import PendingView from './views/PendingView.vue'
import {
  OVERVIEW_POLL_MS,
  accounts,
  copy,
  dismissToast,
  lastUpdated,
  loadAuthConfig,
  loadSession,
  notify,
  overviewLoading,
  refreshAccounts,
  refreshOverview,
  refreshError,
  reset,
  session,
  signOut,
  toasts,
} from './panel.ts'
import { resolveRoute, routeTitle, SHELL_NAV, systemSections } from './router.ts'
import { systemMeta } from './systems.ts'

const version = __APP_VERSION__
const SHELL_ICONS = { overview: LayoutDashboard, accounts: UsersRound, settings: Settings } as const

const checkingSession = ref(true)
const authenticated = ref(false)
const hash = ref(location.hash || '#overview')
const collapsed = ref(localStorage.getItem('platform-sidebar') === 'collapsed')
const dark = ref(localStorage.getItem('platform-theme') === 'dark')
const mobileOpen = ref(false)
const userMenuOpen = ref(false)
const diagnostics = ref<ApiDiagnostics | null>(null)
const contentPane = ref<HTMLElement | null>(null)
let poll: number | undefined
let lastResume = -Infinity

const resolved = computed(() => resolveRoute(hash.value))
const title = computed(() => routeTitle(resolved.value))
const currentHash = computed(() => hash.value.replace(/^#\/?/, ''))
const accountCount = computed(() => accounts.value.length)
const userInitial = computed(() => {
  const name = session.value.user?.name.trim()
  return name ? Array.from(name)[0]!.toUpperCase() : ''
})
const identityName = computed(() => session.value.user?.name.trim() || '管理面板')
const identityDetail = computed(() => {
  const user = session.value.user
  if (!user) return '密钥登录'
  if (user.email) return user.email
  return user.provider === 'oidc' ? '单点登录' : '密钥登录'
})
const systemEntries = computed(() =>
  systemSections.value.map((section) => ({
    ...section,
    entries: section.pages.length
      ? section.pages.map((page) => ({
          route: page.route,
          label: page.label,
          slug: page.slug,
          system: page.system,
        }))
      : [
          {
            route: `${section.system}/overview`,
            label: '运行概览',
            slug: 'overview',
            system: section.system,
          },
        ],
  })),
)

function applyTheme() {
  document.documentElement.dataset.theme = dark.value ? 'dark' : 'light'
  localStorage.setItem('platform-theme', dark.value ? 'dark' : 'light')
}
function toggleTheme() {
  dark.value = !dark.value
  applyTheme()
}
function toggleSidebar() {
  collapsed.value = !collapsed.value
  localStorage.setItem('platform-sidebar', collapsed.value ? 'collapsed' : 'expanded')
}
function navigate(next: string) {
  const target = next.startsWith('#') ? next : `#${next}`
  if (hash.value === target) {
    void refreshOverview()
    void refreshAccounts()
    return
  }
  hash.value = target
  location.hash = target.slice(1)
  mobileOpen.value = false
}
function navigateShell(id: string) {
  navigate(`#${id}`)
}
function hashChanged() {
  hash.value = location.hash || '#overview'
  mobileOpen.value = false
  userMenuOpen.value = false
}
function refreshAll() {
  if (!authenticated.value || document.hidden) return
  void refreshOverview()
  void refreshAccounts()
}
function resume() {
  const now = Date.now()
  if (now - lastResume < 250) return
  lastResume = now
  refreshAll()
}
function expired() {
  authenticated.value = false
  userMenuOpen.value = false
  diagnostics.value = null
  reset()
  void loadAuthConfig()
}
async function signInSucceeded() {
  authenticated.value = true
  await loadSession()
  refreshAll()
}
async function logout() {
  userMenuOpen.value = false
  try {
    await signOut()
    authenticated.value = false
  } catch (error) {
    notify(error instanceof Error ? error.message : '退出失败', true)
  }
}
function shortcuts(event: KeyboardEvent) {
  if (event.key !== 'Escape') return
  mobileOpen.value = false
  userMenuOpen.value = false
}
function closeUserMenu() {
  userMenuOpen.value = false
}

watch(hash, () => {
  contentPane.value?.scrollTo({ top: 0, left: 0 })
  refreshAll()
})

onMounted(async () => {
  applyTheme()
  window.addEventListener('hashchange', hashChanged)
  window.addEventListener('session-expired', expired)
  window.addEventListener('keydown', shortcuts)
  window.addEventListener('click', closeUserMenu)
  document.addEventListener('visibilitychange', resume)
  window.addEventListener('focus', resume)
  window.addEventListener('online', resume)
  poll = window.setInterval(refreshAll, OVERVIEW_POLL_MS)
  void loadAuthConfig()
  try {
    const current = await loadSession()
    if (current.authenticated) await signInSucceeded()
  } catch {
    authenticated.value = false
  } finally {
    checkingSession.value = false
  }
})
onBeforeUnmount(() => {
  clearInterval(poll)
  window.removeEventListener('hashchange', hashChanged)
  window.removeEventListener('session-expired', expired)
  window.removeEventListener('keydown', shortcuts)
  window.removeEventListener('click', closeUserMenu)
  document.removeEventListener('visibilitychange', resume)
  window.removeEventListener('focus', resume)
  window.removeEventListener('online', resume)
})
</script>

<template>
  <div v-if="checkingSession" class="boot-screen">
    <span class="brand-icon"><Braces :size="22" /></span
    ><LoaderCircle :size="20" class="spin" /><span>正在连接控制台</span>
  </div>
  <LoginView
    v-else-if="!authenticated"
    :dark="dark"
    @toggle-theme="toggleTheme"
    @signed-in="signInSucceeded"
  />
  <div v-else class="app-shell" :class="{ 'sidebar-collapsed': collapsed }">
    <header class="topbar">
      <div class="topbar-leading">
        <button
          class="icon-button collapse-button"
          :aria-label="collapsed ? '展开侧栏' : '收起侧栏'"
          :aria-expanded="!collapsed"
          @click="toggleSidebar"
        >
          <PanelLeftOpen v-if="collapsed" :size="19" /><PanelLeftClose v-else :size="19" />
        </button>
        <button
          class="icon-button mobile-toggle"
          aria-label="展开导航"
          :aria-expanded="mobileOpen"
          @click="mobileOpen = !mobileOpen"
        >
          <PanelLeftOpen :size="19" />
        </button>
        <a href="#overview" class="brand topbar-brand" @click="navigate('#overview')">
          <span class="brand-icon"><Braces :size="20" /></span>
          <span>platform<span class="brand-two">2</span>api</span>
        </a>
        <div class="breadcrumbs">
          <span>控制台</span><ChevronRight :size="13" /><strong>{{ title }}</strong>
        </div>
      </div>
      <div class="topbar-actions">
        <button
          class="icon-button"
          :aria-label="dark ? '切换浅色主题' : '切换深色主题'"
          @click="toggleTheme"
        >
          <Sun v-if="dark" :size="18" /><Moon v-else :size="18" /></button
        ><span class="topbar-separator" />
        <div class="user-menu" @click.stop>
          <button
            class="user-trigger"
            aria-label="用户菜单"
            :aria-expanded="userMenuOpen"
            aria-haspopup="menu"
            @click="userMenuOpen = !userMenuOpen"
          >
            <span class="user-avatar"
              ><img
                v-if="session.user?.picture"
                :src="session.user.picture"
                @error="session.user && (session.user.picture = '')"
                alt=""
                referrerpolicy="no-referrer" /><template v-else-if="userInitial">{{
                userInitial
              }}</template
              ><UserRound v-else :size="15" /></span
            ><ChevronDown :size="14" />
          </button>
          <div v-if="userMenuOpen" class="user-panel" role="menu">
            <div class="user-identity">
              <span class="user-avatar large"
                ><img
                  v-if="session.user?.picture"
                  :src="session.user.picture"
                  @error="session.user && (session.user.picture = '')"
                  alt=""
                  referrerpolicy="no-referrer" /><template v-else-if="userInitial">{{
                  userInitial
                }}</template
                ><UserRound v-else :size="17"
              /></span>
              <span class="user-identity-text"
                ><strong>{{ identityName }}</strong
                ><small>{{ identityDetail }}</small></span
              >
            </div>
            <div class="user-menu-sep" />
            <button class="user-logout" role="menuitem" @click="logout">
              <LogOut :size="15" /><span>退出登录</span>
            </button>
          </div>
        </div>
      </div>
    </header>
    <button
      v-if="mobileOpen"
      class="mobile-backdrop"
      aria-label="关闭导航"
      @click="mobileOpen = false"
    />
    <aside class="sidebar" :class="{ 'mobile-open': mobileOpen }">
      <div class="nav-caption">控制台<span>CONSOLE</span></div>
      <nav class="main-nav" aria-label="主导航">
        <a
          v-for="item in SHELL_NAV"
          :key="item.id"
          :href="`#${item.id}`"
          :class="{ active: currentHash === item.id }"
          :aria-current="currentHash === item.id ? 'page' : undefined"
          :title="item.label"
          :data-testid="`nav-${item.id}`"
          @click="navigateShell(item.id)"
          ><component :is="SHELL_ICONS[item.id]" :size="17" /><span>{{ item.label }}</span
          ><small v-if="item.id === 'accounts'">{{ accountCount }}</small></a
        >
      </nav>
      <template v-for="section in systemEntries" :key="section.system">
        <div class="nav-caption system-caption">
          <SystemBadge :system="section.system" compact /><span>{{ section.label }}</span>
        </div>
        <nav class="main-nav" :aria-label="`${section.label} 导航`">
          <a
            v-for="entry in section.entries"
            :key="entry.route"
            :href="`#${entry.route}`"
            :class="{ active: currentHash === entry.route }"
            :aria-current="currentHash === entry.route ? 'page' : undefined"
            :title="`${systemMeta(entry.system).label} · ${entry.label}`"
            :data-route="entry.route"
            @click="navigate(`#${entry.route}`)"
            ><span>{{ entry.label }}</span></a
          >
        </nav>
      </template>
      <div class="sidebar-bottom">
        <a
          href="https://github.com/azurekiln2333/cnb2api-panel"
          target="_blank"
          rel="noopener noreferrer"
          class="sidebar-help"
          ><Braces :size="16" /><span>样式来自 cnb2api</span></a
        >
      </div>
    </aside>
    <div ref="contentPane" class="main-shell">
      <main class="main-content" id="main-content">
        <div v-if="refreshError" class="error-banner" role="alert">
          <CircleAlert :size="16" /><span>{{ refreshError }}</span>
          <button @click="refreshAll">重试</button>
        </div>
        <OverviewView
          v-if="resolved.kind === 'shell' && resolved.id === 'overview'"
          @navigate="navigate"
        />
        <AccountsView
          v-else-if="resolved.kind === 'shell' && resolved.id === 'accounts'"
          @navigate="navigate"
        />
        <SettingsView
          v-else-if="resolved.kind === 'shell' && resolved.id === 'settings'"
          :dark="dark"
          @toggle-theme="toggleTheme"
        />
        <component
          :is="resolved.page.component"
          v-else-if="resolved.kind === 'system'"
          :key="resolved.page.route"
        />
        <PendingView
          v-else-if="resolved.kind === 'pending'"
          :system="resolved.pending.system"
          :slug="resolved.pending.slug"
          :label="resolved.pending.label"
          @navigate="navigate"
        />
        <div v-else class="page-loading">未找到页面，请从左侧导航重新选择。</div>
      </main>
      <footer class="page-footer">
        <span
          ><i class="blue-dot" /><span class="footer-gateway">PLATFORM CONSOLE</span
          ><span class="footer-dot">·</span
          ><span class="footer-product"
            >platform2api <small>v{{ version }}</small></span
          ><span class="footer-dot">·</span>CNB / CodeBuddy / ZCode</span
        ><button @click="refreshAll">
          <RefreshCw :size="12" :class="{ spin: overviewLoading }" /><span>{{
            lastUpdated
              ? `每15秒刷新 · ${lastUpdated.toLocaleTimeString('zh-CN', { hour12: false })}`
              : '等待同步'
          }}</span>
        </button>
      </footer>
    </div>
  </div>
  <ModalShell
    v-if="diagnostics"
    title="接口诊断详情"
    subtitle="包含错误说明、请求路径和响应信息，可复制给服务器维护者排查。"
    @close="diagnostics = null"
  >
    <div class="modal-body">
      <pre class="api-diagnostics" data-testid="api-diagnostics">{{
        formatApiDiagnostics(diagnostics)
      }}</pre>
    </div>
    <footer class="modal-footer">
      <span />
      <div class="button-group">
        <button class="button" @click="diagnostics = null">关闭</button
        ><button class="button primary" @click="copy(formatApiDiagnostics(diagnostics))">
          复制诊断
        </button>
      </div>
    </footer>
  </ModalShell>
  <div class="toast-stack" aria-live="polite">
    <div v-for="toast in toasts" :key="toast.id" class="toast" :class="{ error: toast.error }">
      <CircleAlert v-if="toast.error" :size="17" /><Check v-else :size="17" /><span>{{
        toast.text
      }}</span
      ><button
        v-if="toast.diagnostics"
        class="text-link toast-diagnostics"
        @click="diagnostics = toast.diagnostics ?? null"
      >
        诊断详情</button
      ><button class="icon-button" aria-label="关闭通知" @click="dismissToast(toast.id)">
        <X :size="14" />
      </button>
    </div>
  </div>
</template>

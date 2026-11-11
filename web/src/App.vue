<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue'
import {
  Braces,
  LayoutDashboard,
  Users,
  KeyRound,
  Boxes,
  ScrollText,
  Settings,
  Sun,
  Moon,
  LogOut,
  Menu,
  X,
} from '@lucide/vue'
import LoginView from './views/LoginView.vue'
import OverviewView from './views/OverviewView.vue'
import AccountsView from './views/AccountsView.vue'
import KeysView from './views/KeysView.vue'
import ModelsView from './views/ModelsView.vue'
import LogsView from './views/LogsView.vue'
import SettingsView from './views/SettingsView.vue'
import {
  loadSession,
  loadAuthConfig,
  signOut,
  session,
  reset,
  toasts,
  dismissToast,
  reportError,
} from './panel.ts'
import {
  page,
  channels,
  channelsError,
  loadChannels,
  syncRoute,
  navigate,
  version,
  canLeave,
} from './console.ts'
import { SHELL_NAV } from './routes.ts'
const checking = ref(true),
  mobileOpen = ref(false)
const dark = ref(localStorage.getItem('platform-theme') === 'dark')
const icons = {
  overview: LayoutDashboard,
  accounts: Users,
  keys: KeyRound,
  models: Boxes,
  logs: ScrollText,
  settings: Settings,
}
const views = {
  overview: OverviewView,
  accounts: AccountsView,
  keys: KeysView,
  models: ModelsView,
  logs: LogsView,
  settings: SettingsView,
}
const title = computed(() => SHELL_NAV.find((item) => item.id === page.value)?.label || '')
function theme() {
  document.documentElement.dataset.theme = dark.value ? 'dark' : 'light'
  localStorage.setItem('platform-theme', dark.value ? 'dark' : 'light')
}
function toggleTheme() {
  dark.value = !dark.value
  theme()
}
function routeChanged() {
  syncRoute()
  mobileOpen.value = false
}
function go(target: string) {
  navigate(target)
  mobileOpen.value = false
}
async function signedIn() {
  await loadSession()
  if (session.value.authenticated) await loadChannels()
}
async function logout() {
  if (!canLeave()) return
  try {
    await signOut()
    channels.value = []
  } catch (e) {
    reportError(e, '退出失败')
  }
}
function expired() {
  reset()
  channels.value = []
  void loadAuthConfig(true)
}
function escape(event: KeyboardEvent) {
  if (event.key === 'Escape') mobileOpen.value = false
}
onMounted(async () => {
  theme()
  syncRoute()
  window.addEventListener('hashchange', routeChanged)
  window.addEventListener('session-expired', expired)
  window.addEventListener('keydown', escape)
  await loadAuthConfig()
  await signedIn()
  checking.value = false
})
onBeforeUnmount(() => {
  window.removeEventListener('hashchange', routeChanged)
  window.removeEventListener('session-expired', expired)
  window.removeEventListener('keydown', escape)
})
</script>
<template>
  <div v-if="checking" class="boot-screen">正在连接控制台…</div>
  <LoginView
    v-else-if="!session.authenticated"
    :dark="dark"
    @toggle-theme="toggleTheme"
    @signed-in="signedIn"
  />
  <div v-else class="app-shell unified-shell">
    <header class="topbar">
      <div class="topbar-leading">
        <button
          class="icon-button console-mobile-toggle"
          aria-label="展开导航"
          :aria-expanded="mobileOpen"
          @click="mobileOpen = !mobileOpen"
        >
          <Menu :size="20" /></button
        ><a href="#overview" class="brand" @click.prevent="go('#overview')"
          ><span class="brand-icon"><Braces :size="20" /></span><span>platform2api</span></a
        ><span class="breadcrumbs">控制台 / {{ title }}</span>
      </div>
    </header>
    <button
      v-if="mobileOpen"
      class="mobile-backdrop"
      aria-label="关闭导航"
      @click="mobileOpen = false"
    />
    <aside class="sidebar" :class="{ 'mobile-open': mobileOpen }">
      <nav class="main-nav" aria-label="主导航">
        <a
          v-for="item in SHELL_NAV"
          :key="item.id"
          :href="`#${item.id}`"
          :title="item.label"
          :aria-label="item.label"
          :class="{ active: page === item.id }"
          :aria-current="page === item.id ? 'page' : undefined"
          :data-testid="`nav-${item.id}`"
          @click.prevent="go(`#${item.id}`)"
          ><component :is="icons[item.id]" :size="18" /><span>{{ item.label }}</span></a
        >
      </nav>
      <div class="sidebar-bottom console-user">
        <span class="console-user-name" :title="session.user?.email || ''">{{
          session.user?.name || '管理员'
        }}</span
        ><button
          class="icon-button"
          :aria-label="dark ? '切换浅色主题' : '切换深色主题'"
          @click="toggleTheme"
        >
          <Sun v-if="dark" :size="18" /><Moon v-else :size="18" /></button
        ><button class="icon-button" aria-label="退出登录" @click="logout">
          <LogOut :size="18" />
        </button>
      </div>
    </aside>
    <div class="main-shell">
      <main class="main-content" id="main-content">
        <div v-if="channelsError" class="error-banner" role="alert">
          <span>渠道信息加载失败：{{ channelsError }}</span
          ><button @click="loadChannels">重试</button>
        </div>
        <component :is="views[page]" :key="page" />
      </main>
      <footer class="page-footer">
        platform2api<span v-if="version"> v{{ version }}</span>
      </footer>
    </div>
  </div>
  <div class="toast-stack" aria-live="polite">
    <div v-for="toast in toasts" :key="toast.id" class="toast" :class="{ error: toast.error }">
      <span>{{ toast.text }}</span
      ><button class="icon-button" aria-label="关闭通知" @click="dismissToast(toast.id)">
        <X :size="15" />
      </button>
    </div>
  </div>
</template>

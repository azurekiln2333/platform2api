<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  ArrowRight,
  ArrowUpRight,
  Braces,
  Cloud,
  LoaderCircle,
  Moon,
  ShieldCheck,
  Sun,
} from '@lucide/vue'
import { authConfig, loadAuthConfig, loadSession, signIn } from '../panel.ts'

defineProps<{ dark: boolean }>()
const emit = defineEmits<{ 'toggle-theme': []; 'signed-in': [] }>()

const AUTH_ERROR_MESSAGES: Record<string, string> = {
  access_denied: '登录被取消，请重新登录。',
  invalid_request: '登录请求无效，请重新登录。',
  invalid_state: '登录会话已失效，请重新登录。',
  state_mismatch: '登录状态校验失败，请重新登录。',
  nonce_mismatch: '登录校验失败，请重新登录。',
  missing_code: '单点登录未返回授权码，请重新登录。',
  token_exchange_failed: '无法完成单点登录，请稍后重试。',
  discovery_failed: '无法连接单点登录服务，请稍后重试或联系管理员。',
  provider_error: '单点登录服务返回错误，请稍后重试。',
  provider_unavailable: '单点登录服务暂时不可用，请稍后重试。',
  sso_disabled: '单点登录已关闭，请使用管理密钥登录。',
  transaction_expired: '登录会话已过期，请重新登录。',
  not_allowed: '当前账号不在管理员允许列表内。',
  email_not_allowed: '当前邮箱不在管理员允许列表内。',
  configuration_error: '单点登录尚未配置完整，请联系管理员。',
}

const loginKey = ref('')
const loginError = ref('')
const authNotice = ref('')
const signingIn = ref(false)
const ssoLabel = computed(() => authConfig.value.sso.providerName.trim() || '单点登录')
const loginHint = computed(() => {
  if (!authConfig.value.keyLoginEnabled) return '使用组织单点登录进入统一面板。'
  if (authConfig.value.sso.enabled) return '使用主机上配置的管理密钥登录，或使用单点登录。'
  return '使用主机上配置的 PANEL_ADMIN_KEY 登录。'
})

function readAuthNotice() {
  const url = new URL(location.href)
  if (!url.searchParams.has('auth_error')) return
  const raw = url.searchParams.get('auth_error')?.trim().toLowerCase() ?? ''
  url.searchParams.delete('auth_error')
  history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`)
  authNotice.value = AUTH_ERROR_MESSAGES[raw] || '单点登录失败，请重新登录或联系管理员。'
}

async function submit() {
  signingIn.value = true
  loginError.value = ''
  try {
    await signIn(loginKey.value)
    loginKey.value = ''
    await loadSession()
    emit('signed-in')
  } catch (error) {
    loginError.value = error instanceof Error ? error.message : '登录失败'
  } finally {
    signingIn.value = false
  }
}

function ssoSignIn() {
  loginError.value = ''
  const url = authConfig.value.sso.loginUrl
  if (!url) {
    loginError.value = '单点登录尚未配置登录地址，请联系管理员。'
    return
  }
  window.location.assign(url)
}

onMounted(() => {
  readAuthNotice()
  void loadAuthConfig()
})
</script>

<template>
  <div class="login-shell">
    <section class="login-story">
      <a class="brand" href="#overview"
        ><span class="brand-icon"><Braces :size="23" /></span
        ><span>platform<span class="brand-two">2</span>api</span
        ><span class="brand-tag">CONSOLE</span></a
      >
      <div class="login-story-content">
        <span class="eyebrow"><i class="blue-dot" /> THREE SYSTEMS. ONE CONTROL ROOM.</span>
        <h1>一个面板，<br />照看三家平台。</h1>
        <div class="network-art" aria-hidden="true">
          <div class="network-center"><Braces :size="26" /><span>统一面板</span></div>
          <svg viewBox="0 0 440 200">
            <path
              d="M110 100H210Q240 100 240 50T280 25H335M210 100H335M210 100Q240 100 240 150T280 175H335"
            />
          </svg>
          <div class="network-node node-1"><Cloud :size="19" />CNB<i /></div>
          <div class="network-node node-2"><Cloud :size="19" />CodeBuddy<i /></div>
          <div class="network-node node-3"><Cloud :size="19" />ZCode<i /></div>
        </div>
      </div>
      <div class="login-story-footer">
        <span>各自的端口、各自的额度，统一的入口。↗</span>
      </div>
    </section>
    <main class="login-main">
      <button
        class="icon-button login-theme"
        aria-label="切换明暗主题"
        @click="emit('toggle-theme')"
      >
        <Sun v-if="dark" :size="20" /><Moon v-else :size="20" />
      </button>
      <form class="login-form" @submit.prevent="submit">
        <span class="login-lock"><ShieldCheck :size="25" /></span
        ><span class="eyebrow">PLATFORM CONSOLE</span>
        <h2>欢迎回到控制台</h2>
        <p>{{ loginHint }}</p>
        <p v-if="authNotice" class="form-error" role="alert">{{ authNotice }}</p>
        <template v-if="authConfig.keyLoginEnabled">
          <label for="admin-key"
            >管理密钥<input
              id="admin-key"
              v-model="loginKey"
              type="password"
              required
              autofocus
              autocomplete="current-password"
              placeholder="输入 PANEL_ADMIN_KEY"
          /></label>
          <p v-if="loginError" class="form-error" role="alert">{{ loginError }}</p>
          <button class="button primary login-submit" :disabled="signingIn">
            <LoaderCircle v-if="signingIn" :size="17" class="spin" /><span>{{
              signingIn ? '正在验证' : '进入控制台'
            }}</span
            ><ArrowRight :size="17" />
          </button>
        </template>
        <p v-else-if="loginError" class="form-error" role="alert">{{ loginError }}</p>
        <template v-if="authConfig.sso.enabled">
          <div v-if="authConfig.keyLoginEnabled" class="login-divider"><span>或</span></div>
          <button type="button" class="button login-sso" @click="ssoSignIn">
            <ShieldCheck :size="16" /><span>使用 {{ ssoLabel }} 登录</span
            ><ArrowUpRight :size="15" />
          </button>
        </template>
        <p
          v-if="!authConfig.keyLoginEnabled && !authConfig.sso.enabled"
          class="form-error"
          role="alert"
        >
          登录方式未配置，请联系管理员开启密钥登录或单点登录。
        </p>
      </form>
    </main>
  </div>
</template>

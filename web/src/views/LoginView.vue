<script setup lang="ts">
/**
 * 登录页（design 4.7）。登录入口完全由 `GET /api/auth/config` 决定：
 * 密钥登录启用就显示密钥输入，SSO 启用就显示「使用 <提供方名称> 登录」，
 * 两者都启用时 SSO 按钮在上。`?auth_error=<reason>` 翻译成中文可读错误。
 */
import { computed, nextTick, onMounted, ref } from 'vue'
import {
  ArrowRight,
  ArrowUpRight,
  Braces,
  CircleAlert,
  Cloud,
  Eye,
  EyeOff,
  LoaderCircle,
  Moon,
  RefreshCw,
  ShieldCheck,
  Sun,
} from '@lucide/vue'

defineProps<{ dark: boolean }>()
const emit = defineEmits<{ 'toggle-theme': []; 'signed-in': [] }>()

interface LoginConfig {
  keyLoginEnabled: boolean
  sso: { enabled: boolean; providerName: string; loginUrl: string }
}

const SSO_LOGIN_PATH = '/api/auth/oidc/login'

/** 与后端 `?auth_error=` 使用的 reason 对齐（含 `http_<status>` 系列）。 */
const AUTH_ERRORS: Record<string, string> = {
  sso_disabled: '单点登录已关闭，请改用面板密钥登录。',
  discovery_failed: '无法连接单点登录服务，请稍后重试或联系管理员。',
  provider_error: '单点登录服务返回错误，请稍后重试。',
  transaction_expired: '登录会话已过期，请重新登录。',
  state_mismatch: '登录状态校验失败，请重新登录。',
  invalid_state: '登录状态校验失败，请重新登录。',
  missing_code: '单点登录没有返回授权码，请重新登录。',
  userinfo_mismatch: '单点登录返回的账号信息不一致，请联系管理员。',
  not_allowed: '当前账号不在管理员允许名单内。',
  nonce_mismatch: '登录校验失败，请重新登录。',
  expired: '登录凭据已过期，请重新登录。',
  not_yet_valid: '登录凭据尚未生效，请检查提供方的时间。',
  issued_in_future: '登录凭据时间异常，请检查提供方的时间。',
  invalid_iat: '登录凭据时间异常，请检查提供方的时间。',
  invalid_expiry: '登录凭据时间异常，请检查提供方的时间。',
  signature_invalid: '登录凭据的签名无法校验，请联系管理员检查提供方密钥。',
  unknown_key: '登录凭据的签名密钥未知，请联系管理员同步提供方密钥。',
  unsupported_alg: '登录凭据使用了不受支持的签名算法，请联系管理员。',
  audience_mismatch: '登录凭据与面板登记的客户端不匹配，请联系管理员。',
  issuer_mismatch: '登录凭据的颁发者与面板配置不一致，请联系管理员。',
  invalid_issuer: '登录凭据的颁发者无效，请联系管理员检查配置。',
  network_error: '无法连接单点登录服务，请检查网络后重试。',
  response_too_large: '单点登录返回的数据超出限制，请联系管理员。',
  internal_error: '面板处理登录时出错，请稍后重试。',
}

function authErrorMessage(reason: string) {
  const key = reason.trim().toLowerCase()
  if (!key) return '单点登录失败，请重新登录或联系管理员。'
  const known = AUTH_ERRORS[key]
  if (known) return known
  const status = /^http_(\d{3})$/.exec(key)
  if (status) return `单点登录服务返回异常响应（HTTP ${status[1]}），请稍后重试或联系管理员。`
  if (key.startsWith('invalid_') || key === 'missing_access_token' || key === 'missing_subject')
    return '单点登录返回的数据无法识别，请联系管理员检查配置。'
  return '单点登录失败，请重新登录或联系管理员。'
}

const config = ref<LoginConfig | null>(null)
const configLoading = ref(true)
const configError = ref('')
const loginKey = ref('')
const showKey = ref(false)
const loginError = ref('')
const notice = ref('')
const submitting = ref(false)

const keyInput = ref<HTMLInputElement | null>(null)
const keyLoginEnabled = computed(() => config.value?.keyLoginEnabled === true)
const ssoEnabled = computed(() => config.value?.sso.enabled === true)
const ssoLabel = computed(() => config.value?.sso.providerName.trim() || '单点登录')
const loginHint = computed(() => {
  if (keyLoginEnabled.value && ssoEnabled.value) return '用管理密钥登录，或使用单点登录。'
  if (ssoEnabled.value) return '使用组织单点登录进入控制台。'
  if (keyLoginEnabled.value) return '使用部署时设置的面板密钥登录。'
  return '当前没有可用的登录方式，请联系管理员。'
})

function readAuthNotice() {
  const url = new URL(location.href)
  if (!url.searchParams.has('auth_error')) return
  const reason = url.searchParams.get('auth_error') ?? ''
  url.searchParams.delete('auth_error')
  history.replaceState(history.state, '', `${url.pathname}${url.search}${url.hash}`)
  notice.value = authErrorMessage(reason)
}

async function loadConfig() {
  configLoading.value = true
  configError.value = ''
  try {
    const response = await fetch('/api/auth/config', {
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    const body = await response.json()
    config.value = {
      keyLoginEnabled: body?.keyLoginEnabled === true,
      sso: {
        enabled: body?.sso?.enabled === true,
        providerName: typeof body?.sso?.providerName === 'string' ? body.sso.providerName : '',
        loginUrl: typeof body?.sso?.loginUrl === 'string' ? body.sso.loginUrl : '',
      },
    }
    if (keyLoginEnabled.value) {
      await nextTick()
      keyInput.value?.focus()
    }
  } catch {
    config.value = null
    configError.value = '无法读取登录方式，请检查网络后重试。'
  } finally {
    configLoading.value = false
  }
}

async function submit() {
  if (submitting.value || !loginKey.value.trim()) return
  submitting.value = true
  loginError.value = ''
  const key = loginKey.value
  try {
    const response = await fetch('/api/session', {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { Accept: 'application/json', 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
    })
    if (!response.ok) {
      const body = await response.json().catch(() => undefined)
      const message = body?.error?.message
      throw new Error(
        typeof message === 'string' && message.trim()
          ? message.trim()
          : response.status === 401
            ? '管理密钥不正确'
            : response.status === 429
              ? '登录尝试过多，请稍后再试'
              : '登录失败，请稍后重试',
      )
    }
    loginKey.value = ''
    emit('signed-in')
  } catch (error) {
    const message = error instanceof Error ? error.message : ''
    loginError.value = message || '无法连接控制台，请检查网络后重试。'
    await nextTick()
    keyInput.value?.focus()
  } finally {
    submitting.value = false
  }
}

function ssoSignIn() {
  const url = config.value?.sso.loginUrl || SSO_LOGIN_PATH
  loginError.value = ''
  window.location.assign(url)
}

onMounted(() => {
  readAuthNotice()
  void loadConfig()
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
        <p>{{ configLoading ? '正在读取登录方式…' : loginHint }}</p>

        <div v-if="configLoading" class="login-state">
          <LoaderCircle :size="16" class="spin" /><span>请稍候</span>
        </div>

        <div v-else-if="configError" class="login-state login-state-error" role="alert">
          <CircleAlert :size="16" /><span>{{ configError }}</span>
          <button type="button" class="button" @click="loadConfig">
            <RefreshCw :size="14" /><span>重试</span>
          </button>
        </div>

        <template v-else>
          <p v-if="notice" class="form-error" role="alert">{{ notice }}</p>

          <button
            v-if="ssoEnabled"
            type="button"
            class="button login-sso"
            :class="{ 'login-sso-first': keyLoginEnabled }"
            @click="ssoSignIn"
          >
            <ShieldCheck :size="16" /><span>使用 {{ ssoLabel }} 登录</span
            ><ArrowUpRight :size="15" />
          </button>

          <div v-if="ssoEnabled && keyLoginEnabled" class="login-divider"><span>或</span></div>

          <template v-if="keyLoginEnabled">
            <label for="admin-key"
              >管理密钥
              <span class="login-secret">
                <input
                  id="admin-key"
                  ref="keyInput"
                  v-model="loginKey"
                  :type="showKey ? 'text' : 'password'"
                  autocomplete="current-password"
                  spellcheck="false"
                  placeholder="输入面板密钥"
                  :disabled="submitting"
                  :aria-invalid="Boolean(loginError)"
                />
                <button
                  type="button"
                  class="icon-button"
                  :aria-label="showKey ? '隐藏管理密钥' : '显示管理密钥'"
                  @click="showKey = !showKey"
                >
                  <EyeOff v-if="showKey" :size="15" /><Eye v-else :size="15" />
                </button>
              </span>
            </label>
            <p v-if="loginError" class="form-error" role="alert">{{ loginError }}</p>
            <button class="button primary login-submit" :disabled="submitting || !loginKey.trim()">
              <LoaderCircle v-if="submitting" :size="17" class="spin" /><span>{{
                submitting ? '正在验证' : '进入控制台'
              }}</span
              ><ArrowRight :size="17" />
            </button>
          </template>

          <p v-else-if="loginError" class="form-error" role="alert">{{ loginError }}</p>

          <p v-if="!keyLoginEnabled && !ssoEnabled" class="form-error" role="alert">
            登录方式未配置，请联系管理员开启密钥登录或单点登录。
          </p>
        </template>
      </form>
    </main>
  </div>
</template>

<style scoped>
.login-state {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: var(--muted);
}
.login-state-error {
  flex-direction: column;
  align-items: flex-start;
  color: var(--red);
  line-height: 1.8;
}
.login-state-error .button {
  margin-top: 6px;
}
.login-secret {
  display: flex;
  align-items: center;
  margin-top: 9px;
  padding-right: 4px;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-xs);
  background: var(--surface);
}
.login-secret:focus-within {
  border-color: var(--primary);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--primary) 9%, transparent);
}
.login-secret input {
  flex: 1;
  min-width: 0;
  margin: 0 !important;
  padding: 12px;
  font-size: 14px;
  min-height: 42px;
  border: 0;
  background: transparent;
  box-shadow: none;
}
.login-secret input:focus {
  box-shadow: none;
}
.login-sso-first {
  margin-top: 0;
}
</style>

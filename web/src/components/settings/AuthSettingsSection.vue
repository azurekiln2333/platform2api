<script setup lang="ts">
/**
 * 设置 › 通用 › 登录方式（design 4.6 / R7）。
 *
 * 自包含：自己读取、校验、保存 `GET|PATCH /api/auth/settings`，不接收 props，
 * 也不依赖页面级状态，可被设置页直接引入。密钥登录与单点登录至少保留一种；
 * 关闭任一登录方式属于破坏性操作，需二次确认（C5）。
 */
import { computed, nextTick, onBeforeUnmount, onMounted, reactive, ref, watch } from 'vue'
import {
  CircleAlert,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  LoaderCircle,
  RefreshCw,
  Save,
  ShieldCheck,
} from '@lucide/vue'

/** `GET /api/auth/settings` 的返回结构；客户端密钥永不回传。 */
interface AuthSettings {
  ssoEnabled: boolean
  keyLoginEnabled: boolean
  issuer: string
  clientId: string
  hasClientSecret: boolean
  scope: string
  providerName: string
  allowedSubjects: string[]
  allowedEmails: string[]
  callbackUrl: string
}

const SETTINGS_PATH = '/api/auth/settings'
const DEFAULT_SCOPE = 'openid profile email'
const FIELD_KEYS = [
  'keyLoginEnabled',
  'ssoEnabled',
  'providerName',
  'issuer',
  'clientId',
  'clientSecret',
  'scope',
  'allowedSubjects',
  'allowedEmails',
  'callbackUrl',
] as const
type FieldKey = (typeof FIELD_KEYS)[number]

const emptyErrors = (): Record<FieldKey, string> =>
  Object.fromEntries(FIELD_KEYS.map((key) => [key, ''])) as Record<FieldKey, string>

const root = ref<HTMLElement | null>(null)
const confirmDialog = ref<HTMLDialogElement | null>(null)
const confirmButton = ref<HTMLButtonElement | null>(null)

const form = reactive({
  keyLoginEnabled: true,
  ssoEnabled: false,
  providerName: '',
  issuer: '',
  clientId: '',
  clientSecret: '',
  scope: DEFAULT_SCOPE,
  allowedSubjects: '',
  allowedEmails: '',
})

const loading = ref(true)
const loadError = ref('')
const saving = ref(false)
const saveError = ref('')
const fieldErrors = reactive(emptyErrors())
const stored = reactive({ ssoEnabled: false, keyLoginEnabled: true, callbackUrl: '' })
const hasStoredSecret = ref(false)
const showSecret = ref(false)
const dirty = ref(false)
const toast = ref('')
const copiedKey = ref('')
const confirming = ref(false)
const confirmBusy = ref(false)
const confirmError = ref('')
const pendingDisable = ref<string[]>([])
let snapshot = ''
let toastTimer: number | undefined
let copyTimer: number | undefined

const listOf = (text: string) =>
  text
    .split(/[\n,]+/)
    .map((value) => value.trim())
    .filter(Boolean)

const ssoLabel = computed(() => form.providerName.trim() || '单点登录')
/** 表单有内容就展示字段，即使 SSO 暂时关闭，管理员仍可查看与修改已存的配置。 */
const showSsoFields = computed(
  () =>
    form.ssoEnabled || Boolean(form.issuer.trim() || form.clientId.trim()) || hasStoredSecret.value,
)
/** 只剩密钥登录一种方式时不能就地关闭（R7：两者不能同时关闭）。 */
const keyLoginLocked = computed(() => form.keyLoginEnabled && !form.ssoEnabled)
/** 只剩 SSO 一种方式时不能就地关闭。 */
const ssoLocked = computed(() => form.ssoEnabled && !form.keyLoginEnabled)
const secretState = computed(() =>
  hasStoredSecret.value ? '已保存，留空则不修改' : '尚未保存，请填写提供方分配的密钥',
)

function payload(includeSecret: boolean) {
  const body: Record<string, unknown> = {
    keyLoginEnabled: form.keyLoginEnabled,
    ssoEnabled: form.ssoEnabled,
    providerName: form.providerName.trim(),
    issuer: form.issuer.trim(),
    clientId: form.clientId.trim(),
    scope: form.scope.trim(),
    allowedSubjects: listOf(form.allowedSubjects),
    allowedEmails: listOf(form.allowedEmails),
  }
  // 空值表示"保留已保存的密钥"（design 2.7），绝不用占位符覆盖。
  if (includeSecret && form.clientSecret.trim()) body.clientSecret = form.clientSecret.trim()
  return body
}

const comparable = computed(() => JSON.stringify(payload(false)))

watch(comparable, (value) => {
  dirty.value = Boolean(snapshot) && value !== snapshot
  saveError.value = ''
})
watch(dirty, (value) => {
  if (value) window.addEventListener('beforeunload', guardUnload)
  else window.removeEventListener('beforeunload', guardUnload)
})

function guardUnload(event: BeforeUnloadEvent) {
  event.preventDefault()
  event.returnValue = ''
}

function apply(settings: AuthSettings) {
  form.keyLoginEnabled = settings.keyLoginEnabled !== false
  form.ssoEnabled = settings.ssoEnabled === true
  form.providerName = settings.providerName ?? ''
  form.issuer = settings.issuer ?? ''
  form.clientId = settings.clientId ?? ''
  form.clientSecret = ''
  form.scope = settings.scope || DEFAULT_SCOPE
  form.allowedSubjects = (settings.allowedSubjects ?? []).join('\n')
  form.allowedEmails = (settings.allowedEmails ?? []).join('\n')
  hasStoredSecret.value = settings.hasClientSecret === true
  stored.ssoEnabled = form.ssoEnabled
  stored.keyLoginEnabled = form.keyLoginEnabled
  stored.callbackUrl = settings.callbackUrl ?? ''
  showSecret.value = false
  clearFieldErrors()
  snapshot = JSON.stringify(payload(false))
  dirty.value = false
}

function clearFieldErrors() {
  for (const key of FIELD_KEYS) fieldErrors[key] = ''
  saveError.value = ''
  confirmError.value = ''
}

function messageOf(error: unknown, fallback: string) {
  const message = error instanceof Error ? error.message.trim() : ''
  return message || fallback
}

async function request<T>(method: 'GET' | 'PATCH', body?: unknown): Promise<T> {
  let response: Response
  try {
    response = await fetch(SETTINGS_PATH, {
      method,
      credentials: 'same-origin',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    })
  } catch {
    throw new Error('无法连接面板服务，请检查网络后重试')
  }
  let data: any
  try {
    data = await response.json()
  } catch {
    data = undefined
  }
  if (!response.ok) {
    const message =
      typeof data?.error?.message === 'string' && data.error.message.trim()
        ? data.error.message.trim()
        : response.status === 401
          ? '登录状态已失效，请重新登录'
          : `登录方式保存失败（HTTP ${response.status}）`
    throw new Error(message)
  }
  if (!data || typeof data !== 'object') throw new Error('面板返回了无法识别的登录配置，请稍后重试')
  return data as T
}

async function load() {
  loading.value = true
  loadError.value = ''
  clearFieldErrors()
  try {
    apply(await request<AuthSettings>('GET'))
  } catch (error) {
    loadError.value = messageOf(error, '无法读取登录方式配置，请稍后重试')
  } finally {
    loading.value = false
  }
}

/** 后端报错尽量落到对应字段旁（design 2.6）。 */
function fieldForMessage(message: string): FieldKey | null {
  if (/密钥登录/.test(message)) return 'keyLoginEnabled'
  if (/颁发者|discovery|发现文档/i.test(message)) return 'issuer'
  if (/客户端\s*ID|client_id/i.test(message)) return 'clientId'
  if (/客户端密钥|client_secret/i.test(message)) return 'clientSecret'
  if (/scope/i.test(message)) return 'scope'
  if (/subject/i.test(message)) return 'allowedSubjects'
  if (/邮箱/.test(message)) return 'allowedEmails'
  if (/回调地址/.test(message)) return 'callbackUrl'
  if (/名称/.test(message)) return 'providerName'
  if (/SSO|单点登录/i.test(message)) return 'ssoEnabled'
  return null
}

function focusField(key: FieldKey) {
  const target = root.value?.querySelector<HTMLElement>(`[data-field="${key}"]`)
  if (!target) return
  target.focus({ preventScroll: true })
  target.scrollIntoView({ block: 'center', behavior: 'smooth' })
}

/** 本地先校验一遍，避免把明显不合法的表单发出去。 */
function validate() {
  clearFieldErrors()
  const issues: [FieldKey, string][] = []
  const issuer = form.issuer.trim()
  const subjects = listOf(form.allowedSubjects)
  const emails = listOf(form.allowedEmails)

  if (!form.keyLoginEnabled && !form.ssoEnabled)
    issues.push(['keyLoginEnabled', '面板密钥登录与单点登录不能同时关闭，否则将无法进入控制台。'])

  if (form.ssoEnabled) {
    if (!issuer) issues.push(['issuer', '启用单点登录需要填写颁发者地址。'])
    else if (!/^https?:\/\/\S+$/i.test(issuer))
      issues.push(['issuer', '颁发者需要完整的 http(s) 地址，例如 https://sso.example.com'])
    else if (
      /^http:\/\//i.test(issuer) &&
      !/^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::\d+)?(?:[/?#]|$)/i.test(issuer)
    )
      issues.push(['issuer', '颁发者需要使用 HTTPS 地址。'])
    if (!form.clientId.trim()) issues.push(['clientId', '启用单点登录需要填写客户端 ID。'])
    if (!hasStoredSecret.value && !form.clientSecret.trim())
      issues.push(['clientSecret', '启用单点登录需要填写客户端密钥。'])
    if (!form.scope.trim().split(/\s+/).filter(Boolean).includes('openid'))
      issues.push(['scope', '授权范围至少需要包含 openid。'])
    if (!subjects.length && !emails.length)
      issues.push(['allowedSubjects', '至少填写一个允许的 subject 或已验证邮箱。'])
  }

  const badEmail = emails.find((value) => !/^[^@\s]+@[^@\s]+$/.test(value))
  if (badEmail) issues.push(['allowedEmails', `「${badEmail}」不是有效的邮箱地址。`])

  for (const [key, message] of issues) fieldErrors[key] = message
  if (issues.length) {
    void nextTick(() => focusField(issues[0]![0]))
    return false
  }
  return true
}

/** 本次保存会关闭哪些登录方式（破坏性操作，需二次确认）。 */
const disabling = computed(() => {
  const items: string[] = []
  if (stored.keyLoginEnabled && !form.keyLoginEnabled) items.push('面板密钥登录')
  if (stored.ssoEnabled && !form.ssoEnabled) items.push(`单点登录（${ssoLabel.value}）`)
  return items
})

async function save() {
  if (saving.value || !dirty.value) return
  if (!validate()) return
  if (disabling.value.length) {
    pendingDisable.value = disabling.value
    confirmError.value = ''
    confirming.value = true
    await nextTick()
    confirmDialog.value?.showModal()
    confirmButton.value?.focus()
    return
  }
  await commit()
}

async function commit() {
  saving.value = true
  confirmBusy.value = confirming.value
  saveError.value = ''
  confirmError.value = ''
  try {
    apply(await request<AuthSettings>('PATCH', payload(true)))
    closeConfirm()
    announce('登录方式已保存')
  } catch (error) {
    const message = messageOf(error, '登录方式保存失败，请稍后重试')
    const field = fieldForMessage(message)
    // 能落到字段就不在页脚重复同一条原因（design 2.6：原因写在字段旁）。
    if (field) fieldErrors[field] = message
    if (confirming.value) confirmError.value = message
    else if (!field) saveError.value = message
  } finally {
    saving.value = false
    confirmBusy.value = false
  }
}

function closeConfirm() {
  confirming.value = false
  pendingDisable.value = []
  confirmError.value = ''
  const dialog = confirmDialog.value
  if (dialog?.open) dialog.close()
}

function announce(text: string) {
  toast.value = text
  window.clearTimeout(toastTimer)
  toastTimer = window.setTimeout(() => {
    toast.value = ''
  }, 4000)
}

async function copyText(text: string, key: string) {
  if (!text) return
  try {
    if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text)
    else {
      const input = document.createElement('textarea')
      input.value = text
      input.readOnly = true
      input.style.position = 'fixed'
      input.style.opacity = '0'
      document.body.appendChild(input)
      input.select()
      const copied = document.execCommand('copy')
      input.remove()
      if (!copied) throw new Error('clipboard unavailable')
    }
    copiedKey.value = key
    window.clearTimeout(copyTimer)
    copyTimer = window.setTimeout(() => {
      copiedKey.value = ''
    }, 2000)
  } catch {
    announce('复制失败，请手动选择内容复制')
  }
}

function toggleKeyLogin(event: Event) {
  const input = event.target as HTMLInputElement
  form.keyLoginEnabled = input.checked
}

function toggleSso(event: Event) {
  const input = event.target as HTMLInputElement
  form.ssoEnabled = input.checked
  clearFieldErrors()
}

onMounted(() => {
  void load()
})

onBeforeUnmount(() => {
  window.removeEventListener('beforeunload', guardUnload)
  window.clearTimeout(toastTimer)
  window.clearTimeout(copyTimer)
})
</script>

<template>
  <section ref="root" class="section-panel auth-panel" data-testid="auth-settings-section">
    <div class="section-heading">
      <ShieldCheck :size="18" />
      <div>
        <h2>登录方式</h2>
        <p>管理员用以下任一方式进入控制台，两种方式至少要保留一种。</p>
      </div>
    </div>

    <div v-if="loading" class="auth-state">
      <LoaderCircle :size="16" class="spin" /><span>正在读取登录方式…</span>
    </div>

    <div v-else-if="loadError" class="auth-state auth-state-error" role="alert">
      <CircleAlert :size="16" /><span>{{ loadError }}</span
      ><button type="button" class="button" @click="load">
        <RefreshCw :size="14" /><span>重新读取</span>
      </button>
    </div>

    <form v-else class="auth-form" novalidate @submit.prevent="save">
      <div class="auth-switches">
        <div class="auth-switch" :class="{ locked: keyLoginLocked }">
          <label class="auth-switch-main">
            <input
              type="checkbox"
              data-field="keyLoginEnabled"
              :checked="form.keyLoginEnabled"
              :disabled="saving || keyLoginLocked"
              :aria-describedby="'key-login-hint'"
              @change="toggleKeyLogin"
            /><span class="auth-track" aria-hidden="true" /><span class="auth-switch-text"
              ><strong>面板密钥登录</strong
              ><small id="key-login-hint">使用部署时设置的面板密钥登录。</small></span
            >
          </label>
          <p v-if="keyLoginLocked" class="auth-lock">
            <CircleAlert :size="13" />先启用可用的单点登录，再关闭这一项，否则会无法进入控制台。
          </p>
          <p v-if="fieldErrors.keyLoginEnabled" class="field-error" role="alert">
            {{ fieldErrors.keyLoginEnabled }}
          </p>
        </div>

        <div class="auth-switch" :class="{ locked: ssoLocked }">
          <label class="auth-switch-main">
            <input
              type="checkbox"
              data-field="ssoEnabled"
              :checked="form.ssoEnabled"
              :disabled="saving || ssoLocked"
              aria-describedby="sso-hint"
              @change="toggleSso"
            /><span class="auth-track" aria-hidden="true" /><span class="auth-switch-text"
              ><strong>单点登录（SSO）</strong
              ><small id="sso-hint">允许管理员用外部 OIDC 提供方登录。</small></span
            >
          </label>
          <p v-if="ssoLocked" class="auth-lock">
            <CircleAlert :size="13" />先启用面板密钥登录，再关闭这一项。
          </p>
          <p v-if="fieldErrors.ssoEnabled" class="field-error" role="alert">
            {{ fieldErrors.ssoEnabled }}
          </p>
        </div>
      </div>

      <fieldset v-if="showSsoFields" class="auth-fields" :disabled="saving">
        <legend class="sr-only">单点登录配置</legend>

        <label class="auth-field">
          <span class="auth-label"
            >提供方名称<small>登录页展示的名称，留空显示「单点登录」。</small></span
          >
          <input
            v-model="form.providerName"
            data-field="providerName"
            type="text"
            maxlength="60"
            autocomplete="off"
            placeholder="例如 AzureKiln SSO"
            :aria-invalid="Boolean(fieldErrors.providerName)"
          />
          <span v-if="fieldErrors.providerName" class="field-error" role="alert">{{
            fieldErrors.providerName
          }}</span>
        </label>

        <label class="auth-field">
          <span class="auth-label">颁发者<small>提供方发现文档所在的地址。</small></span>
          <input
            v-model="form.issuer"
            data-field="issuer"
            type="url"
            inputmode="url"
            autocomplete="off"
            spellcheck="false"
            placeholder="https://sso.example.com"
            :aria-invalid="Boolean(fieldErrors.issuer)"
          />
          <span v-if="fieldErrors.issuer" class="field-error" role="alert">{{
            fieldErrors.issuer
          }}</span>
        </label>

        <label class="auth-field">
          <span class="auth-label">客户端 ID<small>提供方为面板登记的客户端编号。</small></span>
          <input
            v-model="form.clientId"
            data-field="clientId"
            type="text"
            autocomplete="off"
            spellcheck="false"
            placeholder="客户端编号"
            :aria-invalid="Boolean(fieldErrors.clientId)"
          />
          <span v-if="fieldErrors.clientId" class="field-error" role="alert">{{
            fieldErrors.clientId
          }}</span>
        </label>

        <div class="auth-field">
          <label class="auth-label" for="auth-client-secret"
            >客户端密钥<small>{{ secretState }}</small></label
          >
          <span class="auth-secret">
            <input
              id="auth-client-secret"
              v-model="form.clientSecret"
              data-field="clientSecret"
              :type="showSecret ? 'text' : 'password'"
              autocomplete="new-password"
              spellcheck="false"
              :placeholder="hasStoredSecret ? '已保存，留空则不修改' : '填写提供方分配的客户端密钥'"
              :aria-invalid="Boolean(fieldErrors.clientSecret)"
            />
            <button
              type="button"
              class="icon-button"
              :aria-label="showSecret ? '隐藏客户端密钥' : '显示客户端密钥'"
              @click="showSecret = !showSecret"
            >
              <EyeOff v-if="showSecret" :size="15" /><Eye v-else :size="15" />
            </button>
          </span>
          <span v-if="fieldErrors.clientSecret" class="field-error" role="alert">{{
            fieldErrors.clientSecret
          }}</span>
        </div>

        <label class="auth-field">
          <span class="auth-label"
            >授权范围<small>至少包含 openid；需要邮箱白名单时加上 email。</small></span
          >
          <input
            v-model="form.scope"
            data-field="scope"
            type="text"
            autocomplete="off"
            spellcheck="false"
            :placeholder="DEFAULT_SCOPE"
            :aria-invalid="Boolean(fieldErrors.scope)"
          />
          <span v-if="fieldErrors.scope" class="field-error" role="alert">{{
            fieldErrors.scope
          }}</span>
        </label>

        <label class="auth-field auth-wide">
          <span class="auth-label"
            >允许的 Subject<small>每行一个 subject，精确匹配且区分大小写。</small></span
          >
          <textarea
            v-model="form.allowedSubjects"
            data-field="allowedSubjects"
            rows="3"
            spellcheck="false"
            placeholder="每行一个 subject"
            :aria-invalid="Boolean(fieldErrors.allowedSubjects)"
          />
          <span v-if="fieldErrors.allowedSubjects" class="field-error" role="alert">{{
            fieldErrors.allowedSubjects
          }}</span>
        </label>

        <label class="auth-field auth-wide">
          <span class="auth-label"
            >允许的邮箱<small>每行一个邮箱，只接受提供方已验证的邮箱。</small></span
          >
          <textarea
            v-model="form.allowedEmails"
            data-field="allowedEmails"
            rows="3"
            spellcheck="false"
            placeholder="每行一个邮箱"
            :aria-invalid="Boolean(fieldErrors.allowedEmails)"
          />
          <span v-if="fieldErrors.allowedEmails" class="field-error" role="alert">{{
            fieldErrors.allowedEmails
          }}</span>
        </label>

        <div class="auth-field auth-wide">
          <span class="auth-label">回调地址<small>在提供方登记此地址，面板侧只读。</small></span>
          <span class="auth-readonly">
            <code>{{ stored.callbackUrl || '保存后由面板生成' }}</code>
            <button
              type="button"
              class="icon-button"
              :aria-label="copiedKey === 'callback' ? '已复制回调地址' : '复制回调地址'"
              :disabled="!stored.callbackUrl"
              @click="copyText(stored.callbackUrl, 'callback')"
            >
              <Copy v-if="copiedKey !== 'callback'" :size="15" /><span v-else class="auth-copied"
                >已复制</span
              >
            </button>
          </span>
        </div>
      </fieldset>

      <p v-else class="auth-hint">启用单点登录后填写提供方信息，保存时面板会先校验颁发者地址。</p>

      <p v-if="saveError" class="form-error" role="alert">{{ saveError }}</p>

      <footer class="auth-actions">
        <span class="auth-status">
          <KeyRound :size="13" />客户端密钥{{ hasStoredSecret ? '已保存' : '未保存' }}
          <template v-if="dirty"> · 有未保存的修改</template>
        </span>
        <div class="button-group">
          <button type="button" class="button" :disabled="saving" @click="load">
            <RefreshCw :size="14" /><span>重新读取</span>
          </button>
          <button
            type="submit"
            class="button primary"
            data-testid="auth-settings-save"
            :disabled="saving || loading || !dirty"
          >
            <LoaderCircle v-if="saving" :size="16" class="spin" /><Save v-else :size="16" />{{
              saving ? '正在保存' : '保存登录方式'
            }}
          </button>
        </div>
      </footer>
    </form>

    <dialog
      ref="confirmDialog"
      class="auth-confirm"
      aria-labelledby="auth-confirm-title"
      @cancel.prevent="closeConfirm"
    >
      <div class="auth-confirm-body">
        <h2 id="auth-confirm-title">关闭「{{ pendingDisable.join('」和「') }}」</h2>
        <p>关闭后只能用剩下的登录方式进入控制台。确认已能用它登录，再继续。</p>
        <p v-if="confirmError" class="form-error" role="alert">{{ confirmError }}</p>
        <div class="auth-confirm-actions">
          <button ref="confirmButton" type="button" class="button" @click="closeConfirm">
            取消
          </button>
          <button type="button" class="button danger" :disabled="confirmBusy" @click="commit">
            <LoaderCircle v-if="confirmBusy" :size="15" class="spin" />关闭
          </button>
        </div>
      </div>
    </dialog>

    <p v-if="toast" class="auth-toast" role="status">{{ toast }}</p>
  </section>
</template>

<style scoped>
.auth-panel {
  margin-bottom: 18px;
}
.auth-state {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 18px 22px;
  border-top: 1px solid var(--line);
  color: var(--muted);
  font-size: 13px;
}
.auth-state-error {
  color: var(--red);
  flex-wrap: wrap;
}
.auth-state-error .button {
  margin-left: auto;
}
.auth-form {
  border-top: 1px solid var(--line);
  padding: 16px 22px 18px;
}
.auth-switches {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
  gap: 10px;
  margin-bottom: 16px;
}
.auth-switch {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 11px 13px;
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  background: var(--surface-subtle);
}
.auth-switch.locked {
  opacity: 0.72;
}
.auth-switch-main {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  cursor: pointer;
}
.auth-switch-main input {
  position: absolute;
  width: 1px;
  height: 1px;
  opacity: 0;
}
.auth-track {
  position: relative;
  flex-shrink: 0;
  width: 32px;
  height: 18px;
  margin-top: 2px;
  border-radius: var(--radius-full);
  background: var(--line-strong);
  transition: background 0.15s ease;
}
.auth-track::after {
  content: '';
  position: absolute;
  top: 2px;
  left: 2px;
  width: 14px;
  height: 14px;
  border-radius: var(--radius-full);
  background: var(--surface);
  box-shadow: 0 1px 2px #1c315030;
  transition: transform 0.15s ease;
}
.auth-switch-main input:checked + .auth-track {
  background: var(--primary);
}
.auth-switch-main input:checked + .auth-track::after {
  transform: translateX(14px);
}
.auth-switch-main input:focus-visible + .auth-track {
  outline: 2px solid var(--primary);
  outline-offset: 2px;
}
/* A locked switch still shows its real state; only the affordance dims. */
.auth-switch-main input:disabled + .auth-track {
  opacity: 0.55;
}
.auth-switch-main input:disabled ~ .auth-switch-text strong {
  color: var(--secondary);
}
.auth-switch-text {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.auth-switch-text strong {
  font-size: 13px;
  font-weight: 600;
}
.auth-switch-text small {
  font-size: 12px;
  color: var(--muted);
  line-height: 1.7;
}
.auth-lock {
  display: flex;
  align-items: flex-start;
  gap: 5px;
  margin: 0;
  font-size: 12px;
  line-height: 1.7;
  color: var(--amber);
}
.auth-lock svg {
  margin-top: 2px;
  flex-shrink: 0;
}
.auth-fields {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(320px, 1fr));
  gap: 13px 16px;
  margin: 0 0 14px;
  padding: 0;
  border: 0;
}
.auth-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.auth-wide {
  grid-column: 1 / -1;
}
.auth-label {
  display: flex;
  flex-direction: column;
  gap: 2px;
  font-size: 12px;
  font-weight: 550;
  color: var(--secondary);
}
.auth-label small {
  font-size: 12px;
  font-weight: 400;
  color: var(--muted);
  line-height: 1.7;
}
.auth-field textarea {
  resize: vertical;
  min-height: 60px;
  line-height: 1.7;
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
}
.auth-secret,
.auth-readonly {
  display: flex;
  align-items: center;
  gap: 4px;
  padding-right: 3px;
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-xs);
  background: var(--surface);
}
.auth-readonly {
  padding: 4px 5px 4px 9px;
  background: var(--surface-subtle);
}
.auth-secret:focus-within {
  border-color: var(--primary);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--primary) 9%, transparent);
}
.auth-secret input {
  border: 0;
  background: transparent;
  box-shadow: none;
}
.auth-secret input:focus {
  box-shadow: none;
}
.auth-readonly code {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  line-height: 1.7;
  overflow-wrap: anywhere;
}
.auth-copied {
  font-size: 11px;
  color: var(--green);
  white-space: nowrap;
}
.field-error {
  font-size: 12px;
  line-height: 1.7;
  color: var(--red);
}
.auth-hint {
  margin: 0 0 14px;
  font-size: 12px;
  color: var(--muted);
  line-height: 1.8;
}
.auth-actions {
  display: flex;
  align-items: center;
  gap: 12px;
  flex-wrap: wrap;
  padding-top: 13px;
  border-top: 1px solid var(--line);
}
.auth-status {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-size: 12px;
  color: var(--muted);
}
.auth-actions .button-group {
  margin-left: auto;
}
.auth-confirm {
  border: 1px solid var(--line-strong);
  border-radius: var(--radius-md);
  padding: 0;
  max-width: 440px;
  background: var(--surface);
  color: var(--text);
  box-shadow: 0 18px 40px #1c315033;
}
.auth-confirm::backdrop {
  background: #10151d66;
}
.auth-confirm-body {
  padding: 18px 20px 16px;
}
.auth-confirm-body h2 {
  margin: 0 0 8px;
  font-size: 15px;
  font-weight: 600;
}
.auth-confirm-body p {
  margin: 0 0 12px;
  font-size: 13px;
  line-height: 1.8;
  color: var(--secondary);
}
.auth-confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.auth-toast {
  position: fixed;
  right: 24px;
  top: 84px;
  z-index: 40;
  margin: 0;
  padding: 10px 14px;
  border-radius: var(--radius-sm);
  border: 1px solid var(--line-strong);
  background: var(--surface);
  box-shadow: 0 10px 24px #1c315026;
  font-size: 13px;
  color: var(--text);
}
.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
@media (max-width: 720px) {
  .auth-form {
    padding: 14px 15px 16px;
  }
  .auth-actions .button-group {
    margin-left: 0;
    width: 100%;
  }
  .auth-actions .button-group .button {
    flex: 1;
  }
  .auth-toast {
    right: 12px;
    left: 12px;
    top: 12px;
  }
}
</style>

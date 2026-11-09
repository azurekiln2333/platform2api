<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { CircleAlert, LoaderCircle, Network, RefreshCw, Save, ShieldCheck, SlidersHorizontal } from '@lucide/vue'
import { notify, reportError } from '../../panel.ts'
import { cnb, formatTime } from './service.ts'
import type { CnbRegistrationRelayStatus, CnbSettings, CnbSsoSettings } from './types.ts'

const STRATEGIES = [
  { id: 'weighted', label: '加权轮询', hint: '按权重与优先级分配请求。' },
  { id: 'least-connections', label: '最少连接', hint: '优先选择进行中请求最少的账号。' },
  { id: 'failover', label: '优先故障转移', hint: '按优先级顺序尝试，失败后切换。' },
] as const

const NUMBERS = [
  { key: 'maxAttempts', label: '最大尝试次数', min: 1, max: 10 },
  { key: 'cooldownSeconds', label: '冷却时间（秒）', min: 5, max: 3600 },
  { key: 'healthIntervalSeconds', label: '探活间隔（秒）', min: 15, max: 3600 },
  { key: 'connectTimeoutSeconds', label: '连接超时（秒）', min: 1, max: 120 },
  { key: 'idleTimeoutSeconds', label: '流式空闲超时（秒）', min: 10, max: 1800 },
] as const

const settings = ref<CnbSettings>({})
const sso = ref<CnbSsoSettings>({})
const relay = ref<CnbRegistrationRelayStatus | null>(null)
const loading = ref(false)
const saving = ref('')
const error = ref('')
const overridesText = ref('')
const headersText = ref('')

const strategy = computed(() => settings.value.strategy ?? 'weighted')

function syncEditors() {
  overridesText.value = JSON.stringify(settings.value.requestOverrides ?? { operations: [] }, null, 2)
  headersText.value = JSON.stringify(settings.value.upstreamHeaders ?? {}, null, 2)
}

async function load() {
  loading.value = true
  try {
    const [gateway, auth, relayStatus] = await Promise.all([
      cnb<{ settings: CnbSettings }>('/api/settings'),
      cnb<CnbSsoSettings>('/api/auth/settings').catch(() => ({}) as CnbSsoSettings),
      cnb<CnbRegistrationRelayStatus>('/api/registration-relay').catch(() => null),
    ])
    settings.value = gateway.settings ?? {}
    sso.value = auth ?? {}
    relay.value = relayStatus
    syncEditors()
    error.value = ''
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '读取 CNB 设置失败'
  } finally {
    loading.value = false
  }
}

async function patch(payload: Record<string, unknown>, label: string) {
  saving.value = label
  try {
    const result = await cnb<{ settings: CnbSettings }>('/api/settings', 'PATCH', payload)
    settings.value = result.settings ?? settings.value
    syncEditors()
    notify('设置已保存')
  } catch (cause) {
    reportError(cause, '保存 CNB 设置失败')
  } finally {
    saving.value = ''
  }
}

function applyJson() {
  let requestOverrides: unknown
  let upstreamHeaders: unknown
  try {
    requestOverrides = JSON.parse(overridesText.value || '{"operations":[]}')
  } catch {
    notify('请求改写规则不是合法 JSON', true)
    return
  }
  try {
    upstreamHeaders = JSON.parse(headersText.value || '{}')
  } catch {
    notify('上游请求头不是合法 JSON', true)
    return
  }
  void patch({ requestOverrides, upstreamHeaders }, 'json')
}

async function saveNumbers(event: Event) {
  const form = event.target as HTMLFormElement
  const payload: Record<string, number> = {}
  for (const field of NUMBERS) {
    const input = form.elements.namedItem(field.key)
    if (input instanceof HTMLInputElement) payload[field.key] = Number(input.value)
  }
  await patch(payload, 'numbers')
}

async function saveSso() {
  saving.value = 'sso'
  try {
    sso.value = await cnb<CnbSsoSettings>('/api/auth/settings', 'PATCH', {
      ssoEnabled: sso.value.ssoEnabled === true,
      keyLoginEnabled: sso.value.keyLoginEnabled !== false,
      issuer: sso.value.issuer ?? '',
      clientId: sso.value.clientId ?? '',
      ...(typeof sso.value.clientSecret === 'string' && sso.value.clientSecret
        ? { clientSecret: sso.value.clientSecret }
        : {}),
      scope: sso.value.scope ?? 'openid profile email',
      providerName: sso.value.providerName ?? '',
      allowedSubjects: sso.value.allowedSubjects ?? [],
      allowedEmails: sso.value.allowedEmails ?? [],
      ...(sso.value.callbackUrl ? { callbackUrl: sso.value.callbackUrl } : {}),
    })
    notify('单点登录配置已保存')
  } catch (cause) {
    reportError(cause, '保存单点登录配置失败')
  } finally {
    saving.value = ''
  }
}

async function syncRelay() {
  saving.value = 'relay'
  try {
    relay.value = await cnb<CnbRegistrationRelayStatus>('/api/registration-relay/sync', 'POST', {})
    notify('已触发注册中继同步')
  } catch (cause) {
    reportError(cause, '注册中继同步失败')
  } finally {
    saving.value = ''
  }
}

const relayServers = computed(() => relay.value?.servers ?? [])

onMounted(() => {
  void load()
})
</script>

<template>
  <section>
    <header class="page-heading">
      <div>
        <span class="eyebrow"><i class="blue-line" /> CNB SETTINGS</span>
        <h1>CNB 服务设置</h1>
        <p>调度策略、超时、额度保护、请求改写与单点登录都写入 CNB 服务自身。</p>
      </div>
      <div class="heading-actions">
        <button class="button" :disabled="loading" @click="load">
          <RefreshCw :size="15" :class="{ spin: loading }" /><span>重新读取</span>
        </button>
      </div>
    </header>

    <div v-if="error" class="error-banner" role="alert">
      <CircleAlert :size="16" /><span>{{ error }}</span><button @click="load">重试</button>
    </div>

    <section class="section-panel">
      <div class="section-heading">
        <SlidersHorizontal :size="20" />
        <div><h2>调度策略</h2><p>策略变更对后续请求立即生效。</p></div>
      </div>
      <div class="strategy-grid">
        <button
          v-for="item in STRATEGIES"
          :key="item.id"
          class="strategy-card"
          :class="{ selected: strategy === item.id }"
          @click="patch({ strategy: item.id }, 'strategy')"
        >
          <div class="strategy-card-top"><strong>{{ item.label }}</strong></div>
          <p>{{ item.hint }}</p>
        </button>
      </div>
      <form class="settings-fields" @submit.prevent="saveNumbers">
        <label v-for="field in NUMBERS" :key="field.key">
          {{ field.label }}
          <input
            :name="field.key"
            type="number"
            :min="field.min"
            :max="field.max"
            :value="settings[field.key] ?? field.min"
          />
          <small>{{ field.min }}–{{ field.max }}</small>
        </label>
        <div class="button-group">
          <button class="button primary" type="submit" :disabled="saving === 'numbers'">
            <Save :size="14" /><span>保存数值</span>
          </button>
        </div>
      </form>
      <div class="settings-fields">
        <label
          >兼容开关
          <div class="tag-chips">
            <label class="check-label"
              ><input
                type="checkbox"
                :checked="settings.dshCompat === true"
                @change="patch({ dshCompat: !(settings.dshCompat === true) }, 'compat')"
              />DSH 兼容</label
            >
            <label class="check-label"
              ><input
                type="checkbox"
                :checked="settings.claudeCodeCompat === true"
                @change="patch({ claudeCodeCompat: !(settings.claudeCodeCompat === true) }, 'compat')"
              />Claude Code 兼容</label
            >
          </div>
        </label>
        <label
          >会话保持
          <label class="check-label"
            ><input
              type="checkbox"
              :checked="settings.sessionAffinity === true"
              @change="patch({ sessionAffinity: !(settings.sessionAffinity === true) }, 'affinity')"
            />同一会话优先回到同一账号</label
          >
        </label>
        <label
          >额度保护
          <div class="tag-chips">
            <label class="check-label"
              ><input
                type="checkbox"
                :checked="settings.quotaProtection?.enabled === true"
                @change="
                  patch(
                    {
                      quotaProtection: {
                        ...(settings.quotaProtection ?? {}),
                        enabled: !(settings.quotaProtection?.enabled === true),
                        thresholdPercent: settings.quotaProtection?.thresholdPercent ?? 10,
                      },
                    },
                    'quota',
                  )
                "
              />启用额度保护</label
            >
            <span class="cell-secondary">阈值 {{ settings.quotaProtection?.thresholdPercent ?? 10 }}%</span>
          </div>
        </label>
        <label
          >推理探活
          <div class="tag-chips">
            <label class="check-label"
              ><input
                type="checkbox"
                :checked="settings.inferenceProbe?.enabled === true"
                @change="
                  patch(
                    {
                      inferenceProbe: {
                        ...(settings.inferenceProbe ?? {}),
                        enabled: !(settings.inferenceProbe?.enabled === true),
                        intervalMinutes: settings.inferenceProbe?.intervalMinutes ?? 30,
                      },
                    },
                    'probe',
                  )
                "
              />自动推理探活</label
            >
            <span class="cell-secondary">间隔 {{ settings.inferenceProbe?.intervalMinutes ?? 30 }} 分钟</span>
          </div>
        </label>
      </div>
    </section>

    <section class="section-panel">
      <div class="section-heading">
        <Network :size="20" />
        <div><h2>请求改写与上游请求头</h2><p>两项都是 JSON，保存前会校验格式。</p></div>
      </div>
      <div class="modal-body">
        <label class="override-field"
          >请求改写规则
          <textarea v-model="overridesText" rows="8" spellcheck="false" />
        </label>
        <label class="override-field"
          >上游请求头
          <textarea v-model="headersText" rows="6" spellcheck="false" />
        </label>
        <div class="button-group">
          <button class="button primary" :disabled="saving === 'json'" @click="applyJson">
            <Save :size="14" /><span>保存 JSON</span>
          </button>
        </div>
      </div>
    </section>

    <section class="section-panel">
      <div class="section-heading">
        <RefreshCw :size="20" />
        <div><h2>注册中继</h2><p>为中继服务器分配待注册的工作区地址。</p></div>
        <button class="button" :disabled="saving === 'relay'" @click="syncRelay">立即同步</button>
      </div>
      <div v-if="!relay" class="inline-hint"><LoaderCircle :size="14" class="spin" /><span>注册中继状态不可用</span></div>
      <div v-else-if="!relayServers.length" class="empty-filter"><h3>未配置中继服务器</h3></div>
      <div v-else class="table-scroll">
        <table class="account-table">
          <thead><tr><th>名称</th><th>地址</th><th>状态</th><th>待处理</th><th>失败</th><th>最近成功</th></tr></thead>
          <tbody>
            <tr v-for="server in relayServers" :key="server.id">
              <td>{{ server.name }}</td>
              <td class="mono cell-secondary">{{ server.origin }}</td>
              <td>{{ server.status ?? '—' }}</td>
              <td>{{ server.pending ?? 0 }}</td>
              <td>{{ server.failed ?? 0 }}</td>
              <td class="cell-secondary">{{ formatTime(server.lastSuccessAt) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="section-panel">
      <div class="section-heading">
        <ShieldCheck :size="20" />
        <div><h2>单点登录（OIDC）</h2><p>由 CNB 服务校验；关闭密钥登录前必须先用 SSO 登录验证。</p></div>
        <span class="subtle">回调地址：{{ sso.callbackUrl || '未设置' }}</span>
      </div>
      <form class="settings-fields" @submit.prevent="saveSso">
        <label class="check-label"
          ><input v-model="sso.ssoEnabled" type="checkbox" />启用单点登录</label
        >
        <label class="check-label"
          ><input v-model="sso.keyLoginEnabled" type="checkbox" />允许管理密钥登录</label
        >
        <label>颁发者地址<input v-model="sso.issuer" placeholder="https://idp.example.com" /></label>
        <label>客户端 ID<input v-model="sso.clientId" /></label>
        <label
          >客户端密钥<input
            v-model="sso.clientSecret"
            type="password"
            autocomplete="new-password"
            :placeholder="sso.hasClientSecret ? '已保存，留空则不修改' : '未设置'"
        /></label>
        <label>授权范围<input v-model="sso.scope" placeholder="openid profile email" /></label>
        <label>显示名称<input v-model="sso.providerName" placeholder="SSO" /></label>
        <label
          >允许的身份（sub，逗号分隔）
          <input
            :value="(sso.allowedSubjects ?? []).join(', ')"
            @input="
              (event) =>
                (sso.allowedSubjects = (event.target as HTMLInputElement).value
                  .split(',')
                  .map((item) => item.trim())
                  .filter(Boolean))
            "
          />
        </label>
        <label
          >允许的邮箱（逗号分隔）
          <input
            :value="(sso.allowedEmails ?? []).join(', ')"
            @input="
              (event) =>
                (sso.allowedEmails = (event.target as HTMLInputElement).value
                  .split(',')
                  .map((item) => item.trim())
                  .filter(Boolean))
            "
          />
        </label>
        <p v-if="sso.hasClientSecret" class="inline-hint">已配置客户端密钥；重新填写会覆盖。</p>
        <div class="button-group">
          <button class="button primary" type="submit" :disabled="saving === 'sso'">
            <Save :size="14" /><span>保存单点登录</span>
          </button>
        </div>
      </form>
    </section>
  </section>
</template>

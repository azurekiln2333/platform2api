<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  ArrowUpRight,
  CircleAlert,
  Clock,
  KeyRound,
  LoaderCircle,
  Play,
  RefreshCw,
  Square,
} from '@lucide/vue'
import { copy, notify, reportError } from '../../panel.ts'
import { formatNumber } from '../../systems.ts'
import { ONBOARD_PROVIDERS, formatTime, zcode } from './service.ts'
import type { ZcodeClaimAutomation, ZcodeOnboardFlow } from './types.ts'

const provider = ref<(typeof ONBOARD_PROVIDERS)[number]['id']>('zai')
const flow = ref<ZcodeOnboardFlow | null>(null)
const starting = ref(false)
const failure = ref('')
const pasteUrl = ref('')
const redeeming = ref(false)
const automation = ref<ZcodeClaimAutomation | null>(null)
const automationSaving = ref('')
const claimable = ref<Array<Record<string, unknown>>>([])
let timer: number | undefined

const flowStatus = computed(() => flow.value?.status ?? '')
const finished = computed(() => flowStatus.value === 'ready' || flowStatus.value === 'failed')
const schedule = computed(() => ({
  enabled: automation.value?.settings?.enabled === true,
  time: typeof automation.value?.settings?.time === 'string' ? automation.value.settings.time : '09:00',
  timezone:
    typeof automation.value?.settings?.timezone === 'string'
      ? automation.value.settings.timezone
      : 'Asia/Shanghai',
}))

function stopPolling() {
  if (timer !== undefined) {
    window.clearTimeout(timer)
    timer = undefined
  }
}

function schedulePoll() {
  stopPolling()
  if (!flow.value?.flowId || finished.value) return
  const delay = Math.max(1000, Number(flow.value.pollIntervalSec ?? 5) * 1000)
  timer = window.setTimeout(() => void poll(flow.value?.flowId ?? ''), delay)
}

async function start() {
  starting.value = true
  failure.value = ''
  flow.value = null
  try {
    const result = await zcode<ZcodeOnboardFlow>('/api/onboard/start', 'POST', { provider: provider.value })
    flow.value = result
    notify('已创建授权流程，请在新窗口完成登录')
    schedulePoll()
  } catch (cause) {
    failure.value = cause instanceof Error ? cause.message : '无法发起授权流程'
    reportError(cause, '发起 ZCode 授权失败')
  } finally {
    starting.value = false
  }
}

async function poll(flowId: string) {
  if (!flowId) return
  try {
    flow.value = await zcode<ZcodeOnboardFlow>(`/api/onboard/poll/${encodeURIComponent(flowId)}`)
    if (finished.value) {
      notify(flowStatus.value === 'ready' ? '账号已加入 ZCode 账号池' : '授权失败', flowStatus.value !== 'ready')
      void loadClaimable()
      return
    }
    schedulePoll()
  } catch (cause) {
    failure.value = cause instanceof Error ? cause.message : '授权状态查询失败'
  }
}

async function redeem() {
  const url = pasteUrl.value.trim()
  if (!url) return
  redeeming.value = true
  failure.value = ''
  try {
    flow.value = await zcode<ZcodeOnboardFlow>('/api/onboard/redeem', 'POST', {
      url,
      ...(flow.value?.flowId ? { flowId: flow.value.flowId } : {}),
    })
    if (flowStatus.value === 'ready') {
      notify('授权完成，账号已加入账号池')
      pasteUrl.value = ''
      void loadClaimable()
    } else {
      notify('上游仍在处理，请稍候或再次提交', true)
      schedulePoll()
    }
  } catch (cause) {
    failure.value = cause instanceof Error ? cause.message : '兑付授权链接失败'
    reportError(cause, '兑付授权链接失败')
  } finally {
    redeeming.value = false
  }
}

async function loadAutomation() {
  try {
    automation.value = await zcode<ZcodeClaimAutomation>('/api/claim-automation')
  } catch (cause) {
    reportError(cause, '读取定时领取配置失败')
  }
}

async function saveAutomation(patch: Record<string, unknown>) {
  automationSaving.value = 'save'
  try {
    automation.value = await zcode<ZcodeClaimAutomation>('/api/claim-automation', 'PATCH', {
      ...schedule.value,
      ...patch,
    })
    notify('定时领取配置已保存')
  } catch (cause) {
    reportError(cause, '保存定时领取配置失败')
  } finally {
    automationSaving.value = ''
  }
}

async function runAutomation() {
  automationSaving.value = 'run'
  try {
    automation.value = await zcode<ZcodeClaimAutomation>('/api/claim-automation/run', 'POST', {})
    notify('已启动一次领取')
  } catch (cause) {
    reportError(cause, '启动领取失败')
  } finally {
    automationSaving.value = ''
  }
}

async function cancelAutomation() {
  automationSaving.value = 'cancel'
  try {
    automation.value = await zcode<ZcodeClaimAutomation>('/api/claim-automation/cancel', 'POST', {})
    notify('已请求取消领取')
  } catch (cause) {
    reportError(cause, '取消领取失败')
  } finally {
    automationSaving.value = ''
  }
}

async function loadClaimable() {
  try {
    const result = await zcode<{ accounts?: Array<Record<string, unknown>> }>('/claimable')
    claimable.value = Array.isArray(result.accounts) ? result.accounts : []
  } catch {
    /* 领取资格是可选信息，失败时保持上一次结果。 */
  }
}

onMounted(() => {
  void loadAutomation()
  void loadClaimable()
})
onBeforeUnmount(stopPolling)
</script>

<template>
  <section>
    <header class="page-heading">
      <div>
        <span class="eyebrow"><i class="blue-line" /> ZCODE ENROLL</span>
        <h1>ZCode 账号授权</h1>
        <p>登录授权与定时领取都由 ZCode 服务完成；面板只负责发起、轮询与展示。</p>
      </div>
      <div class="heading-actions">
        <button class="button primary" :disabled="starting" @click="start">
          <KeyRound :size="15" :class="{ spin: starting }" /><span>登录新账号</span>
        </button>
      </div>
    </header>

    <div v-if="failure" class="error-banner" role="alert">
      <CircleAlert :size="16" /><span>{{ failure }}</span>
    </div>

    <section class="section-panel">
      <div class="section-heading">
        <KeyRound :size="20" />
        <div><h2>登录授权流程</h2><p>国内账号走 BigModel，国际账号走 Z.ai；provider 选错整条授权链会失败。</p></div>
        <div class="select-wrap">
          <select v-model="provider" aria-label="授权渠道">
            <option v-for="item in ONBOARD_PROVIDERS" :key="item.id" :value="item.id">{{ item.label }}</option>
          </select>
        </div>
      </div>
      <div class="modal-body">
        <div v-if="!flow" class="inline-hint"><span>点击右上角「登录新账号」开始授权。</span></div>
        <template v-else>
          <p class="form-section-title">流程 <code>{{ flow.flowId }}</code></p>
          <p v-if="flow.authorizeUrl" class="inline-hint">
            <a class="text-link" :href="flow.authorizeUrl" target="_blank" rel="noopener noreferrer">
              打开授权页面<ArrowUpRight :size="13" />
            </a>
            <button class="text-link" @click="copy(flow.authorizeUrl ?? '')">复制链接</button>
          </p>
          <p v-if="!finished" class="inline-hint" data-testid="zcode-enroll-pending">
            <LoaderCircle :size="15" class="spin" /><span>等待上游完成授权…（{{ flowStatus }}）</span>
          </p>
          <p v-else-if="flowStatus === 'ready'" class="success-text">账号「{{ flow.label }}」已加入账号池。</p>
          <p v-else class="form-error">{{ flow.error || '授权失败，请重新发起' }}</p>
          <p v-if="flow.claim" class="cell-secondary">
            领取状态：{{ flow.claim.ok ? '已领取' : (flow.claim.code || flow.claim.msg || '待领取') }}
          </p>
          <label
            >授权完成链接（可选）
            <input v-model="pasteUrl" placeholder="https://…/oauth/cli/callback/…?code=…&state=…" />
          </label>
          <div class="button-group">
            <button class="button" :disabled="redeeming || !pasteUrl.trim()" @click="redeem">
              <RefreshCw :size="14" :class="{ spin: redeeming }" /><span>兑付链接</span>
            </button>
            <button v-if="flow.flowId" class="button" @click="poll(flow.flowId)">立即查询状态</button>
          </div>
        </template>
      </div>
    </section>

    <section class="section-panel">
      <div class="section-heading">
        <Clock :size="20" />
        <div><h2>定时领取</h2><p>按本地时间每天自动领取一次；浏览器验证由服务端无头会话完成。</p></div>
        <span class="subtle">下次执行 {{ formatTime(automation?.nextRunAt) }}</span>
      </div>
      <div class="modal-body">
        <div class="form-grid">
          <label class="check-label">
            <input
              type="checkbox"
              :checked="schedule.enabled"
              :disabled="automationSaving === 'save'"
              @change="saveAutomation({ enabled: !schedule.enabled })"
            />启用每天定时领取
          </label>
          <label
            >执行时间
            <input
              type="time"
              :value="schedule.time"
              @change="
                (event) => saveAutomation({ time: (event.target as HTMLInputElement).value })
              "
            />
          </label>
          <label
            >时区
            <input
              :value="schedule.timezone"
              @change="
                (event) => saveAutomation({ timezone: (event.target as HTMLInputElement).value })
              "
            />
          </label>
        </div>
        <p v-if="automation?.error" class="form-error">{{ automation.error }}</p>
        <p v-if="automation?.lastRun" class="cell-secondary">
          上次执行：{{ automation.lastRun.at ?? '—' }} ·
          {{ automation.lastRun.ok === false ? '失败' : '完成' }}
          {{ automation.lastRun.error ?? '' }}
        </p>
        <div class="button-group">
          <button class="button primary" :disabled="automationSaving === 'run' || automation?.running" @click="runAutomation">
            <Play :size="14" /><span>立即领取一次</span>
          </button>
          <button class="button" :disabled="automationSaving === 'cancel' || !automation?.running" @click="cancelAutomation">
            <Square :size="14" /><span>取消当前领取</span>
          </button>
          <button class="button" @click="loadAutomation"><RefreshCw :size="14" /><span>刷新状态</span></button>
        </div>
      </div>
    </section>

    <section class="section-panel">
      <div class="section-heading">
        <RefreshCw :size="20" />
        <div><h2>可领取资格</h2><p>来自服务的 /claimable，读取时会刷新账号资格。</p></div>
        <button class="button" @click="loadClaimable">重新检测</button>
      </div>
      <div v-if="!claimable.length" class="empty-filter"><h3>暂无领取资格</h3></div>
      <div v-else class="table-scroll">
        <table class="account-table">
          <thead><tr><th>账号</th><th>可领取套餐</th></tr></thead>
          <tbody>
            <tr v-for="(row, index) in claimable" :key="index">
              <td>{{ row.label ?? row.email ?? '—' }}</td>
              <td class="cell-secondary">
                {{ Array.isArray(row.claimable) ? formatNumber(row.claimable.length) : '—' }} 个套餐可领取
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </section>
</template>

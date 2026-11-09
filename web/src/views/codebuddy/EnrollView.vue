<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { CircleCheck, ExternalLink, LoaderCircle, QrCode, TriangleAlert } from '@lucide/vue'
import { notify, reportError } from '../../panel.ts'
import { codebuddy } from './service.ts'

const emit = defineEmits<{ finished: []; closed: [] }>()

/**
 * Enrollment is the service's own OAuth flow, not console login. The panel
 * starts the flow, then polls the service for the outcome; the credential is
 * written by CodeBuddy itself.
 */
const site = ref<'cn' | 'intl'>('cn')
const stage = ref<'idle' | 'pending' | 'done' | 'failed'>('idle')
const link = ref('')
const identifier = ref('')
const message = ref('')
const starting = ref(false)
let timer: number | undefined
let active = true

const POLL_MS = 2000

function stopPolling() {
  if (timer !== undefined) window.clearInterval(timer)
  timer = undefined
}

async function poll() {
  if (!identifier.value) return
  try {
    const result = await codebuddy<{
      done?: boolean
      uid?: string
      nickname?: string
      error?: string
    }>(`/admin/oauth/poll?login_id=${encodeURIComponent(identifier.value)}`)
    if (!active) return
    if (result?.error) {
      stopPolling()
      stage.value = 'failed'
      message.value = result.error
      return
    }
    if (!result?.done) return
    stopPolling()
    stage.value = 'done'
    message.value = result.nickname || result.uid || '新凭证'
    notify('CodeBuddy 账号已接入')
    emit('finished')
  } catch (cause) {
    // A transient poll failure must not silently end the flow.
    if (active) reportError(cause, '轮询授权结果失败')
  }
}

async function start() {
  starting.value = true
  stage.value = 'pending'
  message.value = ''
  try {
    const result = await codebuddy<{ login_id: string; verification_uri?: string }>(
      `/admin/oauth/start?site=${site.value}`,
      'POST',
      {},
    )
    identifier.value = result.login_id
    link.value = result.verification_uri || ''
    stopPolling()
    timer = window.setInterval(() => void poll(), POLL_MS)
  } catch (cause) {
    stage.value = 'failed'
    reportError(cause, '发起 CodeBuddy 授权失败')
  } finally {
    starting.value = false
  }
}

function reset() {
  stopPolling()
  stage.value = 'idle'
  link.value = ''
  identifier.value = ''
  message.value = ''
}

onMounted(() => {
  active = true
})
onBeforeUnmount(() => {
  active = false
  stopPolling()
})

defineExpose({ start })
</script>

<template>
  <div class="enroll">
    <header class="enroll-head">
      <div>
        <span class="eyebrow">CODEBUDDY ENROLLMENT</span>
        <h2>接入 CodeBuddy 账号</h2>
        <p class="cell-secondary">接入使用服务自带的 OAuth 流程，与控制台登录相互独立。</p>
      </div>
      <button class="icon-button" aria-label="关闭接入面板" @click="emit('closed')">×</button>
    </header>

    <div class="segmented">
      <button
        :class="{ active: site === 'cn' }"
        :disabled="stage === 'pending'"
        @click="site = 'cn'"
      >
        国内站
      </button>
      <button
        :class="{ active: site === 'intl' }"
        :disabled="stage === 'pending'"
        @click="site = 'intl'"
      >
        国际站
      </button>
    </div>

    <div v-if="stage === 'idle'" class="enroll-body">
      <QrCode :size="26" />
      <p>点击开始后，在浏览器完成授权；凭据由 CodeBuddy 服务直接保存。</p>
      <button class="button primary" :disabled="starting" @click="start">
        <LoaderCircle v-if="starting" :size="15" class="spin" />
        <span>开始接入</span>
      </button>
    </div>

    <div v-else-if="stage === 'pending'" class="enroll-body">
      <LoaderCircle :size="26" class="spin" />
      <p>等待授权完成…</p>
      <a v-if="link" class="button" :href="link" target="_blank" rel="noreferrer noopener">
        <ExternalLink :size="15" /><span>打开授权页面</span>
      </a>
      <p class="cell-secondary">
        本页每 {{ POLL_MS / 1000 }} 秒向服务查询一次结果，关闭本页不会中断服务端流程。
      </p>
    </div>

    <div v-else-if="stage === 'done'" class="enroll-body">
      <CircleCheck :size="26" />
      <p>已接入：{{ message }}</p>
      <div class="button-group">
        <button class="button" @click="reset">再接入一个</button>
        <button class="button primary" @click="emit('closed')">完成</button>
      </div>
    </div>

    <div v-else class="enroll-body">
      <TriangleAlert :size="26" />
      <p>{{ message || '授权未完成。' }}</p>
      <button class="button" @click="reset">重新开始</button>
    </div>
  </div>
</template>

<style scoped>
.enroll {
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.enroll-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 12px;
}
.enroll-head h2 {
  margin: 4px 0;
  font-size: 16px;
}
.enroll-body {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 10px;
  padding: 16px 0 4px;
  color: var(--secondary);
}
.enroll-body p {
  margin: 0;
  font-size: 13px;
}
</style>

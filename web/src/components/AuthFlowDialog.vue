<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { ArrowUpRight, CircleAlert, LoaderCircle, ShieldCheck } from '@lucide/vue'
import ModalShell from './ModalShell.vue'
import SystemBadge from './SystemBadge.vue'
import {
  authPollMs,
  completeAuth,
  copy,
  flowFinished,
  pollAuth,
  reportError,
  startAuth,
  submitAuth,
} from '../panel.ts'
import { systemMeta } from '../systems.ts'
import type { AuthFlow, AuthFlowInput, SystemId } from '../types.ts'

const props = defineProps<{ system: SystemId; accountId?: string; accountLabel?: string }>()
const emit = defineEmits<{ close: []; authorized: [system: SystemId] }>()

const meta = computed(() => systemMeta(props.system))
const flow = ref<AuthFlow | null>(null)
const starting = ref(true)
const submitting = ref(false)
const failure = ref('')
const values = ref<Record<string, string>>({})
let timer: number | undefined
let disposed = false

const inputs = computed<AuthFlowInput[]>(() => flow.value?.inputs ?? [])
const steps = computed(() => flow.value?.steps ?? [])
const status = computed(() => flow.value?.status ?? 'pending')

function clearTimer() {
  if (timer !== undefined) {
    window.clearTimeout(timer)
    timer = undefined
  }
}

function apply(next: AuthFlow) {
  if (disposed) return
  flow.value = next
  failure.value =
    next.status === 'failed' || next.status === 'expired'
      ? next.error || next.message || '授权失败'
      : ''
  const filled: Record<string, string> = {}
  for (const input of next.inputs ?? []) filled[input.name] = values.value[input.name] ?? ''
  values.value = filled
  if (next.status === 'success') {
    clearTimer()
    emit('authorized', props.system)
    return
  }
  if (flowFinished(next.status)) {
    clearTimer()
    return
  }
  schedule(next)
}

function schedule(next: AuthFlow) {
  clearTimer()
  if ((next.inputs ?? []).length) return
  const delay = authPollMs(next)
  timer = window.setTimeout(() => void poll(next.flowId), delay)
}

async function poll(flowId: string) {
  try {
    apply(await pollAuth(props.system, flowId))
  } catch (error) {
    failure.value = error instanceof Error ? error.message : '授权状态查询失败'
    reportError(error, '授权状态查询失败')
  }
}

async function begin() {
  starting.value = true
  failure.value = ''
  try {
    apply(await startAuth(props.system, props.accountId))
  } catch (error) {
    failure.value = error instanceof Error ? error.message : '无法发起授权'
    reportError(error, '无法发起授权')
  } finally {
    starting.value = false
  }
}

async function submit() {
  const current = flow.value
  if (!current || submitting.value) return
  const missing = inputs.value.filter(
    (input) => input.required && !values.value[input.name]?.trim(),
  )
  if (missing.length) {
    failure.value = `请填写${missing.map((input) => input.label).join('、')}`
    return
  }
  submitting.value = true
  failure.value = ''
  try {
    apply(await submitAuth(props.system, current.flowId, values.value))
  } catch (error) {
    failure.value = error instanceof Error ? error.message : '提交失败'
    reportError(error, '提交失败')
  } finally {
    submitting.value = false
  }
}

async function finish() {
  const current = flow.value
  if (!current) return
  submitting.value = true
  try {
    apply(await completeAuth(props.system, current.flowId))
    emit('authorized', props.system)
    emit('close')
  } catch (error) {
    failure.value = error instanceof Error ? error.message : '授权完成失败'
    reportError(error, '授权完成失败')
  } finally {
    submitting.value = false
  }
}

onMounted(() => {
  void begin()
})
onBeforeUnmount(() => {
  disposed = true
  clearTimer()
})
</script>

<template>
  <ModalShell
    :title="`${meta.label} 账号授权`"
    :subtitle="
      accountLabel
        ? `为「${accountLabel}」重新完成 ${meta.label} 授权流程。`
        : `授权流程由 ${meta.service} 提供，凭据只保存在该系统自身的数据目录。`
    "
    @close="emit('close')"
  >
    <div class="modal-body" :data-testid="`auth-dialog-${system}`">
      <p class="form-section-title"><SystemBadge :system="system" /> {{ meta.label }} 授权</p>
      <p v-if="starting" class="inline-hint">
        <LoaderCircle :size="15" class="spin" /><span>正在向 {{ meta.service }} 发起授权流程…</span>
      </p>
      <p v-if="failure" class="form-error" role="alert" data-testid="auth-error">{{ failure }}</p>

      <ol v-if="steps.length" class="auth-steps">
        <li v-for="(step, index) in steps" :key="index">
          <span class="step-label">
            <b>{{ index + 1 }}</b>
            <strong>{{ step.title ?? '步骤' }}</strong>
          </span>
          <p v-if="step.message">{{ step.message }}</p>
          <p v-if="step.url">
            <a class="text-link" :href="step.url" target="_blank" rel="noopener noreferrer">
              {{ step.urlLabel ?? '打开授权页面' }}<ArrowUpRight :size="13" />
            </a>
          </p>
        </li>
      </ol>
      <p v-else-if="flow?.message" class="inline-hint">
        <ShieldCheck :size="15" /><span>{{ flow.message }}</span>
      </p>
      <p v-if="flow?.url && !steps.length" class="inline-hint">
        <a class="text-link" :href="flow.url" target="_blank" rel="noopener noreferrer">
          打开授权页面<ArrowUpRight :size="13" />
        </a>
      </p>

      <form v-if="inputs.length" class="auth-inputs" @submit.prevent="submit">
        <label v-for="input in inputs" :key="input.name">
          {{ input.label }}<span v-if="input.required" class="required">*</span>
          <input
            v-model="values[input.name]"
            :type="input.secret ? 'password' : 'text'"
            :placeholder="input.placeholder ?? ''"
            :name="input.name"
            :data-testid="`auth-input-${input.name}`"
          />
        </label>
        <div class="button-group">
          <button type="submit" class="button primary" :disabled="submitting">
            <LoaderCircle v-if="submitting" :size="15" class="spin" /><span>提交并继续</span>
          </button>
        </div>
      </form>

      <p v-if="!flowFinished(status) && flow" class="inline-hint" data-testid="auth-pending">
        <LoaderCircle :size="15" class="spin" /><span>正在等待 {{ meta.service }} 完成授权…</span>
      </p>
      <div v-if="flow" class="auth-meta">
        <span class="cell-secondary"
          >流程 ID：<code>{{ flow.flowId }}</code></span
        >
        <button class="text-link" type="button" @click="copy(flow.flowId)">复制</button>
      </div>
      <p v-if="flow?.error && status !== 'failed'" class="form-error" role="alert">
        <CircleAlert :size="14" />{{ flow.error }}
      </p>
    </div>
    <footer class="modal-footer">
      <span class="subtle">授权结果保存在 {{ meta.service }}，面板不保存上游凭据。</span>
      <div class="button-group">
        <button class="button" @click="emit('close')">关闭</button>
        <button
          v-if="status === 'success'"
          class="button primary"
          :disabled="submitting"
          @click="finish"
        >
          完成
        </button>
      </div>
    </footer>
  </ModalShell>
</template>

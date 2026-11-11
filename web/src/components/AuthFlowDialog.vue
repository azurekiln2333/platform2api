<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import { ArrowUpRight, CircleAlert, LoaderCircle, ShieldCheck } from '@lucide/vue'
import ModalShell from './ModalShell.vue'
import SystemBadge from './SystemBadge.vue'
import { api } from '../api.ts'
import { authPollMs, flowFinished, reportError } from '../panel.ts'
import { channelLabel, useUnsavedChanges } from '../console.ts'
import CopyButton from './CopyButton.vue'
import type { AuthFlow, AuthFlowInput, SystemId } from '../types.ts'

const props = defineProps<{
  system: SystemId
  accountId?: string
  accountLabel?: string
  startValues?: Record<string, string>
  redeem?: boolean
}>()
const emit = defineEmits<{ close: []; authorized: [system: SystemId] }>()

const label = computed(() => channelLabel(props.system))
const flow = ref<AuthFlow | null>(null)
const starting = ref(true)
const submitting = ref(false)
const failure = ref('')
const values = ref<Record<string, string>>({})
const visibleSecrets = ref<Record<string, boolean>>({})
const form = ref<HTMLFormElement>()
const callback = ref('')
const dirty = computed(() => Object.values(values.value).some(Boolean) || Boolean(callback.value))
useUnsavedChanges(dirty)
function close() {
  if (!submitting.value && (!dirty.value || window.confirm('放弃未提交的授权信息？'))) emit('close')
}
let timer: number | undefined
let disposed = false

const inputs = computed<AuthFlowInput[]>(() => flow.value?.inputs ?? [])
const steps = computed(() => flow.value?.steps ?? [])
const status = computed(() => flow.value?.status ?? 'pending')
async function readFlow(step: 'start' | 'poll' | 'complete', payload: Record<string, unknown>) {
  const response = await api<Record<string, unknown>>(
    `/accounts/auth/${encodeURIComponent(props.system)}/${step}`,
    'POST',
    payload,
  )
  const body =
    response.result && typeof response.result === 'object'
      ? (response.result as Record<string, unknown>)
      : response
  const rawStatus = String(body.status || 'pending')
  const normalized: AuthFlow = {
    ...(body as unknown as AuthFlow),
    flowId: String(body.flowId || response.flowId || flow.value?.flowId || ''),
    system: props.system,
    status: ['done', 'ready', 'success'].includes(rawStatus)
      ? 'success'
      : ['failed', 'error'].includes(rawStatus)
        ? 'failed'
        : rawStatus === 'expired'
          ? 'expired'
          : 'pending',
    url:
      typeof body.url === 'string'
        ? body.url
        : typeof body.verificationUri === 'string'
          ? body.verificationUri
          : undefined,
    message:
      typeof body.message === 'string'
        ? body.message
        : typeof body.detail === 'string'
          ? body.detail
          : undefined,
  }
  return normalized
}

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
    values.value = {}
    clearTimer()
    emit('authorized', props.system)
    return
  }
  if (flowFinished(next.status)) {
    clearTimer()
    return
  }
  schedule(next)
  void nextTick(() => form.value?.querySelector<HTMLInputElement>('input')?.focus())
}

function schedule(next: AuthFlow) {
  clearTimer()
  if ((next.inputs ?? []).length) return
  const delay = authPollMs(next)
  timer = window.setTimeout(() => void poll(next.flowId), delay)
}

async function poll(flowId: string) {
  try {
    apply(await readFlow('poll', { flowId }))
  } catch (error) {
    failure.value = error instanceof Error ? error.message : '授权状态查询失败'
    if (flow.value && !disposed) schedule(flow.value)
  }
}

async function begin() {
  starting.value = true
  failure.value = ''
  try {
    apply(
      await readFlow('start', {
        ...props.startValues,
        ...(props.accountId ? { accountId: props.accountId } : {}),
      }),
    )
  } catch (error) {
    failure.value = error instanceof Error ? error.message : '无法发起授权'
    reportError(error, '无法发起授权')
  } finally {
    starting.value = false
  }
}
async function redeemCallback() {
  if (!flow.value || !callback.value.trim() || submitting.value) return
  submitting.value = true
  failure.value = ''
  clearTimer()
  try {
    apply(
      await readFlow('complete', {
        flowId: flow.value.flowId,
        values: { url: callback.value.trim() },
      }),
    )
    callback.value = ''
  } catch (cause) {
    failure.value = cause instanceof Error ? cause.message : '提交授权回调失败'
    if (flow.value) schedule(flow.value)
  } finally {
    submitting.value = false
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
    apply(await readFlow('poll', { flowId: current.flowId, values: values.value }))
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
    // A successful poll already confirms enrollment; redeeming again may fail on single-use codes.
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
    :title="`${label} 账号授权`"
    :subtitle="
      accountLabel
        ? `为「${accountLabel}」重新完成授权流程。`
        : '完成渠道授权后，账号会加入当前列表。'
    "
    :busy="submitting || starting"
    @close="close"
  >
    <div class="modal-body" :data-testid="`auth-dialog-${system}`">
      <p class="form-section-title"><SystemBadge :system="system" /> {{ label }} 授权</p>
      <p v-if="starting" class="inline-hint">
        <LoaderCircle :size="15" class="spin" /><span>正在发起授权流程…</span>
      </p>
      <p v-if="failure" class="form-error" role="alert" data-testid="auth-error">{{ failure }}</p>
      <button
        v-if="failure && !starting"
        class="button"
        @click="flow && !flowFinished(status) ? poll(flow.flowId) : begin()"
      >
        重试授权
      </button>

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

      <form v-if="inputs.length" ref="form" class="auth-inputs" @submit.prevent="submit">
        <label v-for="input in inputs" :key="input.name">
          {{ input.label }}<span v-if="input.required" class="required">*</span>
          <input
            v-model="values[input.name]"
            :type="input.secret && !visibleSecrets[input.name] ? 'password' : 'text'"
            :placeholder="input.placeholder ?? ''"
            :name="input.name"
            :data-testid="`auth-input-${input.name}`"
            :required="input.required"
            :disabled="submitting"
            autocomplete="off"
          />
          <button
            v-if="input.secret"
            type="button"
            class="text-link"
            :aria-label="`${visibleSecrets[input.name] ? '隐藏' : '显示'}${input.label}`"
            @click="visibleSecrets[input.name] = !visibleSecrets[input.name]"
          >
            {{ visibleSecrets[input.name] ? '隐藏' : '显示' }}
          </button>
        </label>
        <div class="button-group">
          <button type="submit" class="button primary" :disabled="submitting">
            <LoaderCircle v-if="submitting" :size="15" class="spin" /><span>提交并继续</span>
          </button>
        </div>
      </form>
      <form
        v-if="props.redeem && flow && !flowFinished(status)"
        class="auth-inputs"
        @submit.prevent="redeemCallback"
      >
        <label
          >粘贴授权回调地址<input
            v-model="callback"
            :type="visibleSecrets.callback ? 'text' : 'password'"
            :disabled="submitting"
            autocomplete="off" /></label
        ><button
          type="button"
          class="text-link"
          @click="visibleSecrets.callback = !visibleSecrets.callback"
        >
          {{ visibleSecrets.callback ? '隐藏' : '显示' }}回调地址</button
        ><button class="button" type="submit" :disabled="submitting || !callback.trim()">
          提交授权回调
        </button>
      </form>

      <p v-if="!flowFinished(status) && flow" class="inline-hint" data-testid="auth-pending">
        <LoaderCircle :size="15" class="spin" /><span>正在等待 {{ label }} 完成授权…</span>
      </p>
      <div v-if="flow" class="auth-meta">
        <span class="cell-secondary"
          >流程 ID：<code>{{ flow.flowId }}</code></span
        >
        <CopyButton :value="flow.flowId" />
      </div>
      <p v-if="flow?.error && status !== 'failed'" class="form-error" role="alert">
        <CircleAlert :size="14" />{{ flow.error }}
      </p>
    </div>
    <footer class="modal-footer">
      <span />
      <div class="button-group">
        <button class="button" :disabled="submitting || starting" @click="close">关闭</button>
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

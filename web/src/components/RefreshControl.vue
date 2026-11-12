<script setup lang="ts">
/**
 * Refresh frequency control (ui-fixes.md F13).
 *
 * Contract: `v-model` holds the interval in seconds (0 = off), `@tick` asks the
 * page to reload, `storage-key` remembers the choice. The page reports the
 * outcome back through `markUpdated()` / `markFailed()` so this component owns
 * the "更新于 N 秒前" text, pausing while hidden, the single-flight guard and
 * the failure backoff without knowing anything about the page data.
 */
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'

const props = defineProps<{ modelValue: number; storageKey?: string }>()
const emit = defineEmits<{ 'update:modelValue': [value: number]; tick: [] }>()

const OPTIONS = [
  { value: 0, label: '关闭' },
  { value: 5, label: '5 秒' },
  { value: 10, label: '10 秒' },
  { value: 30, label: '30 秒' },
  { value: 60, label: '60 秒' },
]
/** After a failure the next attempt is delayed, without dropping the old data. */
const BACKOFF_SECONDS = 30
/** A page that never reports back must not freeze the loop forever. */
const WATCHDOG_MS = 25000

const failures = ref(0)
const pending = ref(false)
const lastUpdatedAt = ref<number | null>(null)
const now = ref(Date.now())
let pendingSince = 0
let timer: number | undefined
let ticker: number | undefined

const key = () => props.storageKey || 'console-refresh-rate'
const isHidden = () => typeof document !== 'undefined' && document.hidden
const effectiveSeconds = computed(() => {
  if (!props.modelValue) return 0
  return failures.value > 0 ? Math.max(BACKOFF_SECONDS, props.modelValue) : props.modelValue
})

function clearTimer() {
  if (timer !== undefined) {
    window.clearTimeout(timer)
    timer = undefined
  }
}
function schedule() {
  clearTimer()
  if (!effectiveSeconds.value || isHidden()) return
  timer = window.setTimeout(fire, effectiveSeconds.value * 1000)
}
function fire() {
  clearTimer()
  if (!effectiveSeconds.value || isHidden()) return
  if (pending.value) {
    schedule()
    return
  }
  pending.value = true
  pendingSince = Date.now()
  emit('tick')
}
/** The page loaded successfully: reset the backoff and refresh the timestamp. */
function markUpdated() {
  pending.value = false
  failures.value = 0
  lastUpdatedAt.value = Date.now()
  now.value = lastUpdatedAt.value
  schedule()
}
/** The page failed: keep its old data and wait longer before the next try. */
function markFailed() {
  pending.value = false
  failures.value += 1
  now.value = Date.now()
  schedule()
}
function onVisibility() {
  if (isHidden()) {
    clearTimer()
    return
  }
  // Coming back to the tab refreshes right away instead of waiting a full interval.
  if (pending.value) schedule()
  else fire()
}
function update(value: unknown) {
  const next = Number(value)
  emit('update:modelValue', Number.isFinite(next) ? next : 0)
}

const statusText = computed(() => {
  if (pending.value) return '更新中…'
  if (!lastUpdatedAt.value) return '尚未更新'
  const seconds = Math.max(0, Math.round((now.value - lastUpdatedAt.value) / 1000))
  if (seconds < 60) return `更新于 ${seconds} 秒前`
  return `更新于 ${Math.floor(seconds / 60)} 分钟前`
})
const failureHint = computed(() =>
  failures.value ? `连续失败 ${failures.value} 次，${effectiveSeconds.value} 秒后重试` : '',
)

function storedSeconds() {
  try {
    const raw = window.localStorage.getItem(key())
    if (raw === null) return null
    const value = Number(raw)
    return OPTIONS.some((option) => option.value === value) ? value : null
  } catch {
    return null
  }
}
function remember(value: number) {
  try {
    window.localStorage.setItem(key(), String(value))
  } catch {
    /* Storage can be unavailable (private mode); the control still works. */
  }
}

watch(
  () => props.modelValue,
  (value) => {
    remember(value)
    schedule()
  },
)
onMounted(() => {
  const stored = storedSeconds()
  if (stored !== null && stored !== props.modelValue) emit('update:modelValue', stored)
  else remember(props.modelValue)
  ticker = window.setInterval(() => {
    now.value = Date.now()
    if (pending.value && now.value - pendingSince > WATCHDOG_MS) markFailed()
  }, 1000)
  document.addEventListener('visibilitychange', onVisibility)
  schedule()
})
onBeforeUnmount(() => {
  clearTimer()
  if (ticker !== undefined) window.clearInterval(ticker)
  document.removeEventListener('visibilitychange', onVisibility)
})
defineExpose({ markUpdated, markFailed })
</script>
<template>
  <div class="refresh-control">
    <select
      class="refresh-rate"
      aria-label="刷新频率"
      :value="modelValue"
      @change="update(($event.target as HTMLSelectElement).value)"
    >
      <option v-for="option in OPTIONS" :key="option.value" :value="option.value">
        {{ option.label === '关闭' ? '关闭' : `每 ${option.label}` }}
      </option>
    </select>
    <span
      class="refresh-status"
      :class="{ warn: failures > 0 }"
      :title="failureHint"
      role="status"
      data-testid="refresh-status"
    >
      {{ statusText }}
    </span>
  </div>
</template>
<style scoped>
.refresh-control {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.refresh-rate {
  padding: 7px 10px;
  font-size: 13px;
  color: var(--secondary);
}
.refresh-status {
  font-size: 12px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
}
.refresh-status.warn {
  color: var(--amber);
}
</style>

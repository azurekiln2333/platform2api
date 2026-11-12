<script setup lang="ts">
import { computed } from 'vue'
import type { Quota } from '../console-types.ts'
import { formatNumber, quotaProgress } from '../console.ts'
const props = defineProps<{ quota?: Quota | null }>()
/** The console always shows "remaining / total"; the bar length is that share. */
const progress = computed(() => quotaProgress(props.quota))
const unit = computed(() => {
  const raw = (props.quota?.unit || '').trim()
  return raw ? ` ${raw}` : ''
})
const text = computed(() => {
  const { remaining, total } = progress.value
  if (remaining === null && total === null) return '额度未知'
  if (total === null) return `剩余 ${formatNumber(remaining)}${unit.value}`
  return `剩余 ${formatNumber(remaining)} / ${formatNumber(total)}${unit.value}`
})
</script>
<template>
  <div
    v-if="quota"
    class="quota-inline"
    :class="`quota-${progress.tone}`"
    :title="`${text}${quota.note ? ` · ${quota.note}` : ''}`"
    :data-tone="progress.tone"
  >
    <span class="quota-remaining">{{ text }}</span>
    <!-- A total is required to draw a bar: an unknown total must not invent one. -->
    <div
      v-if="progress.percent !== null"
      class="quota-meter"
      role="progressbar"
      :aria-label="`剩余额度 ${Math.round(progress.percent)}%`"
      :aria-valuenow="Math.round(progress.percent)"
      aria-valuemin="0"
      aria-valuemax="100"
    >
      <i :style="{ width: `${progress.percent}%` }" />
    </div>
  </div>
  <span v-else>—</span>
</template>

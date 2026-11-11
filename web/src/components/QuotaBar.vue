<script setup lang="ts">
import { computed } from 'vue'
import type { Quota } from '../console-types.ts'
import { formatNumber } from '../console.ts'
const props = defineProps<{ quota?: Quota | null }>()
const percent = computed(() =>
  Math.min(
    100,
    Math.max(
      0,
      props.quota?.percent ??
        (props.quota?.total ? ((props.quota.used ?? 0) / props.quota.total) * 100 : 0),
    ),
  ),
)
</script>
<template>
  <div
    v-if="quota"
    class="quota-inline"
    :title="`${quota.used ?? '—'} / ${quota.total ?? '—'} ${quota.unit || ''}`"
  >
    <span>{{ formatNumber(quota.used) }} / {{ formatNumber(quota.total) }} {{ quota.unit }}</span
    ><progress
      v-if="quota.total || quota.percent != null"
      :value="percent"
      max="100"
      aria-label="已用额度"
    /><small v-if="quota.remaining != null" class="cell-secondary"
      >剩余 {{ formatNumber(quota.remaining) }} {{ quota.unit }}</small
    >
  </div>
  <span v-else>—</span>
</template>

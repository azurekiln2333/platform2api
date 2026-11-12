<script lang="ts">
export interface ChartPart {
  key: string
  label: string
  color?: string
}
</script>
<script setup lang="ts">
import { computed } from 'vue'
import { channels, formatNumber } from '../console.ts'
const props = defineProps<{
  rows: { label: string; values: Record<string, number> }[]
  label: string
  /** Defaults to the channel list; overview sections pass their own series. */
  parts?: ChartPart[]
  unit?: string
}>()
const series = computed<ChartPart[]>(() =>
  props.parts?.length
    ? props.parts
    : channels.value.map((channel) => ({
        key: channel.system,
        label: channel.label,
        color: channel.color,
      })),
)
const peak = computed(() =>
  Math.max(1, ...props.rows.map((row) => Object.values(row.values).reduce((a, b) => a + b, 0))),
)
</script>
<template>
  <div class="chart-legend">
    <span v-for="part in series" :key="part.key"
      ><i :style="{ background: part.color || 'var(--muted)' }" />{{ part.label }}</span
    >
  </div>
  <div v-if="rows.length" class="stacked-chart" role="img" :aria-label="label">
    <div v-for="row in rows" :key="row.label" class="chart-column">
      <div class="chart-stack">
        <div
          v-for="part in series"
          :key="part.key"
          class="chart-part"
          :style="{
            height: `${((row.values[part.key] || 0) / peak) * 100}%`,
            background: part.color || 'var(--muted)',
          }"
          :title="`${row.label} · ${part.label}：${formatNumber(row.values[part.key] || 0)}${unit ? ` ${unit}` : ''}`"
        />
      </div>
      <small>{{ row.label }}</small>
    </div>
  </div>
  <p v-else class="empty-state">暂无统计数据</p>
</template>

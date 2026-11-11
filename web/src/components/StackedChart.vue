<script setup lang="ts">
import { computed } from 'vue'
import { channels, channelLabel, formatNumber } from '../console.ts'
const props = defineProps<{
  rows: { label: string; values: Record<string, number> }[]
  label: string
}>()
const peak = computed(() =>
  Math.max(1, ...props.rows.map((row) => Object.values(row.values).reduce((a, b) => a + b, 0))),
)
</script>
<template>
  <div class="chart-legend">
    <span v-for="channel in channels" :key="channel.system"
      ><i :style="{ background: channel.color }" />{{ channel.label }}</span
    >
  </div>
  <div v-if="rows.length" class="stacked-chart" role="img" :aria-label="label">
    <div v-for="row in rows" :key="row.label" class="chart-column">
      <div class="chart-stack">
        <div
          v-for="channel in channels"
          :key="channel.system"
          class="chart-part"
          :style="{
            height: `${((row.values[channel.system] || 0) / peak) * 100}%`,
            background: channel.color,
          }"
          :title="`${row.label} · ${channelLabel(channel.system)}：${formatNumber(row.values[channel.system] || 0)}`"
        />
      </div>
      <small>{{ row.label }}</small>
    </div>
  </div>
  <p v-else class="empty-state">暂无统计数据</p>
</template>

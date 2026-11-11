<script setup lang="ts">
import type { Channel } from '../console-types.ts'
defineProps<{
  channels: Channel[]
  modelValue: string
  counts?: Record<string, number>
  total?: number
}>()
const emit = defineEmits<{ 'update:modelValue': [value: string] }>()
</script>
<template>
  <div class="channel-filter" role="group" aria-label="筛选渠道">
    <button
      type="button"
      :class="{ active: !modelValue || modelValue === 'all' }"
      :aria-pressed="!modelValue || modelValue === 'all'"
      data-testid="filter-all"
      @click="emit('update:modelValue', '')"
    >
      全部
      <small>{{
        total ?? (counts ? Object.values(counts).reduce((a, b) => a + b, 0) : '—')
      }}</small>
    </button>
    <button
      v-for="channel in channels"
      :key="channel.system"
      type="button"
      :class="{ active: modelValue === channel.system }"
      :aria-pressed="modelValue === channel.system"
      :data-testid="`filter-${channel.system}`"
      @click="emit('update:modelValue', channel.system)"
    >
      {{ channel.label }} <small>{{ counts?.[channel.system] ?? '—' }}</small>
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { channels } from '../console.ts'
const props = defineProps<{ system: string; compact?: boolean; label?: string }>()
const meta = computed(() => channels.value.find((item) => item.system === props.system))
</script>
<template>
  <span
    class="system-badge"
    :class="[`system-${system}`, { compact }]"
    :style="{
      color: meta?.color || 'var(--secondary)',
      borderColor: meta?.color || 'var(--line-strong)',
    }"
    :title="label || meta?.label || system"
    :data-system="system"
    >{{ label || meta?.label || system }}</span
  >
</template>

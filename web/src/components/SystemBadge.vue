<script setup lang="ts">
import { computed } from 'vue'
import { systemMeta } from '../systems.ts'
import type { SystemId } from '../types.ts'

const props = withDefaults(defineProps<{ system: SystemId; compact?: boolean }>(), {
  compact: false,
})
const meta = computed(() => systemMeta(props.system))
</script>

<template>
  <span
    class="system-badge"
    :class="[`system-${system}`, { compact }]"
    :title="`${meta.label}（${meta.service}）`"
    :data-system="system"
    >{{ meta.badge }}</span
  >
</template>

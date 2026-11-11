<script setup lang="ts">
import { absoluteTime, relativeTime } from '../console.ts'
defineProps<{ value?: string | number | null }>()
</script>
<template>
  <time :title="absoluteTime(value)">{{ relativeTime(value) }}</time>
</template>

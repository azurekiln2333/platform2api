<script setup lang="ts">
import { ref } from 'vue'
import { copy } from '../panel.ts'
const props = defineProps<{ value: string; label?: string }>()
const copied = ref(false)
async function run() {
  const ok = await copy(props.value)
  copied.value = ok
  window.setTimeout(() => {
    copied.value = false
  }, 1800)
}
</script>
<template>
  <button
    type="button"
    class="text-link copy-button"
    :aria-label="label || '复制'"
    @click.stop="run"
  >
    {{ copied ? '已复制' : '复制' }}
  </button>
</template>

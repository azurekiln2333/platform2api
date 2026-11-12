<script setup lang="ts">
import { onBeforeUnmount, ref } from 'vue'
import { copy } from '../../panel.ts'

/**
 * Inline "click the text to copy" value (F10): no extra copy button next to the
 * value, the value itself is the target and briefly shows「已复制」in place.
 */
const props = defineProps<{ value: string; label?: string; mono?: boolean; title?: string }>()
const copied = ref(false)
let timer = 0

async function run() {
  const ok = await copy(props.value)
  if (!ok) return
  copied.value = true
  window.clearTimeout(timer)
  timer = window.setTimeout(() => {
    copied.value = false
  }, 1600)
}

onBeforeUnmount(() => window.clearTimeout(timer))
</script>
<template>
  <button
    type="button"
    class="copyable-value"
    :class="{ copied, mono }"
    :title="copied ? '已复制' : props.title || '点击复制'"
    :aria-label="`复制${label || value}`"
    @click.stop="run"
  >
    <span class="copyable-text">{{ copied ? '已复制' : value }}</span>
  </button>
</template>
<style scoped>
.copyable-value {
  display: inline-block;
  max-width: 100%;
  min-width: 0;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: copy;
  border-radius: 3px;
}
.copyable-value:hover {
  background: var(--primary-soft);
  color: var(--primary);
}
.copyable-value:focus-visible {
  outline: 2px solid var(--primary);
  outline-offset: 1px;
}
.copyable-text {
  display: block;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.copyable-value.copied {
  color: var(--green);
  cursor: default;
}
</style>

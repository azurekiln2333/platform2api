<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, useId, nextTick } from 'vue'
import { X } from '@lucide/vue'
const props = defineProps<{
  title: string
  subtitle?: string
  wide?: boolean
  drawer?: boolean
  busy?: boolean
  preventClose?: boolean
}>()
const emit = defineEmits<{ close: [] }>()
const dialog = ref<HTMLDialogElement>(),
  titleId = useId()
let previous: HTMLElement | null = null
function close() {
  if (!props.busy && !props.preventClose) emit('close')
}
onMounted(async () => {
  previous = document.activeElement as HTMLElement
  dialog.value?.showModal()
  await nextTick()
  dialog.value
    ?.querySelector<HTMLElement>(
      'input:not([type=hidden]):not([disabled]),textarea:not([disabled]),select:not([disabled]),[autofocus]',
    )
    ?.focus()
})
onBeforeUnmount(() => {
  dialog.value?.close()
  previous?.focus()
})
</script>
<template>
  <dialog
    ref="dialog"
    class="modal"
    :class="{ wide, drawer }"
    :aria-labelledby="titleId"
    :aria-busy="busy"
    @cancel.prevent="close"
    @click="
      (event) => {
        if (event.target === dialog) close()
      }
    "
  >
    <div class="modal-content">
      <header class="modal-header">
        <div>
          <h2 :id="titleId">{{ title }}</h2>
          <p v-if="subtitle">{{ subtitle }}</p>
        </div>
        <button
          v-if="!preventClose"
          type="button"
          class="icon-button"
          aria-label="关闭弹窗"
          :disabled="busy"
          @click="close"
        >
          <X :size="19" />
        </button>
      </header>
      <slot />
    </div>
  </dialog>
</template>

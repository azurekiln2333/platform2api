<script setup lang="ts">
import { ref } from 'vue'
import ModalShell from './ModalShell.vue'
import { errorText } from '../console.ts'
const props = defineProps<{
  title: string
  description?: string
  action: () => Promise<unknown>
  verb?: string
  danger?: boolean
}>()
const emit = defineEmits<{ close: []; done: [] }>()
const busy = ref(false),
  error = ref('')
async function run() {
  if (busy.value) return
  busy.value = true
  error.value = ''
  try {
    await props.action()
    emit('done')
    emit('close')
  } catch (e) {
    error.value = errorText(e)
  } finally {
    busy.value = false
  }
}
</script>
<template>
  <ModalShell :title="title" :busy="busy" @close="emit('close')"
    ><form @submit.prevent="run">
      <div class="modal-body">
        <p>{{ description || '此操作将立即生效。' }}</p>
        <p v-if="error" class="form-error" role="alert">{{ error }}</p>
      </div>
      <footer class="modal-footer">
        <button type="button" class="button" :disabled="busy" @click="emit('close')">取消</button
        ><button
          type="submit"
          class="button"
          :class="danger === false ? 'primary' : 'danger'"
          :disabled="busy"
        >
          {{ busy ? '处理中…' : verb || '删除' }}
        </button>
      </footer>
    </form></ModalShell
  >
</template>

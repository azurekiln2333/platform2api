<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { api, consoleApi } from '../../api.ts'
import { errorText, useUnsavedChanges } from '../../console.ts'
import { notify } from '../../panel.ts'
import SystemBadge from '../SystemBadge.vue'
import CopyButton from '../CopyButton.vue'
const props = defineProps<{
  service: { system: string; url: string; health?: string; detail?: string }
}>()
const url = ref(props.service.url),
  saved = ref(props.service.url),
  busy = ref(false),
  error = ref(''),
  status = ref(props.service.detail || props.service.health || '尚未测试')
const dirty = computed(() => url.value !== saved.value)
useUnsavedChanges(dirty)
watch(
  () => props.service,
  (service) => {
    if (dirty.value || busy.value) return
    url.value = saved.value = service.url
    status.value = service.detail || service.health || '尚未测试'
  },
)
async function save() {
  busy.value = true
  error.value = ''
  try {
    await consoleApi.saveServices({ [props.service.system]: url.value })
    saved.value = url.value
    status.value = '已保存，待测试'
    notify('服务连接已保存')
  } catch (e) {
    error.value = errorText(e)
  } finally {
    busy.value = false
  }
}
async function test() {
  busy.value = true
  error.value = ''
  try {
    const result = await api<{ status?: string; detail?: string }>(
      `/channels/${encodeURIComponent(props.service.system)}/test`,
      'POST',
      {},
    )
    status.value =
      result.detail ||
      (result.status === 'ok'
        ? '连接正常'
        : result.status === 'degraded'
          ? '连接降级'
          : '连接不可用')
  } catch (e) {
    error.value = errorText(e)
  } finally {
    busy.value = false
  }
}
</script>
<template>
  <form class="service-row" :data-testid="`setting-${service.system}`" @submit.prevent="save">
    <SystemBadge :system="service.system" /><label
      >服务地址<input v-model="url" type="url" required :disabled="busy" /></label
    ><CopyButton :value="url" label="复制服务地址" /><span class="cell-secondary">{{ status }}</span
    ><button class="button primary" type="submit" :disabled="busy || !dirty">
      {{ busy ? '处理中…' : '保存' }}</button
    ><button
      class="button"
      type="button"
      :disabled="busy || dirty"
      :title="dirty ? '先保存新地址，再测试连接' : ''"
      @click="test"
    >
      测试连接
    </button>
    <p v-if="error" class="form-error" role="alert">{{ error }}</p>
  </form>
</template>

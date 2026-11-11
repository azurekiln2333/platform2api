<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { api } from '../../api.ts'
import { errorText, channelLabel } from '../../console.ts'
import { redact } from '../../redact.ts'
import { notify } from '../../panel.ts'
import ConfirmAction from '../../components/ConfirmAction.vue'
const props = defineProps<{ system: string; embed?: string }>()
const sections = [
  { id: 'media', label: '媒体', paths: ['/admin/media'] },
  { id: 'storage', label: '存储与备份', paths: ['/admin/storage'] },
  { id: 'updates', label: '版本更新', paths: ['/admin/update'] },
  { id: 'automation', label: '自动化', paths: ['/admin/performance', '/admin/growth-jobs'] },
]
const tab = ref('media'),
  data = ref<unknown>(null),
  busy = ref(false),
  error = ref('')
const current = computed(() => sections.find((item) => item.id === tab.value)!)
function selectTab(id: string) {
  tab.value = id
  void load()
}
const request = <T,>(path: string, method = 'GET') =>
  api<T>(`/p/${props.system}${path}`, method, method === 'POST' ? {} : undefined)
async function load() {
  busy.value = true
  error.value = ''
  try {
    const results = await Promise.allSettled(current.value.paths.map((path) => request(path)))
    data.value = results.map((r, index) => ({
      类别: current.value.paths.length > 1 ? index + 1 : current.value.label,
      结果: r.status === 'fulfilled' ? redact(r.value) : errorText(r.reason),
    }))
  } catch (e) {
    error.value = errorText(e)
  } finally {
    busy.value = false
  }
}
const confirmation = ref<{ title: string; verb: string; action: () => Promise<unknown> } | null>(
  null,
)
function act(path: string, label: string) {
  confirmation.value = {
    title: `${label}（${channelLabel(props.system)}）`,
    verb: label,
    action: async () => {
      await request(path, 'POST')
      notify(`${label}已完成`)
      await load()
    },
  }
}
onMounted(() => void load())
</script>
<template>
  <section class="console-panel">
    <h3>渠道运维</h3>
    <div class="console-tabs">
      <button
        v-for="section in sections"
        :key="section.id"
        :class="{ active: tab === section.id }"
        :disabled="busy"
        @click="selectTab(section.id)"
      >
        {{ section.label }}
      </button>
    </div>
    <div class="row-actions">
      <button class="button" :disabled="busy" @click="load">{{ busy ? '读取中…' : '刷新' }}</button
      ><template v-if="tab === 'storage'"
        ><button class="button" @click="act('/admin/storage/backups', '立即备份')">立即备份</button
        ><button class="button" @click="act('/admin/storage/archive', '归档存储')">
          归档存储
        </button></template
      ><button
        v-if="tab === 'updates'"
        class="button"
        @click="act('/admin/update/check', '检查更新')"
      >
        检查更新
      </button>
    </div>
    <p v-if="error" class="form-error" role="alert">{{ error }}</p>
    <pre v-if="data" class="console-json">{{ JSON.stringify(data, null, 2) }}</pre>
    <ConfirmAction v-if="confirmation" v-bind="confirmation" @close="confirmation = null" />
  </section>
</template>

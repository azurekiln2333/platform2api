<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { HardDrive, Images, LoaderCircle, RefreshCw, Upload } from '@lucide/vue'
import { notify, reportError } from '../../panel.ts'
import { codebuddy } from './service.ts'

/**
 * Provider-specific operational surfaces. Media, storage/backups, updates and
 * automation stay owned by the CodeBuddy service: the panel only calls the real
 * `/admin/*` routes and never touches the service's data files.
 */
const TABS = [
  { key: 'media', label: '媒体', paths: ['/admin/media'] },
  { key: 'storage', label: '存储与备份', paths: ['/admin/storage'] },
  { key: 'updates', label: '版本更新', paths: ['/admin/update'] },
  { key: 'automation', label: '自动化', paths: ['/admin/performance', '/admin/growth-jobs'] },
] as const

const tab = ref<(typeof TABS)[number]['key']>('media')
const payload = ref<unknown>(null)
const loading = ref(false)
const busy = ref('')
const error = ref('')
let active = false

const current = computed(() => TABS.find((entry) => entry.key === tab.value)!)
const sources = computed<string[]>(() => [...current.value.paths])

const TEXT = computed(() =>
  payload.value === null || payload.value === undefined
    ? ''
    : JSON.stringify(payload.value, null, 2),
)

async function load() {
  if (loading.value) return
  loading.value = true
  try {
    const results = await Promise.all(sources.value.map(async (path) => codebuddy<unknown>(path)))
    if (!active) return
    payload.value =
      results.length === 1
        ? results[0]
        : Object.fromEntries(sources.value.map((path, index) => [path, results[index]]))
    error.value = ''
  } catch (cause) {
    if (!active) return
    payload.value = null
    error.value = cause instanceof Error ? cause.message : '该运维接口暂不可用'
  } finally {
    if (active) loading.value = false
  }
}

async function act(path: string, label: string) {
  if (!confirm(`确认执行「${label}」？该操作由 CodeBuddy 服务执行。`)) return
  busy.value = path
  try {
    await codebuddy(path, 'POST', {})
    await load()
    notify(`已触发${label}`)
  } catch (cause) {
    reportError(cause, `执行${label}失败`)
  } finally {
    busy.value = ''
  }
}

function select(next: (typeof TABS)[number]['key']) {
  tab.value = next
  payload.value = null
  void load()
}

onMounted(() => {
  active = true
  void load()
})
</script>

<template>
  <section>
    <header class="page-heading">
      <div>
        <span class="eyebrow"><i class="blue-line" /> CODEBUDDY OPS</span>
        <h1>CodeBuddy 运维</h1>
        <p>
          媒体、存储、更新与自动化由 CodeBuddy
          服务执行；面板只触发服务既有接口，不直接改写其数据目录。
        </p>
      </div>
      <div class="heading-actions">
        <button class="button" :disabled="loading" @click="load">
          <RefreshCw :size="15" :class="{ spin: loading }" /><span>刷新数据</span>
        </button>
      </div>
    </header>

    <div class="segmented">
      <button
        v-for="entry in TABS"
        :key="entry.key"
        :class="{ active: tab === entry.key }"
        @click="select(entry.key)"
      >
        {{ entry.label }}
      </button>
    </div>

    <div class="heading-actions ops-actions">
      <button
        v-if="tab === 'storage'"
        class="button"
        :disabled="busy === '/admin/storage/backups'"
        @click="act('/admin/storage/backups', '立即备份')"
      >
        <HardDrive :size="15" /><span>立即备份</span>
      </button>
      <button
        v-if="tab === 'storage'"
        class="button"
        :disabled="busy === '/admin/storage/archive'"
        @click="act('/admin/storage/archive', '归档审计存储')"
      >
        <Images :size="15" /><span>归档存储</span>
      </button>
      <button
        v-if="tab === 'updates'"
        class="button"
        :disabled="busy === '/admin/update/check'"
        @click="act('/admin/update/check', '检查更新')"
      >
        <Upload :size="15" /><span>检查更新</span>
      </button>
    </div>

    <div v-if="error" class="error-banner" role="alert">
      <span>{{ error }}</span
      ><button @click="load">重试读取</button>
    </div>

    <div v-if="loading" class="page-loading">
      <LoaderCircle :size="20" class="spin" /><span>正在读取运维数据…</span>
    </div>

    <div v-else-if="!TEXT" class="empty-filter">
      <h3>暂无可显示的数据</h3>
      <p>该运维接口在服务端返回了空响应。</p>
    </div>

    <section v-else class="section-panel">
      <pre class="ops-json">{{ TEXT }}</pre>
    </section>
  </section>
</template>

<style scoped>
.ops-actions {
  margin-bottom: 14px;
}
.ops-json {
  margin: 0;
  overflow-x: auto;
  color: var(--secondary);
  font-size: 12px;
  line-height: 1.7;
}
</style>

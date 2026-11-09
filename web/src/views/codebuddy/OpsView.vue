<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { HardDrive, Images, LoaderCircle, RefreshCw, Upload } from '@lucide/vue'
import { notify, reportError } from '../../panel.ts'
import { codebuddy } from './service.ts'

/**
 * Provider-specific operational surfaces. Media, storage/backups, updates and
 * account automation stay owned by the CodeBuddy service: the panel only calls
 * the existing `/admin/*` routes and never touches the service's data files.
 */
const TABS = [
  { key: 'media', label: '媒体' },
  { key: 'storage', label: '存储与备份' },
  { key: 'updates', label: '版本更新' },
  { key: 'automation', label: '自动化' },
] as const

const tab = ref<(typeof TABS)[number]['key']>('media')
const payload = ref<unknown>(null)
const loading = ref(false)
const busy = ref('')
const error = ref('')
let active = false

const TEXT = computed(() =>
  payload.value === null || payload.value === undefined
    ? ''
    : JSON.stringify(payload.value, null, 2),
)

async function load() {
  if (loading.value) return
  loading.value = true
  try {
    const result = await codebuddy<unknown>(`/admin/ops/${tab.value}`)
    if (!active) return
    payload.value = result
    error.value = ''
  } catch (cause) {
    if (!active) return
    payload.value = null
    error.value = cause instanceof Error ? cause.message : '该运维接口暂不可用'
  } finally {
    if (active) loading.value = false
  }
}

async function act(action: string, label: string) {
  if (!confirm(`确认执行「${label}」？该操作由 CodeBuddy 服务执行。`)) return
  busy.value = action
  try {
    await codebuddy(`/admin/ops/${tab.value}/${action}`, 'POST', {})
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
        v-if="tab === 'media'"
        class="button"
        :disabled="busy === 'refresh'"
        @click="act('refresh', '刷新媒体索引')"
      >
        <Images :size="15" /><span>刷新媒体索引</span>
      </button>
      <button
        v-if="tab === 'storage'"
        class="button"
        :disabled="busy === 'backup'"
        @click="act('backup', '立即备份')"
      >
        <HardDrive :size="15" /><span>立即备份</span>
      </button>
      <button
        v-if="tab === 'updates'"
        class="button"
        :disabled="busy === 'check'"
        @click="act('check', '检查更新')"
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

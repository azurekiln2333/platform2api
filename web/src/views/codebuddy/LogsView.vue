<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { FileText, LoaderCircle, RefreshCw } from '@lucide/vue'
import { codebuddy } from './service.ts'

const KINDS = [
  { key: 'request', label: '请求' },
  { key: 'runtime', label: '运行时' },
  { key: 'admin', label: '管理' },
  { key: 'credit', label: '积分' },
] as const

const kind = ref<(typeof KINDS)[number]['key']>('request')
const entries = ref<Record<string, unknown>[]>([])
const cursor = ref<string | null>(null)
const loading = ref(false)
const loaded = ref(false)
const error = ref('')
const detail = ref<Record<string, unknown> | null>(null)
const detailId = ref('')
const detailBusy = ref('')
const detailError = ref('')
let active = false
let generation = 0

const LIMIT = 50

const summary = (entry: Record<string, unknown>) =>
  String(entry.kind ?? entry.type ?? entry.event ?? entry.message ?? '记录')

async function refresh(reset = true) {
  if (loading.value) return
  const request = ++generation
  loading.value = true
  try {
    // Cursor pagination; the service clamps the limit to 1..200.
    const query = new URLSearchParams({ kind: kind.value, limit: String(LIMIT) })
    if (!reset && cursor.value) query.set('cursor', cursor.value)
    const result = await codebuddy<{ items: Record<string, unknown>[]; nextCursor: string | null }>(
      `/admin/logs?${query.toString()}`,
    )
    if (!active || request !== generation) return
    const items = Array.isArray(result.items) ? result.items : []
    entries.value = reset ? items : [...entries.value, ...items]
    cursor.value = result.nextCursor ?? null
    loaded.value = true
    error.value = ''
  } catch (cause) {
    if (active && request === generation)
      error.value = cause instanceof Error ? cause.message : '无法读取 CodeBuddy 日志'
  } finally {
    if (active && request === generation) loading.value = false
  }
}

function select(next: (typeof KINDS)[number]['key']) {
  kind.value = next
  cursor.value = null
  void refresh(true)
}

/**
 * Request detail. A cleaned-up entry stays a 404 and an unavailable audit store
 * stays a 503: neither is rendered as "no detail", which would look like an
 * empty record.
 */
async function open(entry: Record<string, unknown>) {
  const id = String(entry.id ?? '')
  if (!id || detailBusy.value === id) return
  detailBusy.value = id
  try {
    const result = await codebuddy<Record<string, unknown>>(`/admin/logs/${encodeURIComponent(id)}`)
    if (!active) return
    detail.value = result ?? null
    detailId.value = id
    detailError.value = ''
  } catch (cause) {
    if (!active) return
    detail.value = null
    detailId.value = id
    detailError.value =
      cause instanceof Error ? cause.message : '请求明细暂时无法确认，请检查审计存储状态'
  } finally {
    detailBusy.value = ''
  }
}

function closeDetail() {
  detail.value = null
  detailId.value = ''
  detailError.value = ''
}

const hasMore = computed(() => Boolean(cursor.value))

onMounted(() => {
  active = true
  void refresh(true)
})
onBeforeUnmount(() => {
  active = false
  generation++
})
</script>

<template>
  <section>
    <header class="page-heading">
      <div>
        <span class="eyebrow"><i class="blue-line" /> CODEBUDDY LOGS</span>
        <h1>CodeBuddy 日志</h1>
        <p>按服务定义的日志类别读取，使用游标分页；审计存储不可用时会显式报错，不会当作零条。</p>
      </div>
      <div class="heading-actions">
        <button class="button" :disabled="loading" @click="refresh(true)">
          <RefreshCw :size="15" :class="{ spin: loading }" /><span>刷新日志</span>
        </button>
      </div>
    </header>

    <div class="segmented">
      <button
        v-for="item in KINDS"
        :key="item.key"
        :class="{ active: kind === item.key }"
        @click="select(item.key)"
      >
        {{ item.label }}
      </button>
    </div>

    <div v-if="error" class="error-banner" role="alert">
      <span>{{ error }}</span
      ><button @click="refresh(true)">重试读取日志</button>
    </div>

    <div v-if="loading && !loaded" class="page-loading">
      <LoaderCircle :size="20" class="spin" /><span>正在读取日志…</span>
    </div>

    <div v-else-if="!entries.length" class="empty-filter">
      <FileText :size="28" />
      <h3>该类日志暂无记录</h3>
      <p>切换类别或稍后刷新。</p>
    </div>

    <section v-else class="section-panel">
      <ul class="log-list">
        <li v-for="(entry, index) in entries" :key="`${entry.id ?? index}`">
          <header>
            <strong class="mono">{{ entry.id ?? '—' }}</strong>
            <span class="group-tag">{{ summary(entry) }}</span>
            <button
              v-if="entry.id"
              class="button"
              :disabled="detailBusy === String(entry.id)"
              @click="open(entry)"
            >
              <LoaderCircle v-if="detailBusy === String(entry.id)" :size="13" class="spin" />
              <span>明细</span>
            </button>
          </header>
          <pre>{{ JSON.stringify(entry, null, 2) }}</pre>

          <div v-if="detailId === String(entry.id ?? '')" class="log-detail">
            <div v-if="detailError" class="error-banner" role="alert">
              <span>{{ detailError }}</span
              ><button @click="closeDetail">关闭</button>
            </div>
            <template v-else-if="detail">
              <pre>{{ JSON.stringify(detail, null, 2) }}</pre>
              <button class="button" @click="closeDetail">收起明细</button>
            </template>
          </div>
        </li>
      </ul>

      <button v-if="hasMore" class="button" :disabled="loading" @click="refresh(false)">
        <LoaderCircle v-if="loading" :size="14" class="spin" />
        <span>加载更多</span>
      </button>
    </section>
  </section>
</template>

<style scoped>
.log-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0 0 14px;
  padding: 0;
  list-style: none;
}
.log-list > li {
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 10px 12px;
  background: var(--surface);
}
.log-list header {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-bottom: 6px;
  font-size: 12px;
}
.log-list pre {
  margin: 0;
  overflow-x: auto;
  color: var(--secondary);
  font-size: 12px;
  line-height: 1.6;
}
.log-detail {
  margin-top: 10px;
  border-top: 1px dashed var(--border);
  padding-top: 10px;
}
</style>

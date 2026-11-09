<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { CircleAlert, Download, LoaderCircle, RefreshCw, ScrollText, Search } from '@lucide/vue'
import ModalShell from '../../components/ModalShell.vue'
import { formatNumber } from '../../systems.ts'
import { formatTime, zcode } from './service.ts'
import type { ZcodeLogPage, ZcodeLogRow } from './types.ts'

const PAGE_SIZE = 20
const rows = ref<ZcodeLogRow[]>([])
const total = ref(0)
const offset = ref(0)
const query = ref('')
const outcome = ref('all')
const source = ref<'console' | 'legacy'>('console')
const loading = ref(false)
const error = ref('')
const detail = ref<ZcodeLogRow | null>(null)

const hasPrev = computed(() => offset.value > 0)
const hasNext = computed(() => offset.value + PAGE_SIZE < total.value)

const path = computed(() => {
  if (source.value === 'legacy') return `/logs?limit=${PAGE_SIZE}`
  const params = new URLSearchParams({
    limit: String(PAGE_SIZE),
    offset: String(offset.value),
    q: query.value.trim(),
    outcome: outcome.value,
  })
  return `/api/logs?${params}`
})

async function refresh() {
  loading.value = true
  try {
    const result = await zcode<ZcodeLogPage>(path.value)
    if (!Array.isArray(result.logs)) throw new Error('ZCode 日志数据格式不正确')
    rows.value = result.logs
    total.value = Number.isFinite(result.total) ? (result.total ?? result.logs.length) : result.logs.length
    error.value = ''
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'ZCode 日志加载失败'
  } finally {
    loading.value = false
  }
}

function search() {
  offset.value = 0
  void refresh()
}

function switchSource(next: 'console' | 'legacy') {
  source.value = next
  offset.value = 0
  void refresh()
}

function page(delta: number) {
  offset.value = Math.max(0, offset.value + delta * PAGE_SIZE)
  void refresh()
}

function exportLogs() {
  const params = new URLSearchParams({ download: '1', q: query.value.trim(), outcome: outcome.value })
  window.location.assign(`/api/p/zcode/api/logs?${params}`)
}

const rowTime = (row: ZcodeLogRow) => formatTime(row.at ?? row.t ?? null)
const rowTitle = (row: ZcodeLogRow) => [row.model, row.acc].filter(Boolean).join(' · ') || row.key || '请求'

onMounted(() => {
  void refresh()
})
</script>

<template>
  <section>
    <header class="page-heading">
      <div>
        <span class="eyebrow"><i class="blue-line" /> ZCODE LOGS</span>
        <h1>ZCode 日志<span class="heading-count">{{ formatNumber(total) }} 条</span></h1>
        <p>控制台日志支持关键字与结果筛选、分页与导出；旧版 /logs 仅保留最近记录。</p>
      </div>
      <div class="heading-actions">
        <button class="button" :disabled="loading" @click="refresh">
          <RefreshCw :size="15" :class="{ spin: loading }" /><span>刷新</span>
        </button>
        <button class="button" :disabled="source === 'legacy'" @click="exportLogs">
          <Download :size="15" /><span>导出</span>
        </button>
      </div>
    </header>

    <div class="section-panel">
      <div class="table-toolbar">
        <div class="segmented" role="group" aria-label="日志来源">
          <button :class="{ active: source === 'console' }" @click="switchSource('console')">控制台日志</button>
          <button :class="{ active: source === 'legacy' }" @click="switchSource('legacy')">旧版 /logs</button>
        </div>
        <div class="toolbar-filters">
          <label class="search-field">
            <Search :size="15" />
            <input v-model="query" type="search" placeholder="搜索模型、账号或密钥" aria-label="搜索日志" @keyup.enter="search" />
          </label>
          <div class="select-wrap">
            <select v-model="outcome" aria-label="按结果筛选" :disabled="source === 'legacy'" @change="search">
              <option value="all">全部结果</option>
              <option value="ok">成功</option>
              <option value="failed">失败</option>
            </select>
          </div>
        </div>
      </div>

      <div v-if="error" class="error-banner" role="alert"><CircleAlert :size="16" /><span>{{ error }}</span><button @click="refresh">重试</button></div>
      <div v-if="loading && !rows.length" class="page-loading">
        <LoaderCircle :size="20" class="spin" /><span>正在读取 ZCode 日志…</span>
      </div>
      <div v-else-if="!rows.length" class="empty-filter">
        <ScrollText :size="26" /><h3>没有匹配的日志</h3><p>调整筛选条件，或等待新的请求。</p>
      </div>
      <div v-else class="table-scroll">
        <table class="account-table">
          <thead><tr><th>时间</th><th>模型 / 账号</th><th>结果</th><th>入/出 token</th><th>耗时</th></tr></thead>
          <tbody>
            <tr v-for="(row, index) in rows" :key="index" class="zc-clickable" @click="detail = row">
              <td class="cell-secondary">{{ rowTime(row) }}</td>
              <td>
                <strong class="mono">{{ rowTitle(row) }}</strong>
                <p v-if="row.key" class="cell-secondary">密钥 {{ row.key }}</p>
              </td>
              <td>
                <span class="status-badge" :class="row.ok === false ? 'offline' : 'green'">
                  <i />{{ row.ok === false ? (row.status ?? '失败') : '成功' }}
                </span>
              </td>
              <td class="cell-secondary">{{ formatNumber(row.in ?? 0) }} / {{ formatNumber(row.out ?? 0) }}</td>
              <td class="cell-secondary">{{ row.ms ?? '—' }} ms</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="table-footer">
        <span class="subtle">共 {{ formatNumber(total) }} 条{{ source === 'legacy' ? '（旧版仅最近记录）' : '' }}</span>
        <div v-if="source === 'console'" class="pagination">
          <button class="button" :disabled="!hasPrev || loading" @click="page(-1)">上一页</button>
          <span>{{ Math.floor(offset / PAGE_SIZE) + 1 }}</span>
          <button class="button" :disabled="!hasNext || loading" @click="page(1)">下一页</button>
        </div>
      </div>
    </div>

    <ModalShell v-if="detail" title="日志详情" :subtitle="rowTime(detail)" wide @close="detail = null">
      <div class="modal-body">
        <div class="code-block">
          <div class="code-header"><span>原始记录</span></div>
          <pre>{{ JSON.stringify(detail, null, 2) }}</pre>
        </div>
      </div>
      <footer class="modal-footer"><button class="button" @click="detail = null">关闭</button></footer>
    </ModalShell>
  </section>
</template>

<style scoped>
.zc-clickable {
  cursor: pointer;
}
</style>

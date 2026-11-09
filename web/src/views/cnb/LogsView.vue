<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { CircleAlert, Download, LoaderCircle, RefreshCw, Search, ScrollText } from '@lucide/vue'
import ModalShell from '../../components/ModalShell.vue'
import { reportError } from '../../panel.ts'
import { formatNumber } from '../../systems.ts'
import { cnb, formatTime, pageWindow } from './service.ts'
import type { CnbLogChannel, CnbLogEntry, CnbLogPage } from './types.ts'

const CHANNELS: { id: CnbLogChannel; label: string; hint: string }[] = [
  { id: 'requests', label: '请求日志', hint: '网关请求与结果' },
  { id: 'audit', label: '审计日志', hint: '管理操作记录' },
  { id: 'system', label: '运行事件', hint: '注册、探活与故障转移' },
]
const PAGE_SIZE = 20

const channel = ref<CnbLogChannel>('requests')
const logs = ref<CnbLogEntry[]>([])
const total = ref(0)
const offset = ref(0)
const query = ref('')
const outcome = ref('all')
const kind = ref('all')
const loading = ref(false)
const error = ref('')
const detail = ref<CnbLogEntry | null>(null)

const windowLabel = computed(() => pageWindow(offset.value, PAGE_SIZE, total.value))
const hasPrev = computed(() => offset.value > 0)
const hasNext = computed(() => offset.value + PAGE_SIZE < total.value)

const channelQuery = computed(() => {
  const params = new URLSearchParams({
    limit: String(PAGE_SIZE),
    offset: String(offset.value),
    q: query.value.trim(),
    outcome: outcome.value,
    kind: kind.value,
  })
  return `/api/logs${channel.value === 'requests' ? '/requests' : `/${channel.value}`}?${params}`
})

async function refresh() {
  loading.value = true
  try {
    const result = await cnb<CnbLogPage>(channelQuery.value)
    if (!Array.isArray(result.logs)) throw new Error('日志数据格式不正确')
    logs.value = result.logs
    total.value = Number.isFinite(result.total) ? (result.total ?? result.logs.length) : result.logs.length
    error.value = ''
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '日志加载失败'
  } finally {
    loading.value = false
  }
}

function selectChannel(next: CnbLogChannel) {
  channel.value = next
  offset.value = 0
  void refresh()
}

function search() {
  offset.value = 0
  void refresh()
}

function page(delta: number) {
  offset.value = Math.max(0, offset.value + delta * PAGE_SIZE)
  void refresh()
}

async function openDetail(entry: CnbLogEntry) {
  if (!entry.id) return
  try {
    const result = await cnb<{ log: CnbLogEntry }>(`/api/logs/requests/${encodeURIComponent(entry.id)}`)
    detail.value = result.log ?? entry
  } catch (cause) {
    detail.value = entry
    reportError(cause, '请求详情读取失败')
  }
}

function exportLogs() {
  const params = new URLSearchParams({
    download: '1',
    q: query.value.trim(),
    outcome: outcome.value,
    kind: kind.value,
  })
  const href = `/api/p/cnb/api/logs${channel.value === 'requests' ? '/requests' : `/${channel.value}`}?${params}`
  window.location.assign(href)
}

const entryTitle = (entry: CnbLogEntry) =>
  entry.method && entry.path ? `${entry.method} ${entry.path}` : entry.message || entry.kind || '日志条目'

const entryStatus = (entry: CnbLogEntry) =>
  typeof entry.status === 'number' || typeof entry.status === 'string' ? String(entry.status) : ''

watch([outcome, kind], () => {
  offset.value = 0
  void refresh()
})

onMounted(() => {
  void refresh()
})
</script>

<template>
  <section>
    <header class="page-heading">
      <div>
        <span class="eyebrow"><i class="blue-line" /> CNB LOGS</span>
        <h1>CNB 日志<span class="heading-count">{{ formatNumber(total) }} 条</span></h1>
        <p>请求、审计与运行事件各自独立；导出会把当前筛选条件原样传给服务。</p>
      </div>
      <div class="heading-actions">
        <button class="button" :disabled="loading" @click="refresh">
          <RefreshCw :size="15" :class="{ spin: loading }" /><span>刷新</span>
        </button>
        <button class="button" @click="exportLogs"><Download :size="15" /><span>导出</span></button>
      </div>
    </header>

    <div class="section-panel">
      <div class="table-toolbar">
        <div class="segmented" role="group" aria-label="日志类别">
          <button
            v-for="item in CHANNELS"
            :key="item.id"
            :class="{ active: channel === item.id }"
            :title="item.hint"
            @click="selectChannel(item.id)"
          >
            {{ item.label }}
          </button>
        </div>
        <div class="toolbar-filters">
          <label class="search-field">
            <Search :size="15" />
            <input v-model="query" type="search" placeholder="搜索路径、账号或消息" aria-label="搜索日志" @keyup.enter="search" />
          </label>
          <div class="select-wrap">
            <select v-model="outcome" aria-label="按结果筛选">
              <option value="all">全部结果</option>
              <option value="ok">成功</option>
              <option value="failed">失败</option>
            </select>
          </div>
          <div class="select-wrap">
            <select v-model="kind" aria-label="按类型筛选">
              <option value="all">全部类型</option>
              <option value="request">请求</option>
              <option value="register">注册</option>
              <option value="health">探活</option>
              <option value="failover">故障转移</option>
            </select>
          </div>
        </div>
      </div>

      <div v-if="error" class="error-banner" role="alert">
        <CircleAlert :size="16" /><span>{{ error }}</span><button @click="refresh">重试</button>
      </div>
      <div v-if="loading && !logs.length" class="page-loading">
        <LoaderCircle :size="20" class="spin" /><span>正在读取日志…</span>
      </div>
      <div v-else-if="!logs.length" class="empty-filter">
        <ScrollText :size="26" /><h3>没有匹配的日志</h3>
        <p>调整筛选条件，或等待新的请求写入。</p>
      </div>
      <div v-else class="table-scroll">
        <table class="account-table">
          <thead>
            <tr><th>时间</th><th>条目</th><th>结果</th><th>账号</th><th>模型</th><th>耗时</th></tr>
          </thead>
          <tbody>
            <tr
              v-for="entry in logs"
              :key="entry.id"
              :class="{ 'cnb-clickable': channel === 'requests' }"
              @click="channel === 'requests' ? openDetail(entry) : undefined"
            >
              <td class="cell-secondary">{{ formatTime(entry.at ?? entry.createdAt) }}</td>
              <td>
                <strong class="mono">{{ entryTitle(entry) }}</strong>
                <p v-if="entry.message" class="cell-secondary">{{ entry.message }}</p>
              </td>
              <td>
                <span v-if="entryStatus(entry)" class="status-badge" :class="String(entry.outcome ?? '').includes('fail') || Number(entry.status) >= 400 ? 'offline' : 'green'">
                  <i />{{ entryStatus(entry) }}
                </span>
                <span v-else class="cell-secondary">{{ entry.outcome ?? '—' }}</span>
              </td>
              <td class="cell-secondary">{{ entry.account ?? '—' }}</td>
              <td class="cell-secondary">{{ entry.model ?? '—' }}</td>
              <td class="cell-secondary">{{ entry.durationMs ?? '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div class="table-footer">
        <span class="subtle">{{ windowLabel.start }}–{{ windowLabel.end }} / 共 {{ formatNumber(total) }} 条</span>
        <div class="pagination">
          <button class="button" :disabled="!hasPrev || loading" @click="page(-1)">上一页</button>
          <span>{{ Math.floor(offset / PAGE_SIZE) + 1 }}</span>
          <button class="button" :disabled="!hasNext || loading" @click="page(1)">下一页</button>
        </div>
      </div>
    </div>

    <ModalShell v-if="detail" title="请求详情" :subtitle="formatTime(detail.at ?? detail.createdAt)" wide @close="detail = null">
      <div class="modal-body">
        <dl class="detail-list">
          <div><dt>请求</dt><dd class="mono">{{ entryTitle(detail) }}</dd></div>
          <div><dt>结果</dt><dd>{{ detail.outcome ?? '—' }} · {{ entryStatus(detail) || '—' }}</dd></div>
          <div><dt>账号</dt><dd>{{ detail.account ?? '—' }}</dd></div>
          <div><dt>模型</dt><dd>{{ detail.model ?? '—' }}</dd></div>
          <div><dt>耗时</dt><dd>{{ detail.durationMs ?? '—' }} ms</dd></div>
        </dl>
        <div class="code-block">
          <div class="code-header"><span>原始记录</span></div>
          <pre>{{ JSON.stringify(detail, null, 2) }}</pre>
        </div>
      </div>
      <footer class="modal-footer">
        <button class="button" @click="detail = null">关闭</button>
      </footer>
    </ModalShell>
  </section>
</template>

<style scoped>
.cnb-clickable {
  cursor: pointer;
}
</style>

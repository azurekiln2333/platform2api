<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { consoleApi } from '../api.ts'
import {
  channels,
  query,
  queryValue,
  setQuery,
  errorText,
  formatNumber,
  absoluteTime,
} from '../console.ts'
import type { AggregateError, LogItem, LogDetail, UsageResponse } from '../console-types.ts'
import ChannelFilter from '../components/ChannelFilter.vue'
import SystemBadge from '../components/SystemBadge.vue'
import PartialErrors from '../components/PartialErrors.vue'
import RelativeTime from '../components/RelativeTime.vue'
import CopyButton from '../components/CopyButton.vue'
import CopyableValue from '../components/accounts/CopyableValue.vue'
import ModalShell from '../components/ModalShell.vue'
import DescriptorList from '../components/DescriptorList.vue'
import StackedChart from '../components/StackedChart.vue'
import RefreshControl from '../components/RefreshControl.vue'
import { redact } from '../redact.ts'
import { usageExtras } from '../channels/registry.ts'
const system = queryValue('system'),
  tab = queryValue('tab', 'request'),
  range = queryValue('range', '24h'),
  via = queryValue('via'),
  result = queryValue('result'),
  model = queryValue('model'),
  account = queryValue('account'),
  key = queryValue('key'),
  search = queryValue('q'),
  from = queryValue('from'),
  to = queryValue('to')
const items = ref<LogItem[]>([]),
  errors = ref<AggregateError[]>([]),
  failure = ref(''),
  loading = ref(false),
  cursor = ref<string | null>(null),
  usage = ref<UsageResponse | null>(null)
/** Refresh frequency in seconds (0 = off), owned by `RefreshControl` (F13). */
const intervalSeconds = ref(5)
const refresh = ref<{ markUpdated: () => void; markFailed: () => void } | null>(null)
const detailItem = ref<LogItem | null>(null)
const detail = ref<LogDetail | null>(null),
  detailOpen = ref(false),
  detailError = ref(''),
  detailLoading = ref(false)
const hasSystem = computed(() =>
  channels.value.some((c) => c.capabilities.logs.kinds.includes('system')),
)
const counts = computed(() =>
  items.value.reduce<Record<string, number>>((all, item) => {
    all[item.system] = (all[item.system] || 0) + 1
    return all
  }, {}),
)
let generation = 0,
  detailGeneration = 0,
  debounce: number | undefined,
  live = true
function params() {
  const now = Date.now(),
    hours = range.value === '1h' ? 1 : range.value === '7d' ? 168 : 24
  return {
    system: system.value,
    via: via.value,
    kind: tab.value === 'system' ? 'system' : 'request',
    from:
      range.value === 'custom'
        ? Number.isFinite(Date.parse(from.value))
          ? new Date(from.value).toISOString()
          : ''
        : new Date(now - hours * 3600000).toISOString(),
    to:
      range.value === 'custom'
        ? Number.isFinite(Date.parse(to.value))
          ? new Date(to.value).toISOString()
          : ''
        : new Date(now).toISOString(),
    result: result.value,
    model: model.value,
    account: account.value,
    key: key.value,
    q: search.value,
    limit: 50,
  }
}
let activeQuery: ReturnType<typeof params> | undefined
async function load(more = false) {
  if (more && loading.value) return
  const current = ++generation,
    filter = more && activeQuery ? activeQuery : params()
  if (!more) activeQuery = filter
  loading.value = true
  failure.value = ''
  if (
    range.value === 'custom' &&
    (!filter.from || !filter.to || Date.parse(from.value) > Date.parse(to.value))
  ) {
    failure.value = '请选择有效的开始与结束时间'
    loading.value = false
    // Not a fetch failure: keep the refresh loop alive without a backoff.
    refresh.value?.markUpdated()
    return
  }
  let ok = true
  try {
    if (tab.value === 'usage') {
      const response = await consoleApi.usage({ ...filter, bucket: 'day' })
      if (live && current === generation) {
        usage.value = response
        errors.value = response.errors || []
      }
    } else {
      const response = await consoleApi.logs({
        ...filter,
        cursor: more ? cursor.value || undefined : undefined,
      })
      if (live && current === generation) {
        const merged = more ? [...items.value, ...(response.items || [])] : response.items || []
        items.value = [...new Map(merged.map((item) => [item.id, item])).values()].sort(
          (a, b) => Date.parse(b.at) - Date.parse(a.at),
        )
        cursor.value = response.nextCursor || null
        errors.value = response.errors || []
      }
    }
  } catch (e) {
    ok = false
    if (live && current === generation) failure.value = errorText(e)
  } finally {
    if (live && current === generation) loading.value = false
    // Pagination is a user action; only a full reload reports to the control.
    if (!more && current === generation)
      if (ok) refresh.value?.markUpdated()
      else refresh.value?.markFailed()
  }
}
async function open(item: LogItem) {
  detailItem.value = item
  const current = ++detailGeneration
  detailOpen.value = true
  detail.value = null
  detailError.value = ''
  detailLoading.value = true
  try {
    const response = await consoleApi.log(item.id)
    if (live && current === detailGeneration)
      detail.value = { ...response, raw: redact(response.raw) }
  } catch (e) {
    if (live && current === detailGeneration) detailError.value = errorText(e)
  } finally {
    if (live && current === detailGeneration) detailLoading.value = false
  }
}
function closeDetail() {
  detailOpen.value = false
  detail.value = null
  detailGeneration++
}
function chart(metric: 'requests' | 'tokens') {
  const rows = new Map<string, Record<string, number>>()
  for (const row of usage.value?.series || []) {
    const group = rows.get(row.bucket) || {}
    group[row.system] =
      (group[row.system] || 0) +
      (metric === 'requests' ? row.requests : (row.inputTokens || 0) + (row.outputTokens || 0))
    rows.set(row.bucket, group)
  }
  return [...rows]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([label, values]) => ({ label: label.slice(5, 10), values }))
}
const tops = computed(() => [
  { title: '按模型', rows: usage.value?.byModel || [] },
  { title: '按密钥', rows: usage.value?.byKey || [] },
  { title: '按账号', rows: usage.value?.byAccount || [] },
])
const extras = computed(() =>
  Object.entries(usage.value?.extras || {}).filter(([id]) => !system.value || system.value === id),
)
watch(
  () => JSON.stringify(query.value),
  () => {
    clearTimeout(debounce)
    debounce = window.setTimeout(() => void load(), 180)
  },
)
onMounted(() => {
  if (tab.value === 'system' && !hasSystem.value) setQuery({ tab: 'request' })
  void load()
})
onBeforeUnmount(() => {
  live = false
  generation++
  detailGeneration++
  clearTimeout(debounce)
})
</script>
<template>
  <section>
    <header class="page-heading">
      <h1>请求日志</h1>
      <div class="heading-actions">
        <RefreshControl
          ref="refresh"
          v-model="intervalSeconds"
          storage-key="logs-refresh-rate"
          @tick="load()"
        />
        <button class="button" :disabled="loading" @click="load()">
          {{ loading ? '刷新中…' : '刷新' }}
        </button>
      </div>
    </header>
    <div class="console-tabs" role="tablist" aria-label="日志类别">
      <button
        :aria-selected="tab === 'request'"
        role="tab"
        :class="{ active: tab === 'request' }"
        @click="tab = 'request'"
      >
        请求日志</button
      ><button
        :aria-selected="tab === 'usage'"
        role="tab"
        :class="{ active: tab === 'usage' }"
        @click="tab = 'usage'"
      >
        用量统计</button
      ><button
        v-if="hasSystem"
        :aria-selected="tab === 'system'"
        role="tab"
        :class="{ active: tab === 'system' }"
        @click="tab = 'system'"
      >
        系统事件
      </button>
    </div>
    <ChannelFilter v-model="system" :channels="channels" :counts="counts" />
    <div class="console-toolbar">
      <label
        >时间范围<select v-model="range" aria-label="时间范围">
          <option value="1h">近 1 小时</option>
          <option value="24h">近 24 小时</option>
          <option value="7d">近 7 天</option>
          <option value="custom">自定义</option>
        </select></label
      ><template v-if="range === 'custom'"
        ><label>开始时间<input v-model="from" type="datetime-local" /></label
        ><label>结束时间<input v-model="to" type="datetime-local" /></label></template
      ><template v-if="tab !== 'usage'"
        ><label
          >入口<select v-model="via" aria-label="入口">
            <option value="">全部</option>
            <option value="unified">统一地址</option>
            <option value="direct">渠道直连</option>
          </select></label
        ><label
          >结果<select v-model="result" aria-label="结果">
            <option value="">全部</option>
            <option value="success">成功</option>
            <option value="failure">失败</option>
          </select></label
        ><label>模型<input v-model="model" placeholder="模型 ID" /></label
        ><label>账号<input v-model="account" placeholder="账号名称或 ID" /></label
        ><label>密钥<input v-model="key" placeholder="密钥名称或 ID" /></label
        ><label
          >关键字<input v-model="search" type="search" placeholder="搜索日志" /></label></template
      ><button
        class="button"
        @click="
          setQuery({
            system: undefined,
            via: undefined,
            range: undefined,
            result: undefined,
            model: undefined,
            account: undefined,
            key: undefined,
            q: undefined,
            from: undefined,
            to: undefined,
          })
        "
      >
        清除筛选
      </button>
    </div>
    <PartialErrors :errors="errors" @retry="load()" />
    <div v-if="failure" class="error-banner" role="alert">
      {{ failure }}<button @click="load()">重试</button>
    </div>
    <p v-if="loading" class="loading-state" role="status">
      正在加载{{ tab === 'usage' ? '用量' : '日志' }}…
    </p>
    <template v-if="tab === 'usage'"
      ><section class="console-panel">
        <h2>每日请求</h2>
        <StackedChart :rows="chart('requests')" label="每日请求，按渠道堆叠" />
      </section>
      <section class="console-panel">
        <h2>每日 token</h2>
        <StackedChart :rows="chart('tokens')" label="每日 token，按渠道堆叠" />
      </section>
      <div class="console-channel-grid">
        <section v-for="top in tops" :key="top.title" class="console-panel">
          <h2>{{ top.title }}</h2>
          <p v-if="!top.rows.length" class="empty-state">暂无用量</p>
          <ol v-else class="usage-top">
            <li v-for="(row, index) in top.rows" :key="index">
              <SystemBadge v-if="row.system" :system="row.system" /><span>{{
                row.name || row.model || row.key || row.account || '—'
              }}</span
              ><strong :title="String(row.requests)">{{ formatNumber(row.requests) }} 次</strong>
            </li>
          </ol>
        </section>
      </div>
      <section v-for="[id, extra] in extras" :key="id" class="console-panel">
        <h2><SystemBadge :system="id" /> 渠道用量明细</h2>
        <component :is="usageExtras[id]" v-if="usageExtras[id]" />
        <pre v-else class="console-json">{{ JSON.stringify(redact(extra), null, 2) }}</pre>
      </section></template
    >
    <template v-else
      ><div v-if="items.length" class="table-scroll">
        <table class="console-table">
          <thead>
            <tr>
              <th>时间</th>
              <th>入口</th>
              <th>渠道</th>
              <th>模型</th>
              <th>账号</th>
              <th>密钥</th>
              <th>状态码</th>
              <th>耗时</th>
              <th>输入 · 输出 token</th>
              <th>流式</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="item in items"
              :key="item.id"
              tabindex="0"
              @click="open(item)"
              @keydown.enter.prevent="open(item)"
            >
              <td><RelativeTime :value="item.at" /></td>
              <td>{{ item.via === 'unified' ? '统一地址' : '渠道直连' }}</td>
              <td><SystemBadge :system="item.system" /></td>
              <td>
                <CopyableValue
                  v-if="item.model"
                  class="cell-clip"
                  :value="item.model"
                  :label="`模型 ${item.model}`"
                  :title="item.model"
                  mono
                /><span v-else>—</span>
              </td>
              <td>{{ item.account || '—' }}</td>
              <td>{{ item.key || '—' }}</td>
              <td :class="(item.status || 0) >= 400 ? 'text-danger' : ''">
                {{ item.status ?? '—' }}
              </td>
              <td>{{ formatNumber(item.durationMs) }} ms</td>
              <td :title="`${item.inputTokens ?? 0} / ${item.outputTokens ?? 0}`">
                {{ formatNumber(item.inputTokens) }} · {{ formatNumber(item.outputTokens) }}
              </td>
              <td>{{ item.stream ? '是' : '否' }}</td>
              <td>
                <button
                  class="text-link"
                  :aria-label="`查看 ${item.id} 日志详情`"
                  @click.stop="open(item)"
                >
                  详情
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-else-if="!loading" class="empty-state">
        <p>当前筛选下没有日志</p>
        <button class="button" @click="load()">刷新日志</button>
      </div>
      <div class="load-more" v-if="cursor">
        <button class="button" :disabled="loading" @click="load(true)">
          {{ loading ? '加载中…' : '加载更多（每页 50 条）' }}
        </button>
      </div></template
    >
    <ModalShell v-if="detailOpen" title="日志详情" drawer @close="closeDetail"
      ><div class="modal-body">
        <p v-if="detailLoading">正在读取详情…</p>
        <p v-if="detailError" class="form-error" role="alert">
          {{ detailError }}
          <button v-if="detailItem" class="text-link" @click="open(detailItem)">重试</button>
        </p>
        <template v-if="detail"
          ><p><SystemBadge :system="detail.item.system" /> {{ absoluteTime(detail.item.at) }}</p>
          <p class="mono">
            {{ detail.item.id }} <CopyButton :value="detail.item.id" label="复制日志 ID" />
          </p>
          <DescriptorList :items="detail.display" absolute />
          <details>
            <summary>原始 JSON</summary>
            <CopyButton :value="JSON.stringify(detail.raw, null, 2)" label="复制日志 JSON" />
            <pre class="console-json">{{ JSON.stringify(detail.raw, null, 2) }}</pre>
          </details></template
        >
      </div></ModalShell
    >
  </section>
</template>

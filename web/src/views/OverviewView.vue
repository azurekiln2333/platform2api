<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { consoleApi } from '../api.ts'
import {
  channels,
  channelLabel,
  errorText,
  formatNumber,
  navigate,
  queryValue,
} from '../console.ts'
import type { ConsoleOverview } from '../console-types.ts'
import ChannelFilter from '../components/ChannelFilter.vue'
import PartialErrors from '../components/PartialErrors.vue'
import QuotaBar from '../components/QuotaBar.vue'
import RefreshControl from '../components/RefreshControl.vue'
import StackedChart from '../components/StackedChart.vue'
import SystemBadge from '../components/SystemBadge.vue'
import OverviewSection from '../components/overview/OverviewSection.vue'
import {
  buildFallbackSections,
  fetchSystemOverview,
  type SystemOverview,
} from '../components/overview/types.ts'

/** Overview page: cross-channel summary on "全部", backend-declared sections per channel. */
const selected = queryValue('system')
const frequency = ref(5)
const refresh = ref<{ markUpdated: () => void; markFailed: () => void } | null>(null)
const overview = ref<ConsoleOverview | null>(null)
const overviewError = ref('')
const detail = ref<SystemOverview | null>(null)
const detailError = ref('')
const loading = ref(false)
const detailLoading = ref(false)
let live = true
let summaryInFlight: Promise<void> | null = null
let detailInFlight: Promise<void> | null = null
let detailLoadingSystem = ''
let detailQueue: Promise<void> = Promise.resolve()

function settle(failed: boolean) {
  if (!live) return
  if (failed) refresh.value?.markFailed()
  else refresh.value?.markUpdated()
}

async function runSummary() {
  loading.value = true
  let failed = false
  try {
    const result = await consoleApi.overview()
    if (live) {
      overview.value = result
      overviewError.value = ''
    }
  } catch (e) {
    failed = true
    if (live) overviewError.value = errorText(e)
  } finally {
    if (live) loading.value = false
    settle(failed)
  }
}
function loadSummary() {
  if (summaryInFlight) return summaryInFlight
  summaryInFlight = runSummary().finally(() => {
    summaryInFlight = null
  })
  return summaryInFlight
}

async function runDetail(system: string) {
  detailLoading.value = true
  loading.value = true
  let failed = false
  try {
    const payload = await fetchSystemOverview(system)
    if (live && selected.value === system) {
      detail.value = payload
      detailError.value = ''
    }
  } catch (e) {
    if (!live || selected.value !== system) return
    // The `/api/overview/:system` contract may not be served yet (parallel
    // backend work): fall back to what the aggregate overview already knows.
    if (!overview.value) await loadSummary()
    const sections = buildFallbackSections(system, overview.value)
    if (sections.length) {
      detail.value = { system, generatedAt: new Date().toISOString(), sections, fallback: true }
      detailError.value = ''
    } else {
      failed = true
      detail.value = null
      detailError.value = errorText(e)
    }
  } finally {
    if (live) {
      detailLoading.value = false
      loading.value = false
    }
    settle(failed)
  }
}
function loadDetail(system: string) {
  if (detailInFlight && detailLoadingSystem === system) return detailInFlight
  // Serialise channel switches: the newest selection must still be fetched even
  // when the previous channel's request is in flight.
  detailLoadingSystem = system
  const next = detailQueue.then(() => runDetail(system))
  detailInFlight = next.finally(() => {
    if (detailInFlight === next) detailInFlight = null
  })
  detailQueue = detailInFlight.catch(() => {})
  return detailInFlight
}
function load() {
  return selected.value ? loadDetail(selected.value) : loadSummary()
}

const counts = computed(() =>
  Object.fromEntries(
    (overview.value?.channels || []).map((item) => [item.system, item.accounts?.total ?? 0]),
  ),
)
const countTotal = computed(() =>
  (overview.value?.channels || []).reduce((sum, item) => sum + (item.accounts?.total ?? 0), 0),
)
const sections = computed(() => detail.value?.sections || [])

const cards = computed(() =>
  channels.value.map((channel) => ({
    channel,
    data: overview.value?.channels?.find((item) => item.system === channel.system),
  })),
)
function failureRate(requests: number | null | undefined, errors: number | null | undefined) {
  return requests == null || errors == null
    ? '—'
    : `${(requests ? (errors / requests) * 100 : 0).toFixed(1)}%`
}
const metrics = computed(() => {
  const t = overview.value?.totals
  return [
    {
      label: '账号（可用 / 总数）',
      value: t ? `${formatNumber(t.accounts.ok)} / ${formatNumber(t.accounts.total)}` : '—',
      details: cards.value
        .map(
          (c) =>
            `${c.channel.label} ${c.data?.accounts?.ok ?? '—'}/${c.data?.accounts?.total ?? '—'}`,
        )
        .join(' · '),
    },
    {
      label: '今日请求',
      value: formatNumber(t?.requestsToday),
      details: cards.value
        .map((c) => `${c.channel.label} ${formatNumber(c.data?.requestsToday)}`)
        .join(' · '),
    },
    {
      label: '今日 token',
      value: formatNumber(t?.tokensToday),
      details: cards.value
        .map((c) => `${c.channel.label} ${formatNumber(c.data?.tokensToday)}`)
        .join(' · '),
    },
    {
      label: '今日失败率',
      value: t?.partial ? '—' : failureRate(t?.requestsToday, t?.errorsToday),
      details: cards.value
        .map(
          (c) =>
            `${c.channel.label} ${c.data?.partial ? '—' : failureRate(c.data?.requestsToday, c.data?.errorsToday)}`,
        )
        .join(' · '),
    },
  ]
})
const hourly = computed(() =>
  (overview.value?.hourly || []).map((row) => ({
    label: row.hour.includes('T')
      ? new Date(row.hour).toLocaleTimeString('zh-CN', { hour: '2-digit' })
      : row.hour,
    values: Object.fromEntries(channels.value.map((c) => [c.system, Number(row[c.system]) || 0])),
  })),
)
const channelError = (entry: (typeof cards.value)[number]) =>
  typeof entry.data?.error === 'object'
    ? entry.data.error?.message
    : entry.data?.error || entry.data?.detail || entry.channel.detail || '暂未取得运行数据'

watch(selected, () => {
  detail.value = null
  detailError.value = ''
  void load()
})
onMounted(() => {
  void loadSummary()
  if (selected.value) void loadDetail(selected.value)
})
onBeforeUnmount(() => {
  live = false
})
</script>
<template>
  <section>
    <header class="page-heading">
      <div>
        <h1>运行概览</h1>
        <p v-if="selected">{{ channelLabel(selected) }} 详细概览</p>
      </div>
      <div class="heading-actions">
        <RefreshControl
          ref="refresh"
          v-model="frequency"
          storage-key="overview-refresh-rate"
          @tick="load"
        />
        <button class="button" :disabled="loading" @click="load">
          {{ loading ? '刷新中…' : '刷新' }}
        </button>
      </div>
    </header>
    <ChannelFilter v-model="selected" :channels="channels" :counts="counts" :total="countTotal" />
    <template v-if="selected">
      <p v-if="detail?.fallback" class="cell-secondary">
        该渠道的详细概览暂不可用，以下为基础汇总。
      </p>
      <div v-if="detailError" class="error-banner" role="alert">
        {{ detailError }}<button type="button" @click="load">重试</button>
      </div>
      <p v-if="detailLoading && !detail" class="loading-state">正在加载概览…</p>
      <template v-else-if="detail">
        <p v-if="!sections.length" class="empty-state">该渠道暂无可展示的概览数据。</p>
        <OverviewSection
          v-for="section in sections"
          :key="`${section.kind}:${section.id}`"
          :section="section"
        />
      </template>
    </template>
    <template v-else>
      <div v-if="overviewError" class="error-banner" role="alert">
        {{ overviewError }}<button type="button" @click="load">重试</button>
      </div>
      <PartialErrors :errors="overview?.errors || []" @retry="load" />
      <p v-if="overview?.totals.partial" class="cell-secondary">
        统计尚不完整，指标仅汇总当前可用的数据。
      </p>
      <p v-if="loading && !overview" class="loading-state">正在加载概览…</p>
      <div class="console-metrics">
        <article v-for="metric in metrics" :key="metric.label" class="console-panel">
          <span>{{ metric.label }}</span
          ><strong :title="metric.value">{{ metric.value }}</strong
          ><small>{{ metric.details }}</small>
        </article>
      </div>
      <div class="console-channel-grid">
        <article
          v-for="entry in cards"
          :key="entry.channel.system"
          class="console-panel"
          :data-testid="`overview-card-${entry.channel.system}`"
        >
          <div class="row-between">
            <SystemBadge :system="entry.channel.system" /><span
              :class="entry.data?.ok ? 'text-success' : 'text-danger'"
              >{{ entry.data?.ok ? '运行正常' : '暂不可达' }}</span
            >
          </div>
          <template v-if="entry.data?.ok"
            ><a
              :href="`#accounts?system=${entry.channel.system}`"
              @click.prevent="navigate(`#accounts?system=${entry.channel.system}`)"
              >账号 {{ formatNumber(entry.data.accounts?.ok) }} /
              {{ formatNumber(entry.data.accounts?.total) }} →</a
            >
            <div data-testid="overview-quota"><QuotaBar :quota="entry.data.quota" /></div>
            <p :title="String(entry.data.requestsToday)">
              今日 {{ formatNumber(entry.data.requestsToday) }} 次请求
            </p></template
          >
          <div v-else role="status">
            <p class="form-error">{{ channelError(entry) }}</p>
            <button class="button" :disabled="loading" @click="load">重试</button>
          </div>
        </article>
      </div>
      <section class="console-panel">
        <h2>今日小时请求分布</h2>
        <StackedChart :rows="hourly" label="按渠道堆叠的小时请求分布" />
      </section>
      <section class="console-panel">
        <h2>待处理</h2>
        <ul v-if="overview?.attention?.length" class="attention-list">
          <li v-for="(item, index) in overview.attention" :key="index">
            <SystemBadge :system="item.system" /><a
              :href="item.link"
              @click.prevent="navigate(item.link)"
              >{{ item.message }} →</a
            >
          </li>
        </ul>
        <p v-else class="empty-state">{{ overview ? '一切正常' : '等待运行数据' }}</p>
      </section>
    </template>
  </section>
</template>

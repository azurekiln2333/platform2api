<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue'
import { consoleApi } from '../api.ts'
import { channels, channelLabel, errorText, formatNumber, navigate } from '../console.ts'
import type { ConsoleOverview } from '../console-types.ts'
import SystemBadge from '../components/SystemBadge.vue'
import QuotaBar from '../components/QuotaBar.vue'
import RelativeTime from '../components/RelativeTime.vue'
import StackedChart from '../components/StackedChart.vue'
import PartialErrors from '../components/PartialErrors.vue'
const data = ref<ConsoleOverview | null>(null),
  loading = ref(false),
  error = ref(''),
  automatic = ref(false)
let live = true
async function load() {
  if (loading.value) return
  loading.value = true
  try {
    const result = await consoleApi.overview()
    if (live) {
      data.value = result
      error.value = ''
    }
  } catch (e) {
    if (live) error.value = errorText(e)
  } finally {
    if (live) loading.value = false
  }
}
const cards = computed(() =>
  channels.value.map((channel) => ({
    channel,
    data: data.value?.channels?.find((item) => item.system === channel.system),
  })),
)
function failureRate(requests: number | null | undefined, errors: number | null | undefined) {
  return requests == null || errors == null
    ? '—'
    : `${(requests ? (errors / requests) * 100 : 0).toFixed(1)}%`
}
const metrics = computed(() => {
  const t = data.value?.totals
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
  (data.value?.hourly || []).map((row) => ({
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
let timer: number | undefined
onMounted(() => {
  void load()
  timer = window.setInterval(() => {
    if (automatic.value && !document.hidden) void load()
  }, 60000)
})
onBeforeUnmount(() => {
  live = false
  clearInterval(timer)
})
</script>
<template>
  <section>
    <header class="page-heading">
      <div>
        <h1>概览</h1>
        <p v-if="data">更新于 <RelativeTime :value="data.generatedAt" /></p>
      </div>
      <div class="heading-actions">
        <label class="check-field"
          ><input v-model="automatic" type="checkbox" />自动刷新（60 秒）</label
        ><button class="button" :disabled="loading" @click="load">
          {{ loading ? '刷新中…' : '刷新' }}
        </button>
      </div>
    </header>
    <div v-if="error" class="error-banner" role="alert">
      {{ error }}<button @click="load">重试</button>
    </div>
    <PartialErrors :errors="data?.errors || []" @retry="load" />
    <p v-if="data?.totals.partial" class="cell-secondary">
      统计尚不完整，指标仅汇总当前可用的数据。
    </p>
    <p v-if="loading && !data" class="loading-state">正在加载概览…</p>
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
      <ul v-if="data?.attention?.length" class="attention-list">
        <li v-for="(item, index) in data.attention" :key="index">
          <SystemBadge :system="item.system" /><a
            :href="item.link"
            @click.prevent="navigate(item.link)"
            >{{ item.message }} →</a
          >
        </li>
      </ul>
      <p v-else class="empty-state">{{ data ? '一切正常' : '等待运行数据' }}</p>
    </section>
  </section>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { Activity, BarChart3, CircleAlert, History, LoaderCircle, RefreshCw } from '@lucide/vue'
import { notify, reportError } from '../../panel.ts'
import { formatNumber } from '../../systems.ts'
import { cnb } from './service.ts'
import type { CnbCreditRateWindow, CnbUsageComparison, CnbUsageHistory } from './types.ts'

const WINDOWS = [
  { id: '1h', label: '1 小时' },
  { id: '24h', label: '24 小时' },
  { id: '7d', label: '7 天' },
] as const
const DAYS = [7, 30, 90, 365] as const

const window = ref<(typeof WINDOWS)[number]['id']>('24h')
const days = ref<(typeof DAYS)[number]>(30)
const rates = ref<CnbCreditRateWindow | null>(null)
const history = ref<CnbUsageHistory | null>(null)
const comparison = ref<CnbUsageComparison | null>(null)
const loading = ref('')
const error = ref('')

const rateRows = computed<Array<Record<string, unknown>>>(() =>
  Array.isArray(rates.value?.accounts)
    ? (rates.value?.accounts as Array<Record<string, unknown>>)
    : [],
)
const historyDays = computed<Array<Record<string, unknown>>>(() =>
  Array.isArray(history.value?.days) ? (history.value?.days as Array<Record<string, unknown>>) : [],
)
const historyAccounts = computed<Array<Record<string, unknown>>>(() =>
  Array.isArray(history.value?.accounts)
    ? (history.value?.accounts as Array<Record<string, unknown>>)
    : [],
)
const comparisonRows = computed<Array<Record<string, unknown>>>(() =>
  Array.isArray(comparison.value?.accounts)
    ? (comparison.value?.accounts as Array<Record<string, unknown>>)
    : [],
)
const historyPeak = computed(() =>
  Math.max(1, ...historyDays.value.map((day) => number(day.tokenUsage, 'total'))),
)

interface TokenUsage {
  total?: number
  input?: number
  output?: number
  cacheRead?: number
  cacheWrite?: number
}

function number(source: unknown, key?: string): number {
  const target =
    key && source && typeof source === 'object' ? (source as Record<string, unknown>)[key] : source
  return typeof target === 'number' && Number.isFinite(target) ? target : 0
}

const tokenUsage = (value: unknown): TokenUsage =>
  value && typeof value === 'object' ? (value as TokenUsage) : {}

const text = (value: unknown, fallback = '—'): string =>
  typeof value === 'string' && value ? value : fallback

async function loadRates() {
  loading.value = 'rates'
  try {
    rates.value = await cnb<CnbCreditRateWindow>(`/api/credits/rates?window=${window.value}`)
    error.value = ''
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '读取额度速率失败'
  } finally {
    loading.value = ''
  }
}

async function loadHistory() {
  loading.value = 'history'
  try {
    history.value = await cnb<CnbUsageHistory>(`/api/usage/history?days=${days.value}`)
    error.value = ''
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '读取用量历史失败'
  } finally {
    loading.value = ''
  }
}

async function loadComparison(refresh = false) {
  loading.value = 'comparison'
  try {
    comparison.value = refresh
      ? await cnb<CnbUsageComparison>('/api/usage/comparison', 'POST', {})
      : await cnb<CnbUsageComparison>('/api/usage/comparison')
    if (refresh) notify('已请求刷新工作区用量')
    error.value = ''
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '读取工作区用量失败'
    if (refresh) reportError(cause, '刷新工作区用量失败')
  } finally {
    loading.value = ''
  }
}

function selectWindow(next: (typeof WINDOWS)[number]['id']) {
  window.value = next
  void loadRates()
}

function selectDays(next: number) {
  days.value = next as (typeof DAYS)[number]
  void loadHistory()
}

onMounted(() => {
  void loadRates()
  void loadHistory()
  void loadComparison()
})
</script>

<template>
  <section>
    <div v-if="error" class="error-banner" role="alert">
      <CircleAlert :size="16" /><span>{{ error }}</span>
    </div>

    <section class="section-panel">
      <div class="section-heading">
        <i class="section-number">01</i>
        <div>
          <h2>额度消耗速率</h2>
          <p>按组织额度差额计算的 billing 速率，与工作区自报速率并排比对。</p>
        </div>
        <div class="segmented" role="group" aria-label="统计区间">
          <button
            v-for="item in WINDOWS"
            :key="item.id"
            :class="{ active: window === item.id }"
            @click="selectWindow(item.id)"
          >
            {{ item.label }}
          </button>
        </div>
      </div>
      <div v-if="loading === 'rates' && !rates" class="page-loading">
        <LoaderCircle :size="18" class="spin" /><span>正在读取速率…</span>
      </div>
      <div v-else-if="!rateRows.length" class="empty-filter">
        <Activity :size="24" />
        <h3>暂无速率数据</h3>
      </div>
      <div v-else class="table-scroll">
        <table class="account-table">
          <thead>
            <tr>
              <th>账号</th>
              <th>组织</th>
              <th>窗口额度差</th>
              <th>billing 速率</th>
              <th>自报速率</th>
              <th>剩余</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, index) in rateRows" :key="index">
              <td>{{ text(row.accountName) }}</td>
              <td class="cell-secondary">
                {{ text(row.org) }}<span v-if="row.sharedOrg" class="group-tag">共享</span>
              </td>
              <td>{{ formatNumber(number(row, 'deltaCredits'), 1) }} credits</td>
              <td>{{ formatNumber(number(row, 'billing'), 2) }} credits / 1k tokens</td>
              <td class="cell-secondary">
                {{
                  row.reported === null || row.reported === undefined
                    ? text(row.reportedStatus)
                    : formatNumber(number(row, 'reported'), 2)
                }}
              </td>
              <td class="cell-secondary">{{ formatNumber(number(row, 'remainingCredits'), 1) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="section-panel">
      <div class="section-heading">
        <i class="section-number">02</i>
        <div>
          <h2>每日 token 用量</h2>
          <p>按天聚合的 token 与请求数；部分回填日会标记为不完整。</p>
        </div>
        <div class="segmented" role="group" aria-label="统计范围">
          <button
            v-for="item in DAYS"
            :key="item"
            :class="{ active: days === item }"
            @click="selectDays(item)"
          >
            {{ item }} 天
          </button>
        </div>
      </div>
      <div v-if="loading === 'history' && !history" class="page-loading">
        <LoaderCircle :size="18" class="spin" /><span>正在读取用量历史…</span>
      </div>
      <template v-else-if="historyDays.length">
        <div class="usage-bars" role="img" aria-label="每日 token 用量">
          <div v-for="day in historyDays" :key="String(day.date)" class="usage-bar-slot">
            <i
              :style="{
                height: `${Math.max(2, (number(day.tokenUsage, 'total') / historyPeak) * 100)}%`,
              }"
            />
          </div>
        </div>
        <div class="table-scroll">
          <table class="account-table">
            <thead>
              <tr>
                <th>日期</th>
                <th>请求</th>
                <th>错误</th>
                <th>输入</th>
                <th>输出</th>
                <th>缓存读</th>
                <th>合计</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="day in [...historyDays].reverse().slice(0, 14)" :key="String(day.date)">
                <td>{{ text(day.date) }}<span v-if="day.partial" class="group-tag">部分</span></td>
                <td>{{ formatNumber(number(day, 'requests')) }}</td>
                <td>{{ formatNumber(number(day, 'errors')) }}</td>
                <td class="cell-secondary">{{ formatNumber(number(day.tokenUsage, 'input')) }}</td>
                <td class="cell-secondary">{{ formatNumber(number(day.tokenUsage, 'output')) }}</td>
                <td class="cell-secondary">
                  {{ formatNumber(number(day.tokenUsage, 'cacheRead')) }}
                </td>
                <td>{{ formatNumber(number(day.tokenUsage, 'total')) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-if="historyAccounts.length" class="table-scroll">
          <table class="account-table">
            <thead>
              <tr>
                <th>账号</th>
                <th>请求</th>
                <th>token 合计</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(row, index) in historyAccounts" :key="index">
                <td>{{ text(row.name, text(row.accountId)) }}</td>
                <td>{{ formatNumber(number(row, 'requests')) }}</td>
                <td>{{ formatNumber(number(row.tokenUsage, 'total')) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
      <div v-else class="empty-filter">
        <History :size="24" />
        <h3>还没有用量记录</h3>
      </div>
    </section>

    <section class="section-panel">
      <div class="section-heading">
        <i class="section-number">03</i>
        <div>
          <h2>工作区自报用量</h2>
          <p>读取每个工作区的 /usage 接口；未提供该接口的工作区会显示为不支持。</p>
        </div>
        <button class="button" :disabled="loading === 'comparison'" @click="loadComparison(true)">
          <RefreshCw :size="14" :class="{ spin: loading === 'comparison' }" /><span>刷新用量</span>
        </button>
      </div>
      <div v-if="!comparisonRows.length" class="empty-filter">
        <BarChart3 :size="24" />
        <h3>暂无工作区用量</h3>
        <p>注册工作区后可在这里比较自报与账单速率。</p>
      </div>
      <div v-else class="table-scroll">
        <table class="account-table">
          <thead>
            <tr>
              <th>账号</th>
              <th>状态</th>
              <th>说明</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, index) in comparisonRows" :key="index">
              <td>{{ text(row.name, text(row.accountId)) }}</td>
              <td>
                <span class="status-badge" :class="row.available === false ? 'offline' : 'green'">
                  <i />{{ row.available === false ? '不可用' : '可用' }}
                </span>
              </td>
              <td class="cell-secondary">
                {{ text(row.message, text(row.status)) }}
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </section>
</template>

<style scoped>
.usage-bars {
  display: flex;
  align-items: flex-end;
  gap: 2px;
  height: 120px;
  padding: 0 23px 18px;
}
.usage-bar-slot {
  flex: 1;
  height: 100%;
  display: flex;
  align-items: flex-end;
}
.usage-bar-slot i {
  display: block;
  width: 100%;
  background: var(--primary);
  border-radius: 2px 2px 0 0;
  opacity: 0.7;
}
</style>

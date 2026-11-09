<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { Activity, CircleAlert, Coins, Database, LoaderCircle, RefreshCw } from '@lucide/vue'
import { formatNumber } from '../../systems.ts'
import { codebuddy } from './service.ts'
import type { CodeBuddyDashboard } from './service.ts'

const WINDOWS = [1, 7, 30, 90] as const
const GRANULARITIES = ['auto', 'hour', 'day'] as const

const days = ref<(typeof WINDOWS)[number]>(7)
const granularity = ref<(typeof GRANULARITIES)[number]>('auto')
const data = ref<CodeBuddyDashboard | null>(null)
const loading = ref(false)
const loaded = ref(false)
const error = ref('')
let active = false
let generation = 0
let poll: number | undefined

const totals = computed(() => data.value?.totals ?? {})
const healthText = computed(() => {
  const health = data.value?.health
  if (!health) return '未知'
  if (typeof health === 'string') return health
  const status = (health as { status?: unknown }).status
  return typeof status === 'string' ? status : '未知'
})

async function refresh() {
  if (document.hidden || loading.value) return
  const request = ++generation
  loading.value = true
  try {
    const result = await codebuddy<CodeBuddyDashboard>(
      `/admin/dashboard?days=${days.value}&granularity=${granularity.value}`,
    )
    if (!active || request !== generation) return
    data.value = result
    loaded.value = true
    error.value = ''
  } catch (cause) {
    if (active && request === generation)
      error.value = cause instanceof Error ? cause.message : '无法读取 CodeBuddy 概览'
  } finally {
    if (active && request === generation) loading.value = false
  }
}

function pickWindow(next: (typeof WINDOWS)[number]) {
  days.value = next
  void refresh()
}
function pickGranularity(next: (typeof GRANULARITIES)[number]) {
  granularity.value = next
  void refresh()
}

onMounted(() => {
  active = true
  void refresh()
  poll = window.setInterval(() => void refresh(), 15000)
  window.addEventListener('focus', refresh)
})
onBeforeUnmount(() => {
  active = false
  generation++
  window.clearInterval(poll)
  window.removeEventListener('focus', refresh)
})
</script>

<template>
  <section>
    <header class="page-heading">
      <div>
        <span class="eyebrow"><i class="blue-line" /> CODEBUDDY OVERVIEW</span>
        <h1>CodeBuddy 概览</h1>
        <p>数据来自服务自身的 dashboard 接口，时间窗口与粒度按服务定义执行。</p>
      </div>
      <div class="heading-actions">
        <button class="button" :disabled="loading" @click="refresh">
          <RefreshCw :size="15" :class="{ spin: loading }" /><span>刷新概览</span>
        </button>
      </div>
    </header>

    <div class="table-toolbar">
      <div class="segmented">
        <button
          v-for="entry in WINDOWS"
          :key="entry"
          :class="{ active: days === entry }"
          @click="pickWindow(entry)"
        >
          {{ entry }} 天
        </button>
      </div>
      <div class="segmented">
        <button
          v-for="entry in GRANULARITIES"
          :key="entry"
          :class="{ active: granularity === entry }"
          @click="pickGranularity(entry)"
        >
          {{ entry }}
        </button>
      </div>
    </div>

    <div v-if="error" class="error-banner" role="alert">
      <span>{{ error }}</span>
      <button @click="refresh">重试读取概览</button>
    </div>

    <div v-if="loading && !loaded" class="page-loading">
      <LoaderCircle :size="20" class="spin" /><span>正在读取 CodeBuddy 概览…</span>
    </div>

    <template v-else>
      <div class="stats-grid">
        <article class="stat-card">
          <div class="stat-top">
            <span class="stat-icon blue"><Database :size="16" /></span>
            <span class="eyebrow">请求数</span>
          </div>
          <p class="stat-value">{{ formatNumber(totals.requests) }}</p>
        </article>
        <article class="stat-card">
          <div class="stat-top">
            <span class="stat-icon amber"><Coins :size="16" /></span>
            <span class="eyebrow">积分</span>
          </div>
          <p class="stat-value">{{ formatNumber(totals.credits) }}</p>
        </article>
        <article class="stat-card">
          <div class="stat-top">
            <span class="stat-icon green"><Activity :size="16" /></span>
            <span class="eyebrow">服务健康</span>
          </div>
          <p class="stat-value">{{ healthText }}</p>
        </article>
      </div>

      <div v-if="!data" class="empty-filter">
        <CircleAlert :size="28" />
        <h3>暂无概览数据</h3>
        <p>检查 CodeBuddy 服务是否运行，以及面板保存的服务地址与令牌是否正确。</p>
      </div>
    </template>
  </section>
</template>

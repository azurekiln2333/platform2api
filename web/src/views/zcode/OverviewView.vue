<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { Activity, CircleAlert, Coins, Gauge, LoaderCircle, RefreshCw, UsersRound } from '@lucide/vue'
import { reportError } from '../../panel.ts'
import { formatNumber, formatPercent } from '../../systems.ts'
import { accountState, accountStateLabel, formatTime, quotaInfo, zcode } from './service.ts'
import type { ZcodeAccount, ZcodeOverview } from './types.ts'

const data = ref<ZcodeOverview | null>(null)
const loading = ref(false)
const loaded = ref(false)
const error = ref('')
let active = false
let generation = 0
let poll: number | undefined

const stats = computed(() => data.value?.stats ?? {})
const accounts = computed<ZcodeAccount[]>(() => data.value?.accounts ?? [])
const buckets = computed(() => (data.value?.hourly ?? []).slice(-24))
const peak = computed(() => Math.max(1, ...buckets.value.map((bucket) => bucket.requests ?? 0)))
const remaining = computed(() => {
  const quotas = accounts.value.map((account) => quotaInfo(account.quota)).filter((quota) => quota !== null)
  if (quotas.length) return quotas.reduce((sum, quota) => sum + quota.remaining, 0)
  return stats.value.remainingCredits ?? null
})
const automation = computed(() => data.value?.claimAutomation ?? null)

async function refresh() {
  if (document.hidden || loading.value) return
  const request = ++generation
  loading.value = true
  try {
    const result = await zcode<ZcodeOverview>('/api/overview')
    if (!active || request !== generation) return
    if (!Array.isArray(result.accounts) || !result.stats)
      throw new Error('ZCode 控制台返回的概览数据格式不正确')
    data.value = result
    loaded.value = true
    error.value = ''
  } catch (cause) {
    if (active && request === generation) error.value = cause instanceof Error ? cause.message : '无法读取 ZCode 概览'
  } finally {
    if (active && request === generation) loading.value = false
  }
}

function refreshQuota(account: ZcodeAccount) {
  void zcode(`/api/accounts/${encodeURIComponent(account.label)}/refresh`, 'POST', {})
    .then(() => refresh())
    .catch((cause) => reportError(cause, '刷新账号资格失败'))
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
        <span class="eyebrow"><i class="blue-line" /> ZCODE OVERVIEW</span>
        <h1>ZCode 运行概览<span class="heading-count">{{ accounts.length }} 个账号</span></h1>
        <p>额度、账号与今日用量只统计 ZCode 自身，面板不会与其他系统相加。</p>
      </div>
      <div class="heading-actions">
        <button class="button" :disabled="loading" @click="refresh">
          <RefreshCw :size="15" :class="{ spin: loading }" /><span>刷新</span>
        </button>
      </div>
    </header>

    <div v-if="error" class="error-banner" role="alert">
      <CircleAlert :size="16" /><span>{{ error }}</span><button @click="refresh">重试</button>
    </div>

    <div v-if="loading && !loaded" class="page-loading">
      <LoaderCircle :size="22" class="spin" /><span>正在读取 ZCode 概览…</span>
    </div>

    <template v-else>
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-top"><span>可用账号</span><i class="stat-icon green"><UsersRound :size="15" /></i></div>
          <div class="stat-value">
            {{ formatNumber(stats.ready ?? null) }}<small>/ {{ formatNumber(stats.total ?? accounts.length) }}</small>
          </div>
          <div class="stat-bottom stat-dots"><i /><i /><i />冷却 {{ formatNumber(stats.cooling ?? 0) }} · 停用 {{ formatNumber(stats.disabled ?? 0) }}</div>
        </div>
        <div class="stat-card">
          <div class="stat-top"><span>剩余额度</span><i class="stat-icon blue"><Coins :size="15" /></i></div>
          <div class="stat-value">{{ formatNumber(remaining, 1) }}<small>credits</small></div>
          <div class="stat-bottom">{{ formatNumber(stats.quotaOrganizations ?? 0) }} 个账号已同步</div>
        </div>
        <div class="stat-card">
          <div class="stat-top"><span>今日请求</span><i class="stat-icon violet"><Activity :size="15" /></i></div>
          <div class="stat-value">{{ formatNumber(stats.requests ?? null) }}<small>次</small></div>
          <div class="stat-bottom">错误 {{ formatNumber(stats.errors ?? 0) }} · 进行中 {{ formatNumber(stats.activeRequests ?? 0) }}</div>
        </div>
        <div class="stat-card">
          <div class="stat-top"><span>成功率</span><i class="stat-icon amber"><Gauge :size="15" /></i></div>
          <div class="stat-value">{{ formatPercent(stats.successRate ?? null) }}</div>
          <div class="stat-bottom">平均耗时 {{ formatNumber(stats.averageDurationMs ?? null) }} ms</div>
        </div>
      </div>

      <section class="section-panel">
        <div class="section-heading">
          <i class="section-number">01</i>
          <div><h2>今日小时请求分布</h2><p>来自调度器的小时聚合；失败数单独叠加。</p></div>
          <span class="subtle">最近 {{ buckets.length }} 小时</span>
        </div>
        <div v-if="buckets.length" class="zc-bars" role="img" aria-label="ZCode 今日小时请求分布">
          <div v-for="(bucket, index) in buckets" :key="index" class="zc-bar-slot">
            <i :style="{ height: `${Math.max(2, ((bucket.requests - (bucket.fails ?? bucket.errors ?? 0)) / peak) * 100)}%` }" />
            <b :style="{ height: `${Math.max(0, ((bucket.fails ?? bucket.errors ?? 0) / peak) * 100)}%` }" />
            <span>{{ bucket.at ? new Date(bucket.at).getHours() : new Date(bucket.t ?? 0).getHours() }}</span>
          </div>
        </div>
        <div v-else class="empty-filter"><Activity :size="26" /><h3>今日还没有请求</h3></div>
      </section>

      <section class="section-panel">
        <div class="section-heading">
          <i class="section-number">02</i>
          <div><h2>账号额度与资格</h2><p>每个账号的套餐额度与资格独立刷新。</p></div>
          <span v-if="automation" class="subtle">
            定时领取 {{ automation.running ? '运行中' : automation.settings?.enabled ? '已启用' : '未启用' }}
          </span>
        </div>
        <div v-if="accounts.length" class="table-scroll">
          <table class="account-table">
            <thead><tr><th>账号</th><th>状态</th><th>额度</th><th>资格</th><th>操作</th></tr></thead>
            <tbody>
              <tr v-for="account in accounts" :key="account.label">
                <td>
                  <strong class="account-name">{{ account.name || account.label }}</strong>
                  <span class="zc-meta">{{ account.email || account.phone || account.label }}</span>
                </td>
                <td>{{ accountStateLabel(account) }}</td>
                <td>
                  <template v-if="quotaInfo(account.quota)">
                    <p class="quota-numbers">
                      <strong>{{ formatNumber(quotaInfo(account.quota)?.remaining ?? null, 1) }}</strong><span>credits</span>
                    </p>
                    <div class="quota-track">
                      <i
                        :style="{ width: `${quotaInfo(account.quota)?.percent ?? 0}%` }"
                        :class="{ low: (quotaInfo(account.quota)?.percent ?? 0) >= 85 }"
                      />
                    </div>
                  </template>
                  <span v-else class="cell-secondary">未同步</span>
                </td>
                <td class="cell-secondary">
                  {{ account.eligibility?.status ?? (account.hasCodingPlanKey ? '已配置 Coding Plan Key' : '未配置') }}
                </td>
                <td>
                  <button class="button" :disabled="loading" @click="refreshQuota(account)">刷新资格</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-else class="empty-filter">
          <UsersRound :size="28" /><h3>还没有 ZCode 账号</h3><p>在「账号授权」页完成登录授权后即可接入。</p>
        </div>
      </section>

      <p v-if="data" class="cell-secondary zc-meta">最近刷新 {{ formatTime(new Date().toISOString()) }}</p>
    </template>
  </section>
</template>

<style scoped>
.zc-bars {
  display: flex;
  align-items: flex-end;
  gap: 4px;
  height: 150px;
  padding: 0 23px 24px;
}
.zc-bar-slot {
  position: relative;
  display: flex;
  flex: 1;
  flex-direction: column;
  justify-content: flex-end;
  height: 100%;
  border-bottom: 1px solid var(--line);
}
.zc-bar-slot i {
  display: block;
  background: var(--primary);
  border-radius: 2px 2px 0 0;
  opacity: 0.75;
}
.zc-bar-slot b {
  display: block;
  background: var(--red, #c0392b);
  opacity: 0.8;
}
.zc-bar-slot span {
  position: absolute;
  bottom: -18px;
  width: 100%;
  text-align: center;
  color: var(--muted);
  font-size: 10px;
}
.zc-meta {
  display: block;
  margin-top: 4px;
  color: var(--muted);
  font-size: 12px;
}
</style>

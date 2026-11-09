<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import {
  Activity,
  CircleAlert,
  Coins,
  Gauge,
  LoaderCircle,
  RefreshCw,
  UsersRound,
} from '@lucide/vue'
import { notify, reportError } from '../../panel.ts'
import { formatNumber, formatPercent } from '../../systems.ts'
import { accountState, accountStateLabel, cnb, formatTime, quotaInfo } from './service.ts'
import type { CnbAccount, CnbOverview } from './types.ts'

const data = ref<CnbOverview | null>(null)
const loading = ref(false)
const loaded = ref(false)
const error = ref('')
let active = false
let generation = 0
let poll: number | undefined

const stats = computed(() => data.value?.stats ?? {})
const accounts = computed<CnbAccount[]>(() => data.value?.accounts ?? [])
const hourly = computed(() => data.value?.hourly ?? [])
const peak = computed(() => Math.max(1, ...hourly.value.map((bucket) => bucket.requests ?? 0)))
const buckets = computed(() => hourly.value.slice(-24))
const remaining = computed(() => {
  const quotas = accounts.value.map(quotaInfo).filter((quota) => quota !== null)
  if (quotas.length) return quotas.reduce((sum, quota) => sum + quota.remaining, 0)
  return stats.value.remainingCredits ?? null
})
const paused = computed(() => accounts.value.filter((account) => accountState(account) === 'quota').length)

async function refresh() {
  if (document.hidden || loading.value) return
  const request = ++generation
  loading.value = true
  try {
    const result = await cnb<CnbOverview>('/api/overview')
    if (!active || request !== generation) return
    if (!Array.isArray(result.accounts) || !result.stats)
      throw new Error('CNB 面板返回的概览数据格式不正确')
    data.value = result
    loaded.value = true
    error.value = ''
  } catch (cause) {
    if (active && request === generation) {
      error.value = cause instanceof Error ? cause.message : '无法读取 CNB 概览'
    }
  } finally {
    if (active && request === generation) loading.value = false
  }
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

function syncQuota(account: CnbAccount) {
  void cnb('/api/accounts/' + encodeURIComponent(account.id) + '/quota', 'POST', {})
    .then(() => {
      notify('已请求同步组织额度')
      return refresh()
    })
    .catch((cause) => reportError(cause, '额度同步失败'))
}
</script>

<template>
  <section>
    <header class="page-heading">
      <div>
        <span class="eyebrow"><i class="blue-line" /> CNB OVERVIEW</span>
        <h1>CNB 运行概览<span class="heading-count">{{ accounts.length }} 个账号</span></h1>
        <p>额度、账号与今日用量只统计 CNB 自身；面板不会与其他系统相加。</p>
      </div>
      <div class="heading-actions">
        <button class="button" :disabled="loading" @click="refresh">
          <RefreshCw :size="15" :class="{ spin: loading }" /><span>刷新</span>
        </button>
      </div>
    </header>

    <div v-if="error" class="error-banner" role="alert">
      <CircleAlert :size="16" /><span>{{ error }}</span>
      <button @click="refresh">重试</button>
    </div>

    <div v-if="loading && !loaded" class="page-loading">
      <LoaderCircle :size="22" class="spin" /><span>正在读取 CNB 概览…</span>
    </div>

    <template v-else>
      <div class="stats-grid">
        <div class="stat-card">
          <div class="stat-top"><span>可用账号</span><i class="stat-icon green"><UsersRound :size="15" /></i></div>
          <div class="stat-value">
            {{ formatNumber(stats.ready ?? null) }}<small>/ {{ formatNumber(stats.total ?? accounts.length) }}</small>
          </div>
          <div class="stat-bottom stat-dots"><i /><i /><i />冷却 {{ formatNumber(stats.cooling ?? 0) }}</div>
        </div>
        <div class="stat-card">
          <div class="stat-top"><span>剩余额度</span><i class="stat-icon blue"><Coins :size="15" /></i></div>
          <div class="stat-value">
            {{ formatNumber(remaining, 1) }}<small>credits</small>
          </div>
          <div class="stat-bottom">
            {{ formatNumber(stats.quotaOrganizations ?? 0) }} 个组织 · 暂停 {{ paused }}
          </div>
        </div>
        <div class="stat-card">
          <div class="stat-top"><span>今日请求</span><i class="stat-icon violet"><Activity :size="15" /></i></div>
          <div class="stat-value">
            {{ formatNumber(stats.requests ?? null) }}<small>次</small>
          </div>
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
          <div>
            <h2>今日小时请求分布</h2>
            <p>按小时统计 CNB 网关请求数，错误数叠加显示。</p>
          </div>
          <span class="subtle">最近 {{ buckets.length }} 小时</span>
        </div>
        <div v-if="buckets.length" class="cnb-bars" role="img" aria-label="CNB 今日小时请求分布">
          <div v-for="bucket in buckets" :key="bucket.at" class="cnb-bar-slot">
            <i
              class="cnb-bar-ok"
              :style="{ height: `${Math.max(2, ((bucket.requests - bucket.errors) / peak) * 100)}%` }"
            />
            <i
              class="cnb-bar-error"
              :style="{ height: `${Math.max(0, (bucket.errors / peak) * 100)}%` }"
            />
            <span>{{ new Date(bucket.at).getHours() }}</span>
          </div>
        </div>
        <div v-else class="empty-filter"><Activity :size="26" /><h3>今日还没有请求</h3></div>
      </section>

      <section class="section-panel">
        <div class="section-heading">
          <i class="section-number">02</i>
          <div>
            <h2>账号额度</h2>
            <p>每个账号的组织额度独立同步；额度停用由服务的额度保护策略控制。</p>
          </div>
          <span class="subtle">更新于 {{ formatTime(accounts.find((a) => a.quota?.syncedAt)?.quota?.syncedAt) }}</span>
        </div>
        <div v-if="accounts.length" class="table-scroll">
          <table class="account-table">
            <thead>
              <tr><th>账号</th><th>状态</th><th>额度</th><th>已用</th><th>操作</th></tr>
            </thead>
            <tbody>
              <tr v-for="account in accounts" :key="account.id">
                <td>
                  <strong class="account-name">{{ account.name }}</strong>
                  <span class="account-repo">{{ account.repo || '—' }}</span>
                </td>
                <td>{{ accountStateLabel(account) }}</td>
                <td>
                  <template v-if="quotaInfo(account)">
                    <p class="quota-numbers">
                      <strong>{{ formatNumber(quotaInfo(account)?.remaining ?? null, 1) }}</strong
                      ><span>credits</span>
                    </p>
                    <div class="quota-track">
                      <i
                        :style="{ width: `${quotaInfo(account)?.percent ?? 0}%` }"
                        :class="{ low: (quotaInfo(account)?.percent ?? 0) >= 85 }"
                      />
                    </div>
                  </template>
                  <span v-else class="cell-secondary">未同步</span>
                </td>
                <td class="cell-secondary">{{ formatNumber(quotaInfo(account)?.used ?? null, 1) }}</td>
                <td>
                  <button class="button" :disabled="loading" @click="syncQuota(account)">同步额度</button>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
        <div v-else class="empty-filter">
          <UsersRound :size="28" /><h3>还没有 CNB 账号</h3>
          <p>在「账号管理」页新建账号后即可注册工作区。</p>
        </div>
      </section>
    </template>
  </section>
</template>

<style scoped>
.cnb-bars {
  display: flex;
  align-items: flex-end;
  gap: 4px;
  height: 150px;
  padding: 0 23px 23px;
}
.cnb-bar-slot {
  position: relative;
  display: flex;
  flex: 1;
  flex-direction: column;
  justify-content: flex-end;
  gap: 1px;
  height: 100%;
  border-bottom: 1px solid var(--line);
}
.cnb-bar-slot span {
  position: absolute;
  bottom: -18px;
  width: 100%;
  text-align: center;
  color: var(--muted);
  font-size: 10px;
}
.cnb-bar-ok {
  display: block;
  background: var(--primary);
  border-radius: 2px 2px 0 0;
  opacity: 0.75;
}
.cnb-bar-error {
  display: block;
  background: var(--red, #c0392b);
  border-radius: 2px 2px 0 0;
  opacity: 0.8;
}
.account-repo {
  display: block;
  margin-top: 4px;
  color: var(--muted);
  font-size: 12px;
}
</style>

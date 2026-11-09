<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { Activity, CircleAlert, LoaderCircle, RefreshCw, ShieldCheck, Trash2, Zap } from '@lucide/vue'
import { notify, reportError } from '../../panel.ts'
import { formatNumber } from '../../systems.ts'
import { formatTime, zcode } from './service.ts'
import type { ZcodeSecurity, ZcodeStatsPage } from './types.ts'

const RANGES = [
  { id: 'today', label: '今天' },
  { id: '7d', label: '7 天' },
  { id: '14d', label: '14 天' },
  { id: '30d', label: '30 天' },
] as const

const range = ref<(typeof RANGES)[number]['id']>('today')
const stats = ref<ZcodeStatsPage | null>(null)
const security = ref<ZcodeSecurity | null>(null)
const quota = ref<Array<Record<string, unknown>>>([])
const pool = ref<Record<string, unknown> | null>(null)
const selftest = ref<Record<string, unknown> | null>(null)
const loading = ref('')
const error = ref('')
const rule = ref({ cidr: '', type: 'deny' as 'allow' | 'deny', note: '' })

const totals = computed(() => stats.value?.totals ?? {})
const buckets = computed(() => stats.value?.buckets ?? [])
const peak = computed(() => Math.max(1, ...buckets.value.map((bucket) => bucket.requests ?? 0)))
const poolAccounts = computed<Array<Record<string, unknown>>>(() =>
  Array.isArray(pool.value?.accounts) ? (pool.value?.accounts as Array<Record<string, unknown>>) : [],
)
const blockedTotal = computed(() => security.value?.blockedTotal ?? security.value?.blocked?.length ?? 0)

async function loadStats() {
  loading.value = 'stats'
  try {
    stats.value = await zcode<ZcodeStatsPage>(`/stats?range=${range.value}`)
    error.value = ''
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'ZCode 统计读取失败'
  } finally {
    loading.value = ''
  }
}

async function loadSecurity() {
  loading.value = 'security'
  try {
    security.value = await zcode<ZcodeSecurity>('/security')
  } catch (cause) {
    reportError(cause, 'ZCode 安全策略读取失败')
  } finally {
    loading.value = ''
  }
}

async function loadQuota() {
  loading.value = 'quota'
  try {
    const result = await zcode<{ accounts?: Array<Record<string, unknown>> }>('/quota')
    quota.value = Array.isArray(result.accounts) ? result.accounts : []
  } catch (cause) {
    reportError(cause, 'ZCode 额度读取失败')
  } finally {
    loading.value = ''
  }
}

async function loadPool() {
  loading.value = 'pool'
  try {
    pool.value = await zcode<Record<string, unknown>>('/pool')
  } catch (cause) {
    reportError(cause, 'ZCode 号池状态读取失败')
  } finally {
    loading.value = ''
  }
}

async function saveSecurity(patch: Record<string, unknown>) {
  loading.value = 'security-save'
  try {
    await zcode('/security', 'POST', patch)
    await loadSecurity()
    notify('安全策略已更新')
  } catch (cause) {
    reportError(cause, '更新安全策略失败')
  } finally {
    loading.value = ''
  }
}

async function clearBlocked() {
  loading.value = 'blocked'
  try {
    await zcode('/security/clear-blocked', 'POST', {})
    await loadSecurity()
    notify('拦截记录已清空')
  } catch (cause) {
    reportError(cause, '清空拦截记录失败')
  } finally {
    loading.value = ''
  }
}

async function resetPool() {
  loading.value = 'reset'
  try {
    const result = await zcode<{ accounts?: number }>('/pool/reset', 'POST', {})
    notify(`已重置 ${formatNumber(result.accounts ?? 0)} 个账号的冷却`)
    await loadPool()
  } catch (cause) {
    reportError(cause, '重置冷却失败')
  } finally {
    loading.value = ''
  }
}

async function runSelftest() {
  loading.value = 'selftest'
  try {
    selftest.value = await zcode<Record<string, unknown>>('/selftest', 'POST', {})
    notify('探测已完成')
  } catch (cause) {
    reportError(cause, '探测失败')
  } finally {
    loading.value = ''
  }
}

function selectRange(next: (typeof RANGES)[number]['id']) {
  range.value = next
  void loadStats()
}

onMounted(() => {
  void loadStats()
  void loadSecurity()
  void loadQuota()
  void loadPool()
})
</script>

<template>
  <section>
    <header class="page-heading">
      <div>
        <span class="eyebrow"><i class="blue-line" /> ZCODE OPS</span>
        <h1>ZCode 运维工具</h1>
        <p>旧版统计、额度、IP 管控、号池状态与探测都在这一页，数据由 ZCode 服务生成。</p>
      </div>
      <div class="heading-actions">
        <button class="button" :disabled="loading === 'selftest'" @click="runSelftest">
          <Zap :size="15" /><span>立即探测</span>
        </button>
      </div>
    </header>

    <div v-if="error" class="error-banner" role="alert"><CircleAlert :size="16" /><span>{{ error }}</span><button @click="loadStats">重试</button></div>

    <section class="section-panel">
      <div class="section-heading">
        <Activity :size="20" />
        <div><h2>请求统计</h2><p>来自服务的 /stats；按小时或按天聚合。</p></div>
        <div class="segmented" role="group" aria-label="统计范围">
          <button v-for="item in RANGES" :key="item.id" :class="{ active: range === item.id }" @click="selectRange(item.id)">
            {{ item.label }}
          </button>
        </div>
      </div>
      <div v-if="loading === 'stats' && !stats" class="page-loading">
        <LoaderCircle :size="18" class="spin" /><span>正在读取统计…</span>
      </div>
      <template v-else>
        <div class="stats-grid">
          <div class="stat-card">
            <div class="stat-top"><span>请求</span></div>
            <div class="stat-value">{{ formatNumber(totals.requests ?? 0) }}</div>
          </div>
          <div class="stat-card">
            <div class="stat-top"><span>失败</span></div>
            <div class="stat-value">{{ formatNumber(totals.fail ?? 0) }}</div>
          </div>
          <div class="stat-card">
            <div class="stat-top"><span>token</span></div>
            <div class="stat-value">{{ formatNumber(totals.tokens ?? 0) }}</div>
          </div>
          <div class="stat-card">
            <div class="stat-top"><span>平均耗时</span></div>
            <div class="stat-value">
              {{ formatNumber(totals.requests ? Math.round((totals.msSum ?? 0) / totals.requests) : 0) }}<small>ms</small>
            </div>
          </div>
        </div>
        <div v-if="buckets.length" class="zc-bars" role="img" aria-label="ZCode 请求分布">
          <div v-for="(bucket, index) in buckets" :key="index" class="zc-bar-slot">
            <i :style="{ height: `${Math.max(2, (bucket.requests / peak) * 100)}%` }" />
          </div>
        </div>
        <div v-if="stats?.byModel?.length" class="table-scroll">
          <table class="account-table">
            <thead><tr><th>模型</th><th>请求</th><th>失败</th><th>token</th></tr></thead>
            <tbody>
              <tr v-for="(row, index) in stats.byModel" :key="index">
                <td class="mono">{{ row.name ?? '—' }}</td>
                <td>{{ formatNumber(Number(row.requests ?? 0)) }}</td>
                <td class="cell-secondary">{{ formatNumber(Number(row.fail ?? 0)) }}</td>
                <td class="cell-secondary">{{ formatNumber(Number(row.tokens ?? 0)) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </section>

    <section class="section-panel">
      <div class="section-heading">
        <ShieldCheck :size="20" />
        <div><h2>IP 管控</h2><p>黑/白名单规则由服务保存；拦截记录可单独清空。</p></div>
        <button class="button" :disabled="loading === 'blocked'" @click="clearBlocked">
          <Trash2 :size="14" /><span>清空拦截记录</span>
        </button>
      </div>
      <div class="modal-body">
        <div class="form-grid">
          <label class="check-label">
            <input
              type="checkbox"
              :checked="security?.enabled === true"
              :disabled="loading === 'security-save'"
              @change="saveSecurity({ enabled: !(security?.enabled === true) })"
            />启用 IP 管控
          </label>
          <label
            >模式
            <select
              :value="security?.mode ?? 'blacklist'"
              @change="saveSecurity({ mode: (($event.target as HTMLSelectElement).value) })"
            >
              <option value="blacklist">黑名单</option>
              <option value="whitelist">白名单</option>
            </select>
          </label>
        </div>
        <div class="form-grid">
          <label>IP / CIDR<input v-model="rule.cidr" placeholder="例如 10.0.0.0/8" /></label>
          <label
            >类型
            <select v-model="rule.type">
              <option value="deny">拒绝</option>
              <option value="allow">允许</option>
            </select>
          </label>
          <label>备注<input v-model="rule.note" maxlength="120" /></label>
        </div>
        <div class="button-group">
          <button
            class="button primary"
            :disabled="!rule.cidr.trim() || loading === 'security-save'"
            @click="
              () => {
                void saveSecurity({ action: 'add', cidr: rule.cidr.trim(), type: rule.type, note: rule.note })
                rule = { cidr: '', type: 'deny', note: '' }
              }
            "
          >
            添加规则
          </button>
          <button class="button" @click="loadSecurity"><RefreshCw :size="14" /><span>刷新</span></button>
          <span class="subtle">已拦截 {{ formatNumber(blockedTotal) }} 次</span>
        </div>
      </div>
      <div v-if="security?.rules?.length" class="table-scroll">
        <table class="account-table">
          <thead><tr><th>#</th><th>规则</th><th>类型</th><th>备注</th><th>操作</th></tr></thead>
          <tbody>
            <tr v-for="(item, index) in security.rules" :key="index">
              <td class="cell-secondary">{{ index }}</td>
              <td class="mono">{{ item.cidr }}</td>
              <td>{{ item.type === 'allow' ? '允许' : '拒绝' }}</td>
              <td class="cell-secondary">{{ item.note || '—' }}</td>
              <td>
                <button class="button" @click="saveSecurity({ action: 'remove', index })">删除</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-else class="empty-filter"><h3>还没有 IP 规则</h3></div>
    </section>

    <section class="section-panel">
      <div class="section-heading">
        <RefreshCw :size="20" />
        <div><h2>号池与冷却</h2><p>重置会清空所有账号的冷却、降级与失败计数。</p></div>
        <button class="button" @click="loadPool">刷新</button>
        <button class="button danger" :disabled="loading === 'reset'" @click="resetPool">重置冷却</button>
      </div>
      <div v-if="!poolAccounts.length" class="empty-filter"><h3>号池为空</h3></div>
      <div v-else class="table-scroll">
        <table class="account-table">
          <thead><tr><th>账号</th><th>可用</th><th>冷却</th><th>进行中</th><th>失败</th><th>权重</th><th>最近成功</th></tr></thead>
          <tbody>
            <tr v-for="(row, index) in poolAccounts" :key="index">
              <td class="mono">{{ row.label ?? '—' }}</td>
              <td>{{ row.available ? '是' : '否' }}</td>
              <td class="cell-secondary">{{ row.cooling ? `${row.cooldownMin ?? 0} 分钟` : '—' }}</td>
              <td class="cell-secondary">{{ row.inFlight ?? 0 }}</td>
              <td class="cell-secondary">{{ row.failures ?? 0 }}</td>
              <td class="cell-secondary">{{ row.weight ?? 1 }}</td>
              <td class="cell-secondary">{{ formatTime(row.lastSuccess as string | null) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="pool" class="inline-hint">
        进行中 {{ formatNumber(Number(pool.stickySessions ?? 0)) }} 个会话 · topN {{ (pool.pool as Record<string, unknown>)?.topN ?? '—' }}
      </p>
    </section>

    <section class="section-panel">
      <div class="section-heading">
        <RefreshCw :size="20" />
        <div><h2>额度明细</h2><p>来自服务的 /quota，会实时刷新上游套餐。</p></div>
        <button class="button" :disabled="loading === 'quota'" @click="loadQuota">刷新</button>
      </div>
      <div v-if="!quota.length" class="empty-filter"><h3>暂无额度数据</h3></div>
      <div v-else class="table-scroll">
        <table class="account-table">
          <thead><tr><th>账号</th><th>套餐</th><th>错误</th></tr></thead>
          <tbody>
            <tr v-for="(row, index) in quota" :key="index">
              <td class="mono">{{ row.label ?? '—' }}</td>
              <td class="cell-secondary">
                {{ Array.isArray(row.plans) ? row.plans.length : 0 }} 个套餐 · {{ Array.isArray(row.balances) ? row.balances.length : 0 }} 个余额
              </td>
              <td class="cell-secondary">{{ row.error ?? '—' }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section v-if="selftest" class="section-panel">
      <div class="section-heading">
        <Zap :size="20" />
        <div><h2>最近一次探测</h2><p>探测使用第一个启用账号。</p></div>
      </div>
      <div class="code-block"><pre>{{ JSON.stringify(selftest, null, 2) }}</pre></div>
    </section>
  </section>
</template>

<style scoped>
.zc-bars {
  display: flex;
  align-items: flex-end;
  gap: 3px;
  height: 110px;
  padding: 0 23px 18px;
}
.zc-bar-slot {
  flex: 1;
  height: 100%;
  display: flex;
  align-items: flex-end;
}
.zc-bar-slot i {
  display: block;
  width: 100%;
  background: var(--primary);
  border-radius: 2px 2px 0 0;
  opacity: 0.7;
}
</style>

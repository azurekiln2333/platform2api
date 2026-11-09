<script setup lang="ts">
import { computed } from 'vue'
import { CircleAlert, UsersRound, Wallet } from '@lucide/vue'
import SystemBadge from './SystemBadge.vue'
import {
  formatNumber,
  formatPercent,
  healthLabel,
  healthTone,
  systemMeta,
  type SystemCard,
} from '../systems.ts'

const props = defineProps<{ card: SystemCard }>()
const meta = computed(() => systemMeta(props.card.system))
const quota = computed(() => props.card.quota)
const percent = computed(() => {
  const value = quota.value
  if (!value || value.total == null || value.total <= 0) return null
  const used = value.used ?? 0
  return Math.max(0, Math.min(100, (used / value.total) * 100))
})
const detailMetrics = computed(() => quota.value?.metrics ?? [])
const syncedAt = computed(() => {
  const at = quota.value?.syncedAt
  if (!at) return ''
  const date = new Date(at)
  return Number.isNaN(date.getTime())
    ? ''
    : date.toLocaleString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
})
const accounts = computed(() => props.card.accounts)
const openRoute = computed(() => `#${props.card.system}/overview`)
</script>

<template>
  <article
    class="quota-card"
    :data-system="card.system"
    :data-testid="`overview-card-${card.system}`"
  >
    <header class="quota-card-header">
      <div class="quota-card-title">
        <SystemBadge :system="card.system" />
        <div>
          <strong>{{ meta.label }}</strong>
          <small>{{ meta.service }}</small>
        </div>
      </div>
      <span
        class="status-dot"
        :class="healthTone(card.health)"
        :data-testid="`health-${card.system}`"
      >
        {{ healthLabel(card.health) }}
      </span>
    </header>

    <p v-if="card.error" class="quota-error-text" :data-testid="`overview-error-${card.system}`">
      <CircleAlert :size="15" />{{ card.error }}
    </p>
    <template v-else>
      <div class="quota-card-metric" data-testid="overview-quota">
        <span class="eyebrow"><Wallet :size="13" />{{ quota?.label ?? '额度' }}</span>
        <p v-if="quota" class="quota-numbers">
          <strong
            >{{ formatNumber(quota.remaining, 1) }}<small>{{ quota.unit }}</small></strong
          >
          <span>剩余 / 共 {{ formatNumber(quota.total, 1) }}{{ quota.unit }}</span>
        </p>
        <p v-else class="unsynced"><small>该系统尚未上报额度</small></p>
        <div v-if="quota && percent !== null" class="quota-track">
          <i :style="{ width: `${percent}%` }" :class="{ low: percent >= 85 }" />
        </div>
        <p v-if="quota && percent !== null" class="quota-updated">
          已用 {{ formatPercent(percent) }} · 已用 {{ formatNumber(quota.used, 1) }}{{ quota.unit }}
        </p>
        <ul v-if="detailMetrics.length" class="quota-metrics">
          <li v-for="metric in detailMetrics" :key="metric.label">
            <span>{{ metric.label }}</span>
            <strong
              >{{ formatNumber(metric.remaining, 1) }}<small>{{ metric.unit }}</small></strong
            >
          </li>
        </ul>
        <p v-if="quota?.note" class="cell-secondary">{{ quota.note }}</p>
        <p v-if="syncedAt" class="quota-updated">同步于 {{ syncedAt }}</p>
      </div>

      <div class="quota-card-usage">
        <span class="eyebrow"><UsersRound :size="13" />账号与用量</span>
        <p v-if="accounts" class="quota-numbers">
          <strong>{{ formatNumber(accounts.total) }}</strong>
          <span
            >可用 {{ formatNumber(accounts.ready) }} / 共 {{ formatNumber(accounts.total) }}</span
          >
        </p>
        <p v-else class="unsynced"><small>未上报账号统计</small></p>
        <dl v-if="card.usage.length" class="quota-usage-list">
          <div v-for="metric in card.usage" :key="metric.label">
            <dt>{{ metric.label }}</dt>
            <dd>{{ formatNumber(metric.value, metric.digits ?? 0) }}{{ metric.unit ?? '' }}</dd>
          </div>
        </dl>
      </div>
    </template>

    <footer class="quota-card-footer">
      <span v-if="card.generatedAt" class="cell-secondary">
        更新于
        {{ new Date(card.generatedAt).toLocaleTimeString('zh-CN', { hour12: false }) }}
      </span>
      <span v-else class="cell-secondary">独立统计，不与其他系统合并</span>
      <a class="text-link" :href="openRoute">进入 {{ meta.label }} 管理</a>
    </footer>
  </article>
</template>

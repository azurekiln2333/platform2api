<script setup lang="ts">
import { computed } from 'vue'
import { LayoutDashboard, LoaderCircle, RefreshCw, ServerCog } from '@lucide/vue'
import QuotaCard from '../components/QuotaCard.vue'
import {
  OVERVIEW_POLL_MS,
  accountsLoading,
  cards,
  lastUpdated,
  overviewLoading,
  refreshAccounts,
  refreshOverview,
  refreshError,
} from '../panel.ts'

const emit = defineEmits<{ navigate: [id: string] }>()
const available = computed(() => cards.value.filter((card) => card.available).length)
const failed = computed(() => cards.value.length - available.value)
const pollSeconds = Math.round(OVERVIEW_POLL_MS / 1000)

function refresh() {
  void refreshOverview()
  void refreshAccounts()
}
</script>

<template>
  <section>
    <header class="page-heading">
      <div>
        <span class="eyebrow"><i class="blue-line" /> OVERVIEW</span>
        <h1>
          运行概览<span class="heading-count" data-testid="system-count">{{ available }}/3</span>
        </h1>
        <p>三家系统的额度、账号与用量各自独立展示；面板不会把它们相加或换算成同一种单位。</p>
      </div>
      <div class="heading-actions">
        <button class="button" :disabled="overviewLoading" @click="refresh">
          <RefreshCw :size="15" :class="{ spin: overviewLoading }" /><span>立即刷新</span>
        </button>
        <button class="button primary" @click="emit('navigate', '#accounts')">
          <ServerCog :size="15" /><span>账号管理</span>
        </button>
      </div>
    </header>

    <div v-if="refreshError" class="error-banner" role="alert">
      <ServerCog :size="16" /><span>{{ refreshError }}。一个系统不可用不影响其他系统。</span>
      <button @click="refresh">重试</button>
    </div>

    <div v-if="overviewLoading && !cards.length" class="page-loading">
      <LoaderCircle :size="24" class="spin" /><span>正在读取三家系统的概览…</span>
    </div>
    <div v-else class="quota-cards" data-testid="quota-cards">
      <QuotaCard v-for="card in cards" :key="card.system" :card="card" />
    </div>

    <p v-if="!overviewLoading && failed" class="inline-hint overview-note">
      <LayoutDashboard :size="14" /><span
        >{{ failed }} 家系统的概览暂不可用，其他系统数据不受影响；请检查对应服务的容器状态。</span
      >
    </p>
    <p v-else-if="lastUpdated" class="cell-secondary overview-note">
      每 {{ pollSeconds }} 秒自动刷新 · 最近更新
      {{ lastUpdated.toLocaleTimeString('zh-CN', { hour12: false }) }}
    </p>
    <p v-if="accountsLoading" class="cell-secondary overview-note">
      <LoaderCircle :size="12" class="spin" /> 正在同步账号列表…
    </p>
  </section>
</template>

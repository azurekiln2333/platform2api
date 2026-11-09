<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import {
  KeyRound,
  LoaderCircle,
  RefreshCw,
  Search,
  Tag,
  UsersRound,
  X,
  CircleAlert,
} from '@lucide/vue'
import AuthFlowDialog from '../components/AuthFlowDialog.vue'
import SystemBadge from '../components/SystemBadge.vue'
import TagEditor from '../components/TagEditor.vue'
import { accounts, accountsErrors, accountsLoading, refreshAccounts } from '../panel.ts'
import {
  SYSTEMS,
  allTags,
  countBySystem,
  filterAccounts,
  formatNumber,
  formatPercent,
  normalizeTags,
  quotaPercent,
  statusLabel,
  statusTone,
  systemMeta,
} from '../systems.ts'
import type { PanelAccount, SystemId } from '../types.ts'

const emit = defineEmits<{ navigate: [hash: string] }>()

const query = ref('')
const system = ref<SystemId | 'all'>('all')
const tag = ref('')
const dialog = ref<{ system: SystemId; accountId?: string; accountLabel?: string } | null>(null)
const editing = ref<PanelAccount | null>(null)

const knownTags = computed(() => allTags(accounts.value))
const counts = computed(() => countBySystem(accounts.value))
const visible = computed(() =>
  filterAccounts(accounts.value, { system: system.value, tag: tag.value, query: query.value }),
)
const filtersActive = computed(
  () => system.value !== 'all' || Boolean(tag.value) || Boolean(query.value.trim()),
)

function reload() {
  void refreshAccounts({ system: system.value })
}

function clearFilters() {
  query.value = ''
  system.value = 'all'
  tag.value = ''
}

function openAuth(nextSystem: SystemId, account?: PanelAccount) {
  dialog.value = {
    system: nextSystem,
    accountId: account?.id,
    accountLabel: account?.label,
  }
}

function authorized() {
  void refreshAccounts()
}

function openSystemPage(account: PanelAccount) {
  emit('navigate', `#${account.system}/accounts`)
}

function editTags(account: PanelAccount) {
  editing.value = account
}

watch(system, () => reload())
onMounted(() => {
  void refreshAccounts()
})
</script>

<template>
  <section>
    <header class="page-heading">
      <div>
        <span class="eyebrow"><i class="blue-line" /> ACCOUNTS</span>
        <h1>
          账号管理<span class="heading-count">{{ visible.length }} / {{ accounts.length }}</span>
        </h1>
        <p>
          三家系统的账号在同一张表里，用系统标签区分；授权、标签与刷新都在这里完成，账号数据仍由各系统自己保存。
        </p>
      </div>
      <div class="heading-actions">
        <button
          v-for="item in SYSTEMS"
          :key="item.id"
          class="button"
          :data-testid="`authorize-${item.id}`"
          @click="openAuth(item.id)"
        >
          <KeyRound :size="15" /><span>{{ item.label }} 授权</span>
        </button>
      </div>
    </header>

    <div
      v-if="accountsErrors.length"
      class="error-banner"
      role="alert"
      data-testid="accounts-errors"
    >
      <CircleAlert :size="16" />
      <span>该系统账号读取失败，其余系统不受影响：</span>
      <span v-for="item in accountsErrors" :key="item.system" class="account-error-item">
        <SystemBadge :system="item.system" compact />{{ item.error.message ?? '读取失败' }}
      </span>
      <button @click="reload">重试</button>
    </div>

    <div class="section-panel" data-testid="accounts-panel">
      <div class="table-toolbar">
        <label class="search-field">
          <Search :size="15" />
          <input
            v-model="query"
            type="search"
            placeholder="搜索账号名称或 ID"
            aria-label="搜索账号"
          />
        </label>
        <div class="toolbar-filters">
          <div class="segmented" role="group" aria-label="按系统筛选">
            <button
              :class="{ active: system === 'all' }"
              data-testid="filter-all"
              @click="system = 'all'"
            >
              全部 <span>{{ accounts.length }}</span>
            </button>
            <button
              v-for="item in SYSTEMS"
              :key="item.id"
              :class="{ active: system === item.id }"
              :data-testid="`filter-${item.id}`"
              @click="system = item.id"
            >
              {{ item.label }} <span>{{ counts[item.id] }}</span>
            </button>
          </div>
          <div class="select-wrap">
            <Tag :size="14" />
            <select v-model="tag" aria-label="按标签筛选" data-testid="tag-filter">
              <option value="">所有标签</option>
              <option v-for="item in knownTags" :key="item" :value="item">{{ item }}</option>
            </select>
          </div>
          <button class="icon-button table-refresh" aria-label="刷新账号列表" @click="reload">
            <RefreshCw :size="15" :class="{ spin: accountsLoading }" />
          </button>
        </div>
      </div>

      <div v-if="accountsLoading && !accounts.length" class="page-loading">
        <LoaderCircle :size="22" class="spin" /><span>正在读取账号列表…</span>
      </div>

      <div v-else-if="!visible.length" class="pool-empty">
        <div class="empty-illustration">
          <div class="empty-main"><UsersRound :size="26" /></div>
        </div>
        <h2>{{ filtersActive ? '没有匹配的账号' : '还没有账号' }}</h2>
        <p>
          {{
            filtersActive
              ? '调整系统或标签筛选条件，或清空搜索关键字。'
              : '从上方选择一家系统开始授权；授权流程由该系统自己完成，面板只负责发起与查询。'
          }}
        </p>
        <button v-if="filtersActive" class="button" @click="clearFilters">
          <X :size="14" /><span>清空筛选</span>
        </button>
      </div>

      <div v-else class="table-scroll">
        <table class="account-table" data-testid="accounts-table">
          <thead>
            <tr>
              <th>系统</th>
              <th>账号</th>
              <th>状态</th>
              <th>额度</th>
              <th>标签</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="account in visible" :key="account.id" :data-testid="`account-${account.id}`">
              <td><SystemBadge :system="account.system" /></td>
              <td>
                <div class="account-identity">
                  <div>
                    <strong class="account-name">{{ account.label }}</strong>
                    <span class="account-repo"
                      ><span>{{ account.id }}</span></span
                    >
                  </div>
                </div>
                <span v-if="account.detail" class="cell-secondary">{{ account.detail }}</span>
                <span v-if="account.error" class="cell-secondary account-health-error">{{
                  account.error
                }}</span>
              </td>
              <td>
                <span
                  class="status-badge"
                  :class="statusTone(account.status)"
                  :data-testid="`status-${account.id}`"
                >
                  <i />{{ statusLabel(account.status) }}
                </span>
              </td>
              <td>
                <template v-if="account.quota">
                  <p class="quota-numbers">
                    <strong>{{ formatNumber(account.quota.remaining, 1) }}</strong>
                    <span>{{ account.quota.unit ?? '' }}</span>
                  </p>
                  <div v-if="quotaPercent(account.quota) !== null" class="quota-track">
                    <i
                      :style="{ width: `${quotaPercent(account.quota)}%` }"
                      :class="{ low: (quotaPercent(account.quota) ?? 0) >= 85 }"
                    />
                  </div>
                  <span class="quota-updated"
                    >已用 {{ formatPercent(quotaPercent(account.quota)) }} ·
                    {{ formatNumber(account.quota.used, 1) }}{{ account.quota.unit ?? '' }}</span
                  >
                </template>
                <span v-else class="cell-secondary">未上报</span>
              </td>
              <td>
                <div class="tag-cell">
                  <div class="tag-chips compact">
                    <span class="tag-chip system">{{ account.system }}</span>
                    <span
                      v-for="item in normalizeTags(account.tags)"
                      :key="item"
                      class="tag-chip"
                      data-testid="tag-chip"
                      >{{ item }}</span
                    >
                  </div>
                  <button class="button tag-edit" @click="editTags(account)">
                    <Tag :size="12" /><span>编辑标签</span>
                  </button>
                </div>
              </td>
              <td>
                <div class="row-actions">
                  <button class="button" @click="openAuth(account.system, account)">
                    <KeyRound :size="13" /><span>授权</span>
                  </button>
                  <button class="button" @click="openSystemPage(account)">
                    <span>{{ systemMeta(account.system).label }} 管理</span>
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <AuthFlowDialog
      v-if="dialog"
      :system="dialog.system"
      :account-id="dialog.accountId"
      :account-label="dialog.accountLabel"
      @close="dialog = null"
      @authorized="authorized"
    />
    <TagEditor v-if="editing" :account="editing" :known-tags="knownTags" @close="editing = null" />
  </section>
</template>

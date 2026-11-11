<script setup lang="ts">
import { computed, defineAsyncComponent, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { LayoutGrid, List, LoaderCircle, MoreHorizontal, Plus, RefreshCw } from '@lucide/vue'
import { consoleApi } from '../api.ts'
import { channels, channelLabel, loadChannels, query, setQuery, absoluteTime } from '../console.ts'
import { notify } from '../panel.ts'
import { statusLabel, statusTone } from '../systems.ts'
import type { Account, Action, AggregateError, Descriptor } from '../console-types.ts'
import ChannelFilter from '../components/ChannelFilter.vue'
import PartialErrors from '../components/PartialErrors.vue'
import DescriptorList from '../components/DescriptorList.vue'
import RelativeTime from '../components/RelativeTime.vue'
import CopyButton from '../components/CopyButton.vue'
import QuotaBar from '../components/QuotaBar.vue'
import SystemBadge from '../components/SystemBadge.vue'
import ModalShell from '../components/ModalShell.vue'
import AuthFlowDialog from '../components/AuthFlowDialog.vue'
import TagEditor from '../components/TagEditor.vue'

const accounts = ref<Account[]>([])
const errors = ref<AggregateError[]>([])
const error = ref('')
const loading = ref(false)
const view = ref<'cards' | 'list'>(
  localStorage.getItem('platform-account-view') === 'list' ? 'list' : 'cards',
)
const selected = ref<string[]>([])
const detailId = ref('')
const tagging = ref<Account | null>(null)
const adding = ref(false)
const addSystem = ref('')
const nativeEditor = ref<{ system: string; account: Account | null; mode: string } | null>(null)
const auth = ref<{ system: string; accountId?: string; accountLabel?: string } | null>(null)
const operation = ref<{ action: Action; items: Account[]; tags: string } | null>(null)
const busy = ref(false)
const operationError = ref('')
const actionResult = ref<{
  account: Account
  label: string
  display: Descriptor[]
  pending?: boolean
} | null>(null)
const resultsByAccount = ref<
  Record<string, { label: string; display: Descriptor[]; pending?: boolean }>
>({})
const resultTimers = new Map<string, number>()
let generation = 0
let alive = true
const loaders = import.meta.glob('../channels/*/AccountEditor.vue')
const editors = Object.fromEntries(
  Object.entries(loaders).map(([path, loader]) => [
    path.split('/')[2],
    defineAsyncComponent(loader as () => Promise<{ default: import('vue').Component }>),
  ]),
)
const detail = computed(() => accounts.value.find((item) => item.id === detailId.value))
const counts = computed(() =>
  accounts.value.reduce<Record<string, number>>((result, item) => {
    result[item.system] = (result[item.system] || 0) + 1
    return result
  }, {}),
)
const knownTags = computed(() =>
  [...new Set(accounts.value.flatMap((item) => item.tags || []))].sort(),
)
const matching = computed(() =>
  accounts.value.filter((item) => {
    const status = !item.enabled
      ? 'disabled'
      : ['healthy', 'ready', 'ok', 'active'].includes(item.status)
        ? 'ok'
        : ['cooldown', 'cooling'].includes(item.status)
          ? 'cooling'
          : 'error'
    return (
      (!query.value.system || item.system === query.value.system) &&
      (!query.value.status || query.value.status === status) &&
      (!query.value.tag || item.tags.includes(query.value.tag)) &&
      (!query.value.q ||
        `${item.label} ${item.id} ${item.tags.join(' ')}`
          .toLowerCase()
          .includes(query.value.q.toLowerCase()))
    )
  }),
)
const chosen = computed(() => matching.value.filter((item) => selected.value.includes(item.id)))
const batch = computed(() => {
  const supported = chosen.value.map(
    (item) =>
      channels.value.find((channel) => channel.system === item.system)?.capabilities.accounts
        .batch || [],
  )
  return supported.length
    ? ['enable', 'disable', 'probe', 'tags', 'delete'].filter((action) =>
        supported.every((list) => list.includes(action)),
      )
    : []
})
const actionLabel: Record<string, string> = {
  enable: '启用',
  disable: '停用',
  probe: '探测',
  tags: '打标签',
  delete: '删除',
}
const flowLabel: Record<string, string> = {
  oauth: '登录授权',
  authorize: '登录授权',
  auth: '登录授权',
  onboard: '登录授权',
  manual: '填写凭据',
  credentials: '填写或导入凭据',
  import: '导入刷新令牌',
  'refresh-import': '导入刷新令牌',
  'refresh-token': '导入刷新令牌',
  upload: '上传凭证文件',
  files: '上传凭证文件',
}
const addChannel = computed(() => channels.value.find((item) => item.system === addSystem.value))
function online(health: string) {
  return !['offline', 'down', 'error', 'unknown'].includes(health)
}
async function reload() {
  const request = ++generation
  loading.value = true
  try {
    const result = await consoleApi.accounts()
    if (!alive || request !== generation) return
    accounts.value = result.items.map((item) => ({
      ...item,
      enabled: item.enabled !== false && item.status !== 'disabled',
      tags: item.tags || [],
      display: item.display || [],
      actions: item.actions || [],
    }))
    errors.value = result.errors || []
    error.value = ''
    selected.value = selected.value.filter((id) => accounts.value.some((item) => item.id === id))
  } catch (cause) {
    if (alive && request === generation)
      error.value = cause instanceof Error ? cause.message : '读取账号失败'
  } finally {
    if (alive && request === generation) loading.value = false
  }
}
function toggleSelection(id: string) {
  selected.value = selected.value.includes(id)
    ? selected.value.filter((value) => value !== id)
    : [...selected.value, id]
}
function availableActions(item: Account): Action[] {
  const actions = [...item.actions]
  if (editors[item.system] && !actions.some((action) => action.id === 'edit'))
    actions.unshift({ id: 'edit', label: '编辑账号' })
  const supported =
    channels.value.find((channel) => channel.system === item.system)?.capabilities.accounts.batch ||
    []
  const toggle = item.enabled ? 'disable' : 'enable'
  if (supported.includes(toggle) && !actions.some((action) => action.id === toggle))
    actions.push({
      id: toggle,
      label: item.enabled ? '停用账号' : '启用账号',
      danger: item.enabled,
    })
  if (supported.includes('delete') && !actions.some((action) => action.id === 'delete'))
    actions.push({ id: 'delete', label: '删除账号', danger: true })
  return actions
}
function openAdd() {
  addSystem.value = query.value.system || ''
  adding.value = true
}
function beginAdd(kind: string) {
  if (!addChannel.value) return
  if (/import|token|upload|file|credentials/.test(kind) && editors[addSystem.value])
    nativeEditor.value = { system: addSystem.value, account: null, mode: kind }
  else if (kind === 'oauth' && editors[addSystem.value])
    nativeEditor.value = { system: addSystem.value, account: null, mode: 'oauth' }
  else auth.value = { system: addSystem.value }
  adding.value = false
}
function run(item: Account, action: Action) {
  if (busy.value) return
  if (action.id === 'edit' && editors[item.system]) {
    nativeEditor.value = { system: item.system, account: item, mode: 'edit' }
    return
  }
  if (['authorize', 'auth', 'reauthorize'].includes(action.id)) {
    auth.value = {
      system: item.system,
      accountId: item.id.slice(item.id.indexOf(':') + 1),
      accountLabel: item.label,
    }
    return
  }
  if (['claim', 'claim-start'].includes(action.id) && editors[item.system]) {
    nativeEditor.value = { system: item.system, account: item, mode: action.id }
    return
  }
  if (action.id === 'tags') {
    tagging.value = item
    return
  }
  operation.value = { action, items: [item], tags: '' }
  operationError.value = ''
  if (
    !action.danger &&
    !action.confirm &&
    !['delete', 'disable', 'reset-usage', 'rotate'].includes(action.id)
  )
    void execute()
}
function runBatch(action: string) {
  operation.value = {
    action: {
      id: action,
      label: actionLabel[action] || action,
      danger: ['delete', 'disable'].includes(action),
    },
    items: [...chosen.value],
    tags: '',
  }
  operationError.value = ''
}
async function execute() {
  if (!operation.value || busy.value) return
  busy.value = true
  operationError.value = ''
  const current = operation.value
  const failed: Account[] = []
  const messages: string[] = []
  for (const item of current.items) {
    try {
      if (current.action.id === 'delete') await consoleApi.deleteAccount(item.id)
      else if (current.action.id === 'enable' || current.action.id === 'disable')
        await consoleApi.updateAccount(item.id, { enabled: current.action.id === 'enable' })
      else if (current.action.id === 'tags')
        await consoleApi.saveAccountTags(item.id, [
          ...new Set([
            ...item.tags,
            ...current.tags
              .split(/[,，\n]/)
              .map((tag) => tag.trim())
              .filter(Boolean),
          ]),
        ])
      else {
        const result = await consoleApi.accountAction(item.id, current.action.id)
        if (result && typeof result === 'object') {
          const body = result as Record<string, unknown>
          const resultDisplay: Descriptor[] = [
            { key: 'at', label: '操作时间', kind: 'time', value: new Date().toISOString() },
            ...['message', 'summary', 'error']
              .filter((key) => typeof body[key] === 'string')
              .map((key) => ({
                key,
                label: key === 'error' ? '错误' : key === 'summary' ? '结果' : '说明',
                kind: 'text' as const,
                value: body[key],
              })),
          ]
          resultsByAccount.value[item.id] = { label: current.action.label, display: resultDisplay }
          if (Array.isArray(body.display))
            resultsByAccount.value[item.id].display.push(...(body.display as Descriptor[]))
          if (typeof body.jobId === 'string') {
            resultsByAccount.value[item.id].pending = true
            pollResult(item, body.jobId, 0)
          } else if (typeof body.message === 'string') notify(body.message)
          if (current.items.length === 1)
            actionResult.value = { account: item, ...resultsByAccount.value[item.id] }
        }
      }
    } catch (cause) {
      failed.push(item)
      messages.push(`${item.label}：${cause instanceof Error ? cause.message : '操作失败'}`)
    }
  }
  busy.value = false
  if (failed.length) {
    current.items = failed
    operationError.value = messages.join('\n')
  } else {
    operation.value = null
    selected.value = []
    notify(`${current.action.label}已完成`)
  }
  await reload()
}
function pollResult(account: Account, jobId: string, attempt: number) {
  window.clearTimeout(resultTimers.get(account.id))
  resultTimers.set(
    account.id,
    window.setTimeout(async () => {
      if (!alive || !resultsByAccount.value[account.id]) return
      try {
        const body = (await consoleApi.accountAction(account.id, 'selftest-result', {
          jobId,
        })) as Record<string, unknown>
        if (!alive || !resultsByAccount.value[account.id]) return
        const savedResult = resultsByAccount.value[account.id]
        const done = body.status === 'done' || body.status === 'failed' || body.ok === true
        savedResult.display = [
          { key: 'at', label: '最近探测', kind: 'time', value: new Date().toISOString() },
          {
            key: 'status',
            label: '探测状态',
            kind: 'text',
            value: done ? (body.status === 'failed' ? '失败' : '已完成') : '处理中',
          },
          ...['message', 'error', 'summary']
            .filter((key) => typeof body[key] === 'string')
            .map((key) => ({
              key,
              label: key === 'error' ? '错误' : key === 'summary' ? '探测结果' : '说明',
              kind: 'text' as const,
              value: body[key],
            })),
        ]
        savedResult.pending = !done
        if (!done && attempt < 29) pollResult(account, jobId, attempt + 1)
        else {
          savedResult.pending = false
          if (!done)
            savedResult.display.push({
              key: 'timeout',
              label: '状态',
              kind: 'text',
              value: '探测仍在后台运行，可稍后刷新账号查看结果',
            })
          void reload()
        }
        if (actionResult.value?.account.id === account.id)
          actionResult.value = { account, ...savedResult }
      } catch (cause) {
        if (resultsByAccount.value[account.id]) {
          resultsByAccount.value[account.id].pending = false
          resultsByAccount.value[account.id].display = [
            {
              key: 'error',
              label: '读取失败',
              kind: 'text',
              value: cause instanceof Error ? cause.message : '读取探测结果失败',
            },
          ]
          if (actionResult.value?.account.id === account.id)
            actionResult.value = { account, ...resultsByAccount.value[account.id] }
        }
      }
    }, 2000),
  )
}
function nativeResult(result: { id: string; label: string; display: Descriptor[] }) {
  resultsByAccount.value[result.id] = { label: result.label, display: result.display }
}
function saved() {
  nativeEditor.value = null
  tagging.value = null
  void reload()
}
watch(view, (value) => localStorage.setItem('platform-account-view', value))
watch(
  () => [query.value.system, query.value.status, query.value.tag, query.value.q],
  () => {
    selected.value = []
  },
)
onMounted(() => {
  void loadChannels()
  void reload()
  if (query.value.add) openAdd()
})
onBeforeUnmount(() => {
  alive = false
  generation++
  for (const timer of resultTimers.values()) window.clearTimeout(timer)
})
</script>

<template>
  <section class="accounts-page">
    <header class="page-heading">
      <div>
        <span class="eyebrow">ACCOUNTS</span>
        <h1>
          账号 <span class="heading-count">{{ matching.length }}</span>
        </h1>
      </div>
      <div class="heading-actions">
        <button class="button" :disabled="loading" @click="reload">
          <RefreshCw :size="15" :class="{ spin: loading }" />刷新</button
        ><button class="button primary" @click="openAdd"><Plus :size="15" />添加账号</button>
      </div>
    </header>
    <PartialErrors :errors="errors" @retry="reload" />
    <div v-if="error" class="error-banner" role="alert">
      {{ error }}<button @click="reload">重试</button>
    </div>
    <section class="section-panel">
      <div class="table-toolbar accounts-toolbar">
        <ChannelFilter
          :channels="channels"
          :model-value="query.system || ''"
          :counts="counts"
          @update:model-value="setQuery({ system: $event })"
        />
        <template v-if="chosen.length"
          ><strong>已选择 {{ chosen.length }} 个账号</strong
          ><button
            v-for="action in batch"
            :key="action"
            class="button"
            :class="{ danger: action === 'delete' }"
            @click="runBatch(action)"
          >
            {{ actionLabel[action] }}</button
          ><span v-if="!batch.length" class="subtle">所选账号没有共同支持的批量操作</span
          ><button class="text-link" @click="selected = []">取消选择</button></template
        >
        <template v-else
          ><select
            :value="query.status || ''"
            aria-label="按状态筛选"
            @change="setQuery({ status: ($event.target as HTMLSelectElement).value })"
          >
            <option value="">所有状态</option>
            <option value="ok">正常</option>
            <option value="error">异常</option>
            <option value="disabled">已停用</option>
            <option value="cooling">冷却中</option></select
          ><select
            :value="query.tag || ''"
            aria-label="按标签筛选"
            data-testid="tag-filter"
            @change="setQuery({ tag: ($event.target as HTMLSelectElement).value })"
          >
            <option value="">所有标签</option>
            <option v-for="tag in knownTags" :key="tag">{{ tag }}</option></select
          ><input
            :value="query.q || ''"
            type="search"
            aria-label="搜索账号"
            placeholder="搜索账号名称或 ID"
            @input="setQuery({ q: ($event.target as HTMLInputElement).value })"
          />
          <div class="segmented" role="group" aria-label="账号视图">
            <button
              :class="{ active: view === 'cards' }"
              aria-label="卡片视图"
              :aria-pressed="view === 'cards'"
              @click="view = 'cards'"
            >
              <LayoutGrid :size="15" />卡片</button
            ><button
              :class="{ active: view === 'list' }"
              aria-label="列表视图"
              :aria-pressed="view === 'list'"
              @click="view = 'list'"
            >
              <List :size="15" />列表
            </button>
          </div></template
        >
      </div>
      <div v-if="loading && !accounts.length" class="page-loading" role="status">
        <LoaderCircle :size="20" class="spin" />正在读取账号…
      </div>
      <div v-else-if="!matching.length" class="pool-empty">
        <h2>{{ accounts.length ? '没有匹配的账号' : '还没有账号' }}</h2>
        <button
          v-if="accounts.length"
          class="button"
          @click="setQuery({ system: '', status: '', tag: '', q: '' })"
        >
          清空筛选</button
        ><button v-else class="button primary" @click="openAdd">添加账号</button>
      </div>
      <div v-else-if="view === 'cards'" class="account-grid" :aria-busy="loading">
        <article
          v-for="account in matching"
          :key="account.id"
          class="account-card"
          :data-testid="`account-${account.id}`"
          tabindex="0"
          @click="detailId = account.id"
          @keydown.enter.self="detailId = account.id"
        >
          <header>
            <input
              type="checkbox"
              :checked="selected.includes(account.id)"
              :aria-label="`选择账号 ${account.label}`"
              @click.stop
              @change="toggleSelection(account.id)"
            /><SystemBadge :system="account.system" /><strong>{{ account.label }}</strong
            ><span class="status-badge" :class="statusTone(account.status)">{{
              account.enabled ? statusLabel(account.status) : '已停用'
            }}</span>
          </header>
          <QuotaBar v-if="account.quota" :quota="account.quota" /><DescriptorList
            :items="(account.display || []).slice(0, 4)"
          />
          <footer @click.stop>
            <div class="tag-chips">
              <span v-for="tag in account.tags" :key="tag" class="tag-chip">{{ tag }}</span>
            </div>
            <button
              v-if="
                availableActions(account).some((action) =>
                  ['enable', 'disable'].includes(action.id),
                )
              "
              class="button"
              role="switch"
              :aria-checked="account.enabled"
              :aria-label="`${account.enabled ? '停用' : '启用'}账号 ${account.label}`"
              @click="
                run(account, {
                  id: account.enabled ? 'disable' : 'enable',
                  label: account.enabled ? '停用' : '启用',
                  danger: account.enabled,
                })
              "
            >
              {{ account.enabled ? '已启用' : '已停用' }}
            </button>
            <details class="account-menu">
              <summary :aria-label="`${account.label} 的更多操作`">
                <MoreHorizontal :size="18" />
              </summary>
              <div>
                <button class="button" @click="detailId = account.id">查看详情</button
                ><button class="button" @click="tagging = account">编辑标签</button
                ><button
                  v-for="action in availableActions(account)"
                  :key="action.id"
                  class="button"
                  :class="{ danger: action.danger }"
                  @click="run(account, action)"
                >
                  {{ action.label }}
                </button>
              </div>
            </details>
          </footer>
        </article>
      </div>
      <div v-else class="table-scroll" :aria-busy="loading">
        <table class="account-table" data-testid="accounts-table">
          <thead>
            <tr>
              <th>
                <input
                  type="checkbox"
                  :checked="chosen.length === matching.length"
                  aria-label="选择全部账号"
                  @change="
                    selected = ($event.target as HTMLInputElement).checked
                      ? matching.map((item) => item.id)
                      : []
                  "
                />
              </th>
              <th>渠道</th>
              <th>账号</th>
              <th>状态</th>
              <th>额度</th>
              <th>最近使用</th>
              <th>标签</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="account in matching"
              :key="account.id"
              :data-testid="`account-${account.id}`"
              tabindex="0"
              @click="detailId = account.id"
              @keydown.enter.self="detailId = account.id"
            >
              <td @click.stop>
                <input
                  type="checkbox"
                  :checked="selected.includes(account.id)"
                  :aria-label="`选择账号 ${account.label}`"
                  @change="toggleSelection(account.id)"
                />
              </td>
              <td><SystemBadge :system="account.system" /></td>
              <td>
                <strong>{{ account.label }}</strong>
                <div class="cell-secondary">
                  <template v-if="typeof account.primary === 'string'">{{
                    account.primary
                  }}</template
                  ><DescriptorList v-else-if="account.primary" :items="account.primary" />
                </div>
                <div class="account-id" @click.stop>
                  <code>{{ account.id }}</code
                  ><CopyButton :value="account.id" />
                </div>
              </td>
              <td>
                <span class="status-badge" :class="statusTone(account.status)">{{
                  account.enabled ? statusLabel(account.status) : '已停用'
                }}</span>
              </td>
              <td><QuotaBar v-if="account.quota" :quota="account.quota" /><span v-else>—</span></td>
              <td><RelativeTime :value="account.lastUsedAt || null" /></td>
              <td>
                <div class="tag-chips">
                  <span
                    v-for="tag in account.tags"
                    :key="tag"
                    class="tag-chip"
                    data-testid="tag-chip"
                    >{{ tag }}</span
                  >
                </div>
              </td>
              <td @click.stop>
                <div class="row-actions">
                  <button
                    class="button"
                    :aria-label="`编辑标签 ${account.label}`"
                    @click="tagging = account"
                  >
                    编辑标签</button
                  ><button
                    class="button"
                    :aria-label="`查看账号 ${account.label}`"
                    @click="detailId = account.id"
                  >
                    详情
                  </button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
    <ModalShell
      v-if="detail"
      :title="`账号「${detail.label}」（${channelLabel(detail.system)}）`"
      drawer
      @close="detailId = ''"
      ><div class="modal-body">
        <SystemBadge :system="detail.system" />
        <p class="account-id">
          <code>{{ detail.id }}</code
          ><CopyButton :value="detail.id" />
        </p>
        <QuotaBar v-if="detail.quota" :quota="detail.quota" />
        <div v-for="(quota, index) in detail.quota?.metrics || []" :key="index">
          <h3>{{ quota.label || '额度明细' }}</h3>
          <QuotaBar :quota="quota" />
        </div>
        <DescriptorList :items="detail.display || []" absolute />
        <section v-if="resultsByAccount[detail.id]">
          <h3>{{ resultsByAccount[detail.id].label }}</h3>
          <p v-if="resultsByAccount[detail.id].pending" role="status">正在探测…</p>
          <DescriptorList :items="resultsByAccount[detail.id].display" absolute />
        </section>
        <p class="subtle">最近使用：{{ absoluteTime(detail.lastUsedAt) }}</p>
        <div class="button-group account-detail-actions">
          <button class="button" @click="tagging = detail">编辑标签</button
          ><button
            v-for="action in availableActions(detail)"
            :key="action.id"
            class="button"
            :class="{ danger: action.danger }"
            @click="run(detail, action)"
          >
            {{ action.label }}
          </button>
        </div>
      </div></ModalShell
    >
    <ModalShell v-if="adding" title="添加账号" @close="adding = false"
      ><div class="modal-body">
        <h3>1 · 选择渠道</h3>
        <div class="channel-picker">
          <label
            v-for="channel in channels"
            :key="channel.system"
            :class="{ unavailable: !online(channel.health) }"
            ><input
              v-model="addSystem"
              type="radio"
              :value="channel.system"
              :disabled="!online(channel.health) || !channel.capabilities.accounts.add.length"
            /><SystemBadge :system="channel.system" /><span>{{ channel.label }}</span
            ><small v-if="!online(channel.health)">{{ channel.detail || '暂时不可达' }}</small
            ><small v-else-if="!channel.capabilities.accounts.add.length"
              >当前版本不支持添加账号</small
            ></label
          >
        </div>
        <template v-if="addChannel"
          ><h3>2 · 选择添加方式</h3>
          <div class="button-group">
            <button
              v-for="kind in addChannel.capabilities.accounts.add"
              :key="kind"
              class="button primary"
              :disabled="!online(addChannel.health)"
              @click="beginAdd(kind)"
            >
              {{ flowLabel[kind] || '开始授权' }}
            </button>
          </div></template
        >
      </div></ModalShell
    >
    <AuthFlowDialog
      v-if="auth"
      :system="auth.system"
      :account-id="auth.accountId"
      :account-label="auth.accountLabel"
      @close="auth = null"
      @authorized="reload"
    />
    <component
      :is="editors[nativeEditor.system]"
      v-if="nativeEditor && editors[nativeEditor.system]"
      :account="nativeEditor.account"
      :mode="nativeEditor.mode"
      @close="nativeEditor = null"
      @saved="saved"
      @result="nativeResult"
    />
    <ModalShell
      v-if="actionResult"
      :title="`${actionResult.label} · ${actionResult.account.label}`"
      @close="actionResult = null"
      ><div class="modal-body">
        <SystemBadge :system="actionResult.account.system" />
        <p v-if="actionResult.pending" role="status">
          <LoaderCircle :size="15" class="spin" />正在探测…
        </p>
        <DescriptorList :items="actionResult.display" absolute /></div
    ></ModalShell>
    <TagEditor
      v-if="tagging"
      :account="tagging"
      :known-tags="knownTags"
      @close="tagging = null"
      @saved="saved"
    />
    <ModalShell
      v-if="operation"
      :title="`${operation.action.label}账号「${operation.items.map((item) => `${item.label}（${channelLabel(item.system)}）`).join('、')}」`"
      :busy="busy"
      @close="!busy && (operation = null)"
      ><form @submit.prevent="execute">
        <div class="modal-body">
          <p v-if="typeof operation.action.confirm === 'string'">{{ operation.action.confirm }}</p>
          <p v-else>请确认对以上账号执行「{{ operation.action.label }}」。</p>
          <label v-if="operation.action.id === 'tags'"
            >新增标签（逗号分隔）<input v-model="operation.tags" required :disabled="busy"
          /></label>
          <p v-if="operationError" class="form-error" role="alert">{{ operationError }}</p>
        </div>
        <footer class="modal-footer">
          <button class="button" type="button" :disabled="busy" @click="operation = null">
            取消</button
          ><button
            class="button"
            :class="operation.action.danger ? 'danger' : 'primary'"
            type="submit"
            :disabled="busy || (operation.action.id === 'tags' && !operation.tags.trim())"
          >
            <LoaderCircle v-if="busy" :size="15" class="spin" />{{
              busy ? '处理中…' : operation.action.label
            }}
          </button>
        </footer>
      </form></ModalShell
    >
  </section>
</template>

<style scoped>
.accounts-toolbar {
  flex-wrap: wrap;
  gap: 10px;
}
.accounts-toolbar > input {
  min-width: 160px;
  flex: 1;
}
.accounts-toolbar > select {
  max-width: 160px;
}
.account-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(min(300px, 100%), 1fr));
  gap: 14px;
  padding: 18px;
}
.account-card {
  border: 1px solid var(--line);
  border-radius: var(--radius-sm);
  padding: 16px;
  cursor: pointer;
  background: var(--surface);
}
.account-card:focus-visible {
  outline: 2px solid var(--primary);
}
.account-card > header {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
  margin-bottom: 16px;
}
.account-card > header strong {
  flex: 1;
  overflow-wrap: anywhere;
}
.account-card > footer {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 16px;
}
.account-card > footer .tag-chips {
  flex: 1;
}
.account-id {
  display: flex;
  align-items: center;
  gap: 6px;
  max-width: 320px;
}
.account-id code {
  overflow-wrap: anywhere;
  color: var(--muted);
  font-size: 11px;
}
.account-menu {
  position: relative;
}
.account-menu summary {
  list-style: none;
  padding: 6px;
  border: 1px solid var(--line);
  border-radius: 5px;
  cursor: pointer;
}
.account-menu > div {
  position: absolute;
  z-index: 5;
  right: 0;
  top: 100%;
  display: grid;
  min-width: 160px;
  padding: 8px;
  gap: 4px;
  background: var(--surface);
  border: 1px solid var(--line);
  border-radius: 8px;
  box-shadow: 0 5px 20px #0002;
}
.account-detail-actions {
  flex-wrap: wrap;
  margin-top: 20px;
}
.channel-picker {
  display: grid;
  gap: 8px;
}
.channel-picker label {
  display: flex;
  align-items: center;
  gap: 10px;
  border: 1px solid var(--line);
  padding: 12px;
  border-radius: 8px;
}
.channel-picker small {
  color: var(--muted);
}
.unavailable {
  opacity: 0.6;
}
.form-error {
  white-space: pre-line;
}
.accounts-page table tbody tr {
  cursor: pointer;
}
.accounts-page th:first-child,
.accounts-page td:first-child {
  position: sticky;
  left: 0;
  background: var(--surface);
  z-index: 1;
}
.account-card input[type='checkbox'],
.accounts-page table input[type='checkbox'] {
  width: 16px;
  height: 16px;
  min-height: 0;
}
.channel-picker input[type='radio'] {
  width: 16px;
  height: 16px;
  min-height: 0;
}
</style>

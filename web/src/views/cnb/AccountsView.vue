<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  CircleAlert,
  Copy,
  KeyRound,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  UsersRound,
  X,
  Zap,
} from '@lucide/vue'
import ModalShell from '../../components/ModalShell.vue'
import AccountEditor from './AccountEditor.vue'
import { copy, notify, reportError } from '../../panel.ts'
import { formatNumber, statusTone } from '../../systems.ts'
import { accountState, accountStateLabel, cnb, formatTime, modelsOf, quotaInfo } from './service.ts'
import type { CnbAccount, CnbModelEntry } from './types.ts'

const accounts = ref<CnbAccount[]>([])
const loading = ref(false)
const loaded = ref(false)
const error = ref('')
const busy = ref<string>('')
const query = ref('')

const editor = ref<CnbAccount | 'new' | null>(null)
const credentials = ref<{ account: CnbAccount; pat: string; proxyKey: string; registrationToken: string } | null>(null)
const confirmDelete = ref<CnbAccount | null>(null)

const visible = computed(() => {
  const text = query.value.trim().toLowerCase()
  if (!text) return accounts.value
  return accounts.value.filter((account) =>
    [account.name, account.repo ?? '', account.group ?? '', account.endpoint ?? '']
      .join(' ')
      .toLowerCase()
      .includes(text),
  )
})

async function refresh() {
  loading.value = true
  try {
    const result = await cnb<{ accounts: CnbAccount[] }>('/api/accounts')
    if (!Array.isArray(result.accounts)) throw new Error('CNB 账号列表格式不正确')
    accounts.value = result.accounts
    loaded.value = true
    error.value = ''
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '无法读取 CNB 账号列表'
  } finally {
    loading.value = false
  }
}

async function run(account: CnbAccount, action: string, success: string) {
  if (busy.value) return
  busy.value = `${account.id}:${action}`
  try {
    await cnb(`/api/accounts/${encodeURIComponent(account.id)}/${action}`, 'POST', {})
    notify(success)
    await refresh()
  } catch (cause) {
    reportError(cause, 'CNB 操作失败')
  } finally {
    busy.value = ''
  }
}

async function loadCredentials(account: CnbAccount) {
  busy.value = `${account.id}:credentials`
  try {
    const result = await cnb<{ pat?: string; proxyKey?: string; registrationToken?: string }>(
      `/api/accounts/${encodeURIComponent(account.id)}/credentials`,
      'POST',
      {},
    )
    credentials.value = {
      account,
      pat: result.pat ?? '',
      proxyKey: result.proxyKey ?? '',
      registrationToken: result.registrationToken ?? '',
    }
  } catch (cause) {
    reportError(cause, '读取账号凭据失败')
  } finally {
    busy.value = ''
  }
}

async function toggleEnabled(account: CnbAccount) {
  busy.value = `${account.id}:toggle`
  try {
    await cnb(`/api/accounts/${encodeURIComponent(account.id)}`, 'PATCH', {
      enabled: !account.enabled,
      ...(account.enabled ? {} : { quotaProtectionOverride: true }),
    })
    notify(account.enabled ? '账号已停用' : '账号已启用')
    await refresh()
  } catch (cause) {
    reportError(cause, '状态更新失败')
  } finally {
    busy.value = ''
  }
}

async function remove() {
  const account = confirmDelete.value
  if (!account) return
  try {
    await cnb(`/api/accounts/${encodeURIComponent(account.id)}`, 'DELETE')
    notify('账号已删除')
    confirmDelete.value = null
    await refresh()
  } catch (cause) {
    reportError(cause, '删除账号失败')
  }
}

onMounted(() => {
  void refresh()
})
</script>

<template>
  <section>
    <header class="page-heading">
      <div>
        <span class="eyebrow"><i class="blue-line" /> CNB ACCOUNTS</span>
        <h1>CNB 账号管理<span class="heading-count">{{ visible.length }} / {{ accounts.length }}</span></h1>
        <p>账号、注册密钥与额度都由 cnb2api 服务保存；面板只发起管理操作。</p>
      </div>
      <div class="heading-actions">
        <button class="button" :disabled="loading" @click="refresh">
          <RefreshCw :size="15" :class="{ spin: loading }" /><span>刷新</span>
        </button>
        <button class="button primary" @click="editor = 'new'">
          <Plus :size="15" /><span>新建账号</span>
        </button>
      </div>
    </header>

    <div v-if="error" class="error-banner" role="alert">
      <CircleAlert :size="16" /><span>{{ error }}</span>
      <button @click="refresh">重试</button>
    </div>

    <div class="section-panel">
      <div class="table-toolbar">
        <label class="search-field">
          <Search :size="15" />
          <input v-model="query" type="search" placeholder="搜索账号、仓库或工作区地址" aria-label="搜索 CNB 账号" />
        </label>
        <span class="subtle">{{ accounts.length }} 个账号</span>
      </div>

      <div v-if="loading && !loaded" class="page-loading">
        <LoaderCircle :size="20" class="spin" /><span>正在读取 CNB 账号…</span>
      </div>
      <div v-else-if="!visible.length" class="pool-empty">
        <UsersRound :size="26" />
        <h2>{{ query ? '没有匹配的账号' : '还没有 CNB 账号' }}</h2>
        <p>{{ query ? '更换关键字后重试。' : '新建账号并注册工作区后即可接入模型请求。' }}</p>
      </div>
      <div v-else class="table-scroll">
        <table class="account-table">
          <thead>
            <tr><th>账号</th><th>状态</th><th>额度</th><th>模型</th><th>权重/优先级</th><th>操作</th></tr>
          </thead>
          <tbody>
            <tr v-for="account in visible" :key="account.id">
              <td>
                <strong class="account-name">{{ account.name }}</strong>
                <span class="cnb-meta">{{ account.repo || '未填写仓库' }} · {{ account.branch || 'main' }}</span>
                <span class="cnb-meta">{{ account.endpoint || '尚未注册工作区' }}</span>
                <span v-if="account.lastError" class="cnb-meta cnb-error">{{ account.lastError }}</span>
              </td>
              <td>
                <span class="status-badge" :class="statusTone(accountState(account))"><i />{{ accountStateLabel(account) }}</span>
                <span class="cnb-meta">探活 {{ formatTime(account.checkedAt) }}</span>
              </td>
              <td>
                <template v-if="quotaInfo(account)">
                  <p class="quota-numbers">
                    <strong>{{ formatNumber(quotaInfo(account)?.remaining ?? null, 1) }}</strong><span>credits</span>
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
              <td>
                <span class="cell-secondary">{{ modelsOf(account).length }} 个</span>
                <p class="cnb-meta">{{ modelsOf(account).slice(0, 2).join('、') || '未配置' }}</p>
              </td>
              <td class="cell-secondary">{{ account.weight ?? 1 }} / {{ account.priority ?? 0 }}</td>
              <td>
                <div class="row-actions">
                  <button class="button" :disabled="busy === `${account.id}:probe`" @click="run(account, 'probe', '已发起探活')">
                    <Zap :size="13" /><span>探活</span>
                  </button>
                  <button class="button" :disabled="busy === `${account.id}:inference-probe`" @click="run(account, 'inference-probe', '已发起推理探活')">
                    推理探活
                  </button>
                  <button class="button" :disabled="busy === `${account.id}:quota`" @click="run(account, 'quota', '组织额度已同步')">
                    同步额度
                  </button>
                  <button class="button" :disabled="busy === `${account.id}:wake`" @click="run(account, 'wake', '已发起唤醒')">
                    唤醒
                  </button>
                  <button class="button" :disabled="busy === `${account.id}:registration`" @click="run(account, 'registration', '已生成新的注册密钥')">
                    注册密钥
                  </button>
                  <button class="button" :disabled="busy === `${account.id}:credentials`" @click="loadCredentials(account)">
                    <KeyRound :size="13" /><span>凭据</span>
                  </button>
                  <button class="button" @click="editor = account"><Pencil :size="13" /><span>编辑</span></button>
                  <button class="button" @click="toggleEnabled(account)">
                    {{ account.enabled ? '停用' : '启用' }}
                  </button>
                  <button class="button danger" @click="confirmDelete = account"><Trash2 :size="13" /></button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <AccountEditor
      v-if="editor"
      :account="editor === 'new' ? null : editor"
      @close="editor = null"
      @saved="
        () => {
          editor = null
          void refresh()
        }
      "
    />

    <ModalShell v-if="credentials" title="账号凭据" subtitle="凭据只存在于 CNB 服务的数据目录。" @close="credentials = null">
      <div class="modal-body">
        <p class="form-section-title">「{{ credentials.account.name }}」凭据</p>
        <div v-for="field in [
          { key: 'registrationToken', label: '注册密钥', value: credentials.registrationToken },
          { key: 'proxyKey', label: '工作区 PROXY_KEY', value: credentials.proxyKey },
          { key: 'pat', label: 'CNB 个人令牌', value: credentials.pat },
        ]" :key="field.key" class="copy-field">
          <span class="cell-secondary">{{ field.label }}</span>
          <code>{{ field.value || '未设置' }}</code>
          <button v-if="field.value" class="icon-button" :aria-label="`复制${field.label}`" @click="copy(field.value)">
            <Copy :size="14" />
          </button>
        </div>
      </div>
      <footer class="modal-footer">
        <span class="subtle">默认遮蔽显示，需要时手动复制。</span>
        <button class="button" @click="credentials = null">关闭</button>
      </footer>
    </ModalShell>

    <ModalShell v-if="confirmDelete" title="删除 CNB 账号" :subtitle="`删除「${confirmDelete.name}」后其注册密钥立即失效。`" @close="confirmDelete = null">
      <div class="modal-body">
        <p class="form-error"><CircleAlert :size="14" />工作区不会被删除，只会与面板断开。</p>
      </div>
      <footer class="modal-footer">
        <button class="button" @click="confirmDelete = null">取消</button>
        <button class="button danger" @click="remove"><Trash2 :size="14" /><span>删除账号</span></button>
      </footer>
    </ModalShell>
  </section>
</template>


<style scoped>
.cnb-meta {
  display: block;
  margin-top: 3px;
  color: var(--muted);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.cnb-error {
  color: var(--red);
}
.copy-field {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 0;
  border-bottom: 1px solid var(--line);
  overflow-wrap: anywhere;
}
.copy-field code {
  flex: 1;
  font-family: 'JetBrains Mono', monospace;
  font-size: 12px;
}
</style>

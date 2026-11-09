<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  CircleAlert,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  Search,
  ShieldCheck,
  UsersRound,
  Zap,
} from '@lucide/vue'
import ModalShell from '../../components/ModalShell.vue'
import AccountEditor from './AccountEditor.vue'
import { notify, reportError } from '../../panel.ts'
import { formatNumber, statusTone } from '../../systems.ts'
import { accountIdentity, accountState, accountStateLabel, formatTime, quotaInfo, zcode } from './service.ts'
import type { ZcodeAccount, ZcodeOverview } from './types.ts'

const accounts = ref<ZcodeAccount[]>([])
const loading = ref(false)
const loaded = ref(false)
const error = ref('')
const busy = ref('')
const query = ref('')
const editor = ref<ZcodeAccount | null>(null)
const claimDialog = ref<{ account: ZcodeAccount; preparation?: Record<string, unknown> } | null>(null)
const selftestDialog = ref<{ label: string; job: Record<string, unknown> | null; error: string } | null>(null)
const identify = ref('')

const visible = computed(() => {
  const text = query.value.trim().toLowerCase()
  if (!text) return accounts.value
  return accounts.value.filter((account) =>
    [account.label, account.name ?? '', accountIdentity(account)].join(' ').toLowerCase().includes(text),
  )
})

async function refresh() {
  loading.value = true
  try {
    const result = await zcode<ZcodeOverview>('/api/overview')
    if (!Array.isArray(result.accounts)) throw new Error('ZCode 账号列表格式不正确')
    accounts.value = result.accounts
    loaded.value = true
    error.value = ''
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '无法读取 ZCode 账号列表'
  } finally {
    loading.value = false
  }
}

async function act(account: ZcodeAccount, action: string, success: string, body: unknown = {}) {
  if (busy.value) return
  busy.value = `${account.label}:${action}`
  try {
    await zcode(`/api/accounts/${encodeURIComponent(account.label)}/${action}`, 'POST', body)
    notify(success)
    await refresh()
  } catch (cause) {
    reportError(cause, 'ZCode 账号操作失败')
  } finally {
    busy.value = ''
  }
}

async function startSelftest(account: ZcodeAccount) {
  if (busy.value) return
  busy.value = `${account.label}:selftest`
  try {
    const job = await zcode<Record<string, unknown>>(
      `/api/accounts/${encodeURIComponent(account.label)}/selftest`,
      'POST',
      {},
    )
    selftestDialog.value = { label: account.label, job, error: '' }
    void pollSelftest(account.label, String(job.jobId ?? ''))
  } catch (cause) {
    selftestDialog.value = {
      label: account.label,
      job: null,
      error: cause instanceof Error ? cause.message : '后台探测启动失败',
    }
    reportError(cause, '启动后台探测失败')
  } finally {
    busy.value = ''
  }
}

async function pollSelftest(label: string, jobId: string) {
  if (!jobId) return
  for (let attempt = 0; attempt < 30; attempt++) {
    await new Promise((resolve) => window.setTimeout(resolve, 2000))
    try {
      const job = await zcode<Record<string, unknown>>(
        `/api/accounts/${encodeURIComponent(label)}/selftest/${encodeURIComponent(jobId)}`,
      )
      if (selftestDialog.value?.label !== label) return
      selftestDialog.value = { label, job, error: '' }
      if (job.status === 'done' || job.status === 'failed' || job.ok === true) return
    } catch (cause) {
      if (selftestDialog.value?.label !== label) return
      selftestDialog.value = {
        label,
        job: selftestDialog.value?.job ?? null,
        error: cause instanceof Error ? cause.message : '探测结果读取失败',
      }
      return
    }
  }
}

async function openClaim(account: ZcodeAccount) {
  claimDialog.value = { account }
  busy.value = `${account.label}:claim-start`
  try {
    const preparation = await zcode<Record<string, unknown>>(
      `/api/accounts/${encodeURIComponent(account.label)}/claim/start`,
      'POST',
      { planId: preparePlanId.value },
    )
    if (claimDialog.value?.account.label === account.label) claimDialog.value = { account, preparation }
  } catch (cause) {
    notify(cause instanceof Error ? cause.message : '领取准备失败', true)
    claimDialog.value = null
  } finally {
    busy.value = ''
  }
}

const preparePlanId = ref('')

async function submitClaim(account: ZcodeAccount) {
  busy.value = `${account.label}:claim`
  try {
    const result = await zcode<{ results?: Array<Record<string, unknown>> }>(
      `/api/accounts/${encodeURIComponent(account.label)}/claim`,
      'POST',
      { planId: preparePlanId.value, preparationId: claimDialog.value?.preparation?.preparationId },
    )
    const first = result.results?.[0]
    notify(first?.ok ? '套餐已领取' : String(first?.msg ?? '领取未成功'), !first?.ok)
    claimDialog.value = null
    await refresh()
  } catch (cause) {
    reportError(cause, '领取套餐失败')
  } finally {
    busy.value = ''
  }
}

async function identifyAll() {
  busy.value = 'identify'
  try {
    const result = await zcode<Record<string, unknown>>('/accounts/identify', 'POST', {})
    identify.value = `已识别 ${formatNumber(Number(result.updated ?? result.count ?? 0))} 个账号身份`
    notify('已请求重新识别账号身份')
    await refresh()
  } catch (cause) {
    reportError(cause, '识别账号身份失败')
  } finally {
    busy.value = ''
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
        <span class="eyebrow"><i class="blue-line" /> ZCODE ACCOUNTS</span>
        <h1>ZCode 账号管理<span class="heading-count">{{ visible.length }} / {{ accounts.length }}</span></h1>
        <p>编辑身份、权重与 Coding Plan Key；刷新、探测与领取都在 ZCode 服务内执行。</p>
      </div>
      <div class="heading-actions">
        <button class="button" :disabled="loading" @click="refresh">
          <RefreshCw :size="15" :class="{ spin: loading }" /><span>刷新</span>
        </button>
        <button class="button" :disabled="busy === 'identify'" @click="identifyAll">
          <ShieldCheck :size="15" /><span>识别身份</span>
        </button>
      </div>
    </header>

    <div v-if="error" class="error-banner" role="alert">
      <CircleAlert :size="16" /><span>{{ error }}</span><button @click="refresh">重试</button>
    </div>
    <p v-if="identify" class="inline-hint">{{ identify }}</p>

    <div class="section-panel">
      <div class="table-toolbar">
        <label class="search-field">
          <Search :size="15" />
          <input v-model="query" type="search" placeholder="搜索账号标签、名称或邮箱" aria-label="搜索 ZCode 账号" />
        </label>
        <span class="subtle">{{ accounts.length }} 个账号</span>
      </div>

      <div v-if="loading && !loaded" class="page-loading">
        <LoaderCircle :size="20" class="spin" /><span>正在读取 ZCode 账号…</span>
      </div>
      <div v-else-if="!visible.length" class="pool-empty">
        <UsersRound :size="26" />
        <h2>{{ query ? '没有匹配的账号' : '还没有 ZCode 账号' }}</h2>
        <p>{{ query ? '更换关键字后重试。' : '去「账号授权」页完成登录授权。' }}</p>
      </div>
      <div v-else class="table-scroll">
        <table class="account-table">
          <thead>
            <tr><th>账号</th><th>状态</th><th>额度</th><th>权重</th><th>最近错误</th><th>操作</th></tr>
          </thead>
          <tbody>
            <tr v-for="account in visible" :key="account.label">
              <td>
                <strong class="account-name">{{ account.name || account.label }}</strong>
                <span class="zc-meta">{{ accountIdentity(account) }}</span>
                <span class="zc-meta">{{ account.label }} · {{ account.realm ?? '未识别区服' }}</span>
              </td>
              <td>
                <span class="status-badge" :class="statusTone(accountState(account))"><i />{{ accountStateLabel(account) }}</span>
                <span class="zc-meta">活跃 {{ account.inFlight ?? 0 }} · 请求 {{ formatNumber(account.requests ?? 0) }}</span>
              </td>
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
                  <span class="zc-meta">同步 {{ formatTime(account.quota?.syncedAt) }}</span>
                </template>
                <span v-else class="cell-secondary">未同步</span>
              </td>
              <td class="cell-secondary">{{ account.weight ?? 1 }}</td>
              <td class="cell-secondary zc-error">{{ account.lastErr || '—' }}</td>
              <td>
                <div class="row-actions">
                  <button class="button" :disabled="busy === `${account.label}:refresh`" @click="act(account, 'refresh', '已刷新账号资格')">
                    <RefreshCw :size="13" /><span>刷新资格</span>
                  </button>
                  <button class="button" :disabled="busy === `${account.label}:selftest`" @click="startSelftest(account)">
                    <Zap :size="13" /><span>后台探测</span>
                  </button>
                  <button class="button" :disabled="busy === `${account.label}:claim-start`" @click="openClaim(account)">
                    领取套餐
                  </button>
                  <button class="button" @click="editor = account"><Pencil :size="13" /><span>编辑</span></button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <AccountEditor
      v-if="editor"
      :account="editor"
      @close="editor = null"
      @saved="
        () => {
          editor = null
          void refresh()
        }
      "
    />

    <ModalShell
      v-if="selftestDialog"
      title="后台探测"
      :subtitle="`账号「${selftestDialog.label}」的探测在 ZCode 服务内异步执行。`"
      @close="selftestDialog = null"
    >
      <div class="modal-body">
        <p v-if="selftestDialog.error" class="form-error">{{ selftestDialog.error }}</p>
        <p v-else-if="selftestDialog.job?.status && selftestDialog.job.status !== 'done' && selftestDialog.job.status !== 'failed'" class="inline-hint">
          <LoaderCircle :size="14" class="spin" /><span>探测进行中（{{ selftestDialog.job.status }}）…</span>
        </p>
        <div class="code-block">
          <div class="code-header"><span>探测结果</span></div>
          <pre>{{ JSON.stringify(selftestDialog.job ?? {}, null, 2) }}</pre>
        </div>
      </div>
      <footer class="modal-footer">
        <button class="button" @click="selftestDialog = null">关闭</button>
      </footer>
    </ModalShell>

    <ModalShell
      v-if="claimDialog"
      title="领取 Coding Plan 套餐"
      subtitle="领取需要上游验证；未完成验证时结果会显示 captcha 相关错误。"
      @close="claimDialog = null"
    >
      <div class="modal-body">
        <p class="form-section-title">{{ claimDialog.account.name || claimDialog.account.label }}</p>
        <label
          >套餐 ID（可选）
          <input v-model="preparePlanId" placeholder="留空表示由服务挑选可用套餐" />
        </label>
        <p v-if="claimDialog.preparation" class="inline-hint">
          已准备领取流程：<code>{{ claimDialog.preparation.preparationId }}</code>
        </p>
      </div>
      <footer class="modal-footer">
        <button class="button" @click="claimDialog = null">取消</button>
        <button class="button primary" :disabled="busy === `${claimDialog.account.label}:claim`" @click="submitClaim(claimDialog.account)">
          提交领取
        </button>
      </footer>
    </ModalShell>
  </section>
</template>

<style scoped>
.zc-meta {
  display: block;
  margin-top: 3px;
  color: var(--muted);
  font-size: 12px;
  overflow-wrap: anywhere;
}
.zc-error {
  max-width: 220px;
}
</style>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { CircleAlert, Copy, KeyRound, LoaderCircle, Plus, RefreshCw, RotateCcw, Trash2 } from '@lucide/vue'
import ModalShell from '../../components/ModalShell.vue'
import { notify, reportError } from '../../panel.ts'
import { formatNumber } from '../../systems.ts'
import { formatTime, zcode } from './service.ts'
import type { ZcodeKey, ZcodeKeysPage } from './types.ts'

const page = ref<ZcodeKeysPage>({ keys: [], total: 0 })
const loading = ref(false)
const error = ref('')
const creating = ref(false)
const editing = ref<ZcodeKey | null>(null)
const revealed = ref<{ name: string; secret: string } | null>(null)
const draft = ref({
  name: '',
  realm: '',
  expiresInDays: 0,
  quotaTokens: 0,
  models: '',
  ipAllowlist: '',
  note: '',
})

const keys = computed(() => page.value.keys ?? [])

async function load() {
  loading.value = true
  try {
    const result = await zcode<ZcodeKeysPage>('/keys')
    if (!Array.isArray(result.keys)) throw new Error('ZCode 密钥数据格式不正确')
    page.value = result
    error.value = ''
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'ZCode 密钥加载失败'
  } finally {
    loading.value = false
  }
}

const listOf = (value: string) =>
  value
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean)

async function create() {
  if (!draft.value.name.trim()) return
  try {
    // The full secret comes back exactly once, so it is surfaced immediately.
    const result = await zcode<{ key: ZcodeKey; secret: string }>('/keys', 'POST', {
      name: draft.value.name.trim(),
      realm: draft.value.realm,
      expiresInDays: Number(draft.value.expiresInDays) || 0,
      quotaTokens: Number(draft.value.quotaTokens) || 0,
      models: listOf(draft.value.models),
      ipAllowlist: listOf(draft.value.ipAllowlist),
      note: draft.value.note.trim(),
    })
    creating.value = false
    draft.value = { name: '', realm: '', expiresInDays: 0, quotaTokens: 0, models: '', ipAllowlist: '', note: '' }
    revealed.value = { name: result.key?.name ?? draft.value.name, secret: result.secret }
    await load()
  } catch (cause) {
    reportError(cause, '创建 ZCode 密钥失败')
  }
}

async function saveEdit(event: Event) {
  const form = event.target as HTMLFormElement
  const data = new FormData(form)
  const key = editing.value
  if (!key) return
  try {
    await zcode(`/keys/${key.id}/update`, 'POST', {
      name: String(data.get('name') ?? '').trim(),
      enabled: data.get('enabled') === 'on',
      realm: String(data.get('realm') ?? ''),
      expiresInDays: Number(data.get('expiresInDays')) || 0,
      quotaTokens: Number(data.get('quotaTokens')) || 0,
      models: listOf(String(data.get('models') ?? '')),
      ipAllowlist: listOf(String(data.get('ipAllowlist') ?? '')),
      note: String(data.get('note') ?? '').trim(),
    })
    editing.value = null
    notify('密钥已更新')
    await load()
  } catch (cause) {
    reportError(cause, '更新 ZCode 密钥失败')
  }
}

async function zeroUsage(key: ZcodeKey) {
  try {
    // `/keys/:id/reset` only clears usage counters — it does not rotate the secret.
    await zcode(`/keys/${key.id}/reset`, 'POST', {})
    notify(`已清零「${key.name}」的用量统计`)
    await load()
  } catch (cause) {
    reportError(cause, '清零用量失败')
  }
}

async function remove(key: ZcodeKey) {
  try {
    await zcode(`/keys/${key.id}/delete`, 'POST', {})
    notify(`已删除「${key.name}」`)
    await load()
  } catch (cause) {
    reportError(cause, '删除 ZCode 密钥失败')
  }
}

async function copy(value: string) {
  try {
    await navigator.clipboard.writeText(value)
    notify('已复制到剪贴板')
  } catch {
    notify('复制失败，请手动选择文本', true)
  }
}

const usage = (key: ZcodeKey) => {
  const quota = Number(key.quotaTokens ?? 0)
  const used = Number(key.usedTokens ?? 0)
  if (!quota) return `${formatNumber(used)} 已用 · 不限量`
  return `${formatNumber(used)} / ${formatNumber(quota)}`
}

const expired = (key: ZcodeKey) => Number(key.expiresAt ?? 0) > 0 && Number(key.expiresAt) < Date.now()

onMounted(() => {
  void load()
})
</script>

<template>
  <section>
    <header class="page-heading">
      <div>
        <span class="eyebrow"><i class="blue-line" /> ZCODE KEYS</span>
        <h1>ZCode 密钥管理<span class="heading-count">{{ formatNumber(page.total ?? keys.length) }} 个</span></h1>
        <p>这些是发给调用方的网关密钥；主密钥在「接入配置」页维护。</p>
      </div>
      <div class="heading-actions">
        <button class="button" :disabled="loading" @click="load">
          <RefreshCw :size="15" :class="{ spin: loading }" /><span>刷新</span>
        </button>
        <button class="button primary" @click="creating = true"><Plus :size="15" /><span>新建密钥</span></button>
      </div>
    </header>

    <div v-if="page.openMode" class="error-banner" role="note">
      <CircleAlert :size="16" /><span>当前既没有主密钥也没有启用中的密钥，网关处于开放模式，任何人都能调用。</span>
    </div>
    <div v-if="error" class="error-banner" role="alert">
      <CircleAlert :size="16" /><span>{{ error }}</span><button @click="load">重试</button>
    </div>

    <div class="section-panel">
      <div v-if="loading && !keys.length" class="page-loading">
        <LoaderCircle :size="20" class="spin" /><span>正在读取密钥…</span>
      </div>
      <div v-else-if="!keys.length" class="empty-filter">
        <KeyRound :size="26" /><h3>还没有密钥</h3><p>新建一个密钥发给调用方，或先设置主密钥。</p>
      </div>
      <div v-else class="table-scroll">
        <table class="account-table">
          <thead>
            <tr><th>名称</th><th>前缀</th><th>状态</th><th>域名</th><th>用量</th><th>请求</th><th>到期</th><th>操作</th></tr>
          </thead>
          <tbody>
            <tr v-for="key in keys" :key="key.id">
              <td>
                <strong>{{ key.name }}</strong>
                <p v-if="key.note" class="cell-secondary">{{ key.note }}</p>
                <p v-if="key.models?.length" class="cell-secondary">模型：{{ key.models.join(', ') }}</p>
                <p v-if="key.ipAllowlist?.length" class="cell-secondary">IP：{{ key.ipAllowlist.join(', ') }}</p>
              </td>
              <td class="mono cell-secondary">{{ key.prefix ? `${key.prefix}…` : '—' }}</td>
              <td>
                <span class="status-badge" :class="key.enabled === false || expired(key) ? 'offline' : 'green'">
                  <i />{{ expired(key) ? '已过期' : key.enabled === false ? '已停用' : '启用' }}
                </span>
              </td>
              <td class="cell-secondary">{{ key.realm === 'cn' ? '国内' : key.realm === 'intl' ? '国际' : '默认' }}</td>
              <td class="cell-secondary">{{ usage(key) }}</td>
              <td class="cell-secondary">{{ formatNumber(key.requests ?? 0) }}</td>
              <td class="cell-secondary">{{ Number(key.expiresAt ?? 0) > 0 ? formatTime(key.expiresAt) : '长期' }}</td>
              <td>
                <div class="row-actions">
                  <button class="button" @click="editing = key">编辑</button>
                  <button class="button" :title="'只清零用量统计，不改密钥本身'" @click="zeroUsage(key)">
                    <RotateCcw :size="13" /><span>清零</span>
                  </button>
                  <button class="button danger" @click="remove(key)"><Trash2 :size="13" /><span>删除</span></button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>

    <ModalShell v-if="creating" title="新建密钥" subtitle="完整密钥只会显示一次" @close="creating = false">
      <div class="modal-body">
        <div class="form-grid">
          <label>名称<input v-model="draft.name" maxlength="60" placeholder="例如 内部测试" /></label>
          <label
            >域名
            <select v-model="draft.realm">
              <option value="">默认</option>
              <option value="cn">国内</option>
              <option value="intl">国际</option>
            </select>
          </label>
          <label>有效天数<input v-model.number="draft.expiresInDays" type="number" min="0" max="3650" /><small>0 表示长期有效</small></label>
          <label>token 额度<input v-model.number="draft.quotaTokens" type="number" min="0" /><small>0 表示不限量</small></label>
        </div>
        <label>允许的模型<input v-model="draft.models" placeholder="留空表示全部，用逗号或空格分隔" /></label>
        <label>IP 允许列表<input v-model="draft.ipAllowlist" placeholder="留空表示不限制，用逗号或空格分隔" /></label>
        <label>备注<input v-model="draft.note" maxlength="200" /></label>
      </div>
      <footer class="modal-footer">
        <button class="button" @click="creating = false">取消</button>
        <button class="button primary" :disabled="!draft.name.trim()" @click="create">创建</button>
      </footer>
    </ModalShell>

    <ModalShell v-if="editing" title="编辑密钥" :subtitle="editing.name" @close="editing = null">
      <form @submit.prevent="saveEdit">
        <div class="modal-body">
          <div class="form-grid">
            <label>名称<input name="name" :value="editing.name" maxlength="60" /></label>
            <label
              >域名
              <select name="realm" :value="editing.realm ?? ''">
                <option value="">默认</option>
                <option value="cn">国内</option>
                <option value="intl">国际</option>
              </select>
            </label>
            <label>有效天数<input name="expiresInDays" type="number" min="0" max="3650" :value="0" /><small>重新填写后从今天起算</small></label>
            <label>token 额度<input name="quotaTokens" type="number" min="0" :value="editing.quotaTokens ?? 0" /></label>
            <label class="check-label"><input type="checkbox" name="enabled" :checked="editing.enabled !== false" />启用</label>
          </div>
          <label>允许的模型<input name="models" :value="(editing.models ?? []).join(', ')" /></label>
          <label>IP 允许列表<input name="ipAllowlist" :value="(editing.ipAllowlist ?? []).join(', ')" /></label>
          <label>备注<input name="note" :value="editing.note ?? ''" maxlength="200" /></label>
        </div>
        <footer class="modal-footer">
          <button class="button" type="button" @click="editing = null">取消</button>
          <button class="button primary" type="submit">保存</button>
        </footer>
      </form>
    </ModalShell>

    <ModalShell v-if="revealed" title="密钥已创建" subtitle="离开后无法再次查看完整密钥" @close="revealed = null">
      <div class="modal-body">
        <p class="inline-hint">请立刻复制并妥善保存「{{ revealed.name }}」的完整密钥。</p>
        <div class="code-block">
          <div class="code-header"><span>完整密钥</span><button class="button" @click="copy(revealed.secret)"><Copy :size="13" /><span>复制</span></button></div>
          <pre>{{ revealed.secret }}</pre>
        </div>
      </div>
      <footer class="modal-footer">
        <button class="button primary" @click="revealed = null">我已保存</button>
      </footer>
    </ModalShell>
  </section>
</template>

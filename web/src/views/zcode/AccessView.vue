<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  ArrowRight,
  Braces,
  Check,
  CircleAlert,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  LoaderCircle,
  Plus,
  RefreshCw,
  ShieldCheck,
  Terminal,
  Trash2,
} from '@lucide/vue'
import ModalShell from '../../components/ModalShell.vue'
import { copy, notify, reportError } from '../../panel.ts'
import { formatNumber } from '../../systems.ts'
import { formatTime, zcode } from './service.ts'
import type { ZcodeAccess, ZcodeKey, ZcodeKeysPage } from './types.ts'

const MASKED = '••••••••••••••••••••'
const access = ref<ZcodeAccess>({ publicUrl: '', maskedKey: MASKED })
const keys = ref<ZcodeKey[]>([])
const masterKey = ref('')
const reveal = ref(false)
const keyLoading = ref('')
const error = ref('')
const secret = ref<{ name: string; secret: string } | null>(null)
const creating = ref(false)
const draft = ref({ name: '', expiresInDays: 0, quotaTokens: 0, realm: '', note: '' })
const confirmDelete = ref<ZcodeKey | null>(null)

const baseUrl = computed(() => access.value.publicUrl || window.location.origin)
const example = computed(
  () =>
    `curl ${baseUrl.value}/v1/chat/completions \\\n  -H "Authorization: Bearer YOUR_ZCODE_KEY" \\\n  -H "Content-Type: application/json" \\\n  -d '{\n    "model": "GLM-5.3",\n    "messages": [{"role": "user", "content": "你好"}]\n  }'`,
)

async function load() {
  try {
    access.value = await zcode<ZcodeAccess>('/api/access')
    error.value = ''
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : 'ZCode 接入配置读取失败'
  }
  try {
    const page = await zcode<ZcodeKeysPage>('/keys')
    keys.value = Array.isArray(page.keys) ? page.keys : []
  } catch (cause) {
    reportError(cause, '读取 ZCode 密钥列表失败')
  }
}

async function toggleMasterKey() {
  if (reveal.value) {
    reveal.value = false
    masterKey.value = ''
    return
  }
  keyLoading.value = 'master'
  try {
    if (!masterKey.value) masterKey.value = (await zcode<{ key: string }>('/api/access/key', 'POST', {})).key
    reveal.value = true
  } catch (cause) {
    notify(cause instanceof Error ? cause.message : '主密钥未设置', true)
  } finally {
    keyLoading.value = ''
  }
}

async function createKey() {
  if (!draft.value.name.trim()) {
    notify('请填写密钥名称', true)
    return
  }
  keyLoading.value = 'create'
  try {
    const result = await zcode<{ key: ZcodeKey; secret?: string }>('/keys', 'POST', {
      name: draft.value.name.trim(),
      expiresInDays: Number(draft.value.expiresInDays) || 0,
      quotaTokens: Number(draft.value.quotaTokens) || 0,
      ...(draft.value.realm ? { realm: draft.value.realm } : {}),
      note: draft.value.note.trim(),
    })
    secret.value = result.secret ? { name: result.key?.name ?? draft.value.name, secret: result.secret } : null
    creating.value = false
    draft.value = { name: '', expiresInDays: 0, quotaTokens: 0, realm: '', note: '' }
    notify('密钥已创建，完整密钥只显示一次')
    await load()
  } catch (cause) {
    reportError(cause, '创建密钥失败')
  } finally {
    keyLoading.value = ''
  }
}

async function keyAction(key: ZcodeKey, action: 'update' | 'delete' | 'reset', body: unknown = {}) {
  keyLoading.value = `${key.id}:${action}`
  try {
    const result = await zcode<{ key?: ZcodeKey; secret?: string }>(
      `/keys/${key.id}/${action}`,
      'POST',
      action === 'delete' ? {} : body,
    )
    if (action === 'reset' && result.secret) secret.value = { name: key.name, secret: result.secret }
    if (action === 'delete') confirmDelete.value = null
    notify(action === 'delete' ? '密钥已删除' : action === 'reset' ? '密钥已重置' : '密钥已更新')
    await load()
  } catch (cause) {
    reportError(cause, '密钥操作失败')
  } finally {
    keyLoading.value = ''
  }
}

const expiry = (key: ZcodeKey) =>
  key.expiresAt ? formatTime(key.expiresAt) : '永久有效'

onMounted(() => {
  void load()
})
</script>

<template>
  <section>
    <header class="page-heading">
      <div>
        <span class="eyebrow"><i class="blue-line" /> ZCODE ACCESS</span>
        <h1>ZCode 接入配置</h1>
        <p>主密钥与托管密钥都由 ZCode 服务保存；面板不缓存任何密钥。</p>
      </div>
      <span class="protocol-label"><ShieldCheck :size="15" />标准协议兼容</span>
    </header>

    <div v-if="error" class="error-banner" role="alert">
      <CircleAlert :size="16" /><span>{{ error }}</span><button @click="load">重试</button>
    </div>

    <section class="access-hero">
      <div class="access-hero-icon"><Braces :size="28" /></div>
      <div>
        <span class="eyebrow">ZCODE ENDPOINT</span>
        <h2>一个地址，连起 ZCode 号池。</h2>
        <p>{{ access.gatewayKeySet ? '主密钥已配置。' : '当前未配置 GATEWAY_KEY，服务处于开放模式。' }}</p>
      </div>
      <div class="access-hero-tags">
        <span><Check :size="12" />OpenAI 兼容</span>
      </div>
    </section>

    <div class="access-grid">
      <section class="section-panel">
        <header class="section-heading">
          <KeyRound :size="20" />
          <div><h2>连接信息</h2><p>客户端只与本服务地址通信。</p></div>
        </header>
        <div class="connection-fields">
          <label
            >OpenAI Base URL
            <div class="copy-field">
              <code>{{ baseUrl }}/v1</code>
              <button class="icon-button" aria-label="复制 ZCode 地址" @click="copy(`${baseUrl}/v1`)"><Copy :size="15" /></button>
            </div>
          </label>
          <label
            >主密钥
            <div class="copy-field">
              <code>{{ reveal ? masterKey : access.maskedKey || MASKED }}</code>
              <button
                class="icon-button"
                :disabled="keyLoading === 'master'"
                :aria-label="reveal ? '隐藏主密钥' : '显示主密钥'"
                @click="toggleMasterKey"
              >
                <LoaderCircle v-if="keyLoading === 'master'" :size="15" class="spin" />
                <EyeOff v-else-if="reveal" :size="15" />
                <Eye v-else :size="15" />
              </button>
            </div>
            <small>主密钥来自服务环境变量 GATEWAY_KEY。</small>
          </label>
        </div>
        <div class="access-security">
          <ShieldCheck :size="16" /><span>托管密钥与主密钥并存；托管密钥可单独限模型、限额度与限 IP。</span>
        </div>
      </section>

      <section class="section-panel client-guide">
        <header class="section-heading">
          <Terminal :size="20" />
          <div><h2>快速开始</h2><p>替换密钥即可调用。</p></div>
        </header>
        <div class="code-block">
          <div class="code-header"><span><Terminal :size="13" />Terminal</span><button class="icon-button" aria-label="复制示例" @click="copy(example)"><Copy :size="14" /></button></div>
          <pre>{{ example }}</pre>
        </div>
        <p class="inline-hint">模型以服务 /v1/models 返回的清单为准。</p>
      </section>
    </div>

    <section class="section-panel">
      <div class="section-heading">
        <KeyRound :size="20" />
        <div><h2>托管密钥</h2><p>创建后会显示一次完整密钥；重置会生成新密钥并立即替换旧的。</p></div>
        <button class="button" @click="load"><RefreshCw :size="14" /><span>刷新</span></button>
        <button class="button primary" @click="creating = true"><Plus :size="14" /><span>新建密钥</span></button>
      </div>
      <div v-if="!keys.length" class="empty-filter">
        <KeyRound :size="26" /><h3>还没有托管密钥</h3><p>不创建时客户端需使用主密钥。</p>
      </div>
      <div v-else class="table-scroll">
        <table class="account-table">
          <thead><tr><th>名称</th><th>前缀</th><th>状态</th><th>用量</th><th>过期</th><th>最近使用</th><th>操作</th></tr></thead>
          <tbody>
            <tr v-for="key in keys" :key="key.id">
              <td>
                <strong class="account-name">{{ key.name }}</strong>
                <span v-if="key.note" class="zc-meta">{{ key.note }}</span>
              </td>
              <td class="mono cell-secondary">{{ key.prefix ?? '—' }}</td>
              <td>
                <span class="status-badge" :class="key.enabled === false ? 'gray' : 'green'">
                  <i />{{ key.enabled === false ? '已停用' : '启用' }}
                </span>
              </td>
              <td class="cell-secondary">
                {{ formatNumber(key.usedTokens ?? 0) }} / {{ key.quotaTokens ? formatNumber(key.quotaTokens) : '不限' }}
              </td>
              <td class="cell-secondary">{{ expiry(key) }}</td>
              <td class="cell-secondary">{{ formatTime(key.lastUsedAt ? key.lastUsedAt : null) }}</td>
              <td>
                <div class="row-actions">
                  <button class="button" :disabled="keyLoading === `${key.id}:update`" @click="keyAction(key, 'update', { enabled: key.enabled === false })">
                    {{ key.enabled === false ? '启用' : '停用' }}
                  </button>
                  <button class="button" :disabled="keyLoading === `${key.id}:reset`" @click="keyAction(key, 'reset')">重置</button>
                  <button class="button danger" @click="confirmDelete = key"><Trash2 :size="13" /></button>
                </div>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="section-panel access-flow">
      <span class="eyebrow">HOW IT CONNECTS</span>
      <div>
        <span><span class="flow-step">01</span><strong>客户端</strong><small>托管密钥或主密钥</small></span>
        <ArrowRight :size="20" />
        <span><span class="flow-step">02</span><strong>ZCode 调度</strong><small>加权选取 / 熔断</small></span>
        <ArrowRight :size="20" />
        <span><span class="flow-step">03</span><strong>上游套餐</strong><small>Z.ai / BigModel</small></span>
      </div>
    </section>

    <ModalShell v-if="creating" title="新建托管密钥" subtitle="密钥受模型、额度与 IP 限制。" @close="creating = false">
      <div class="modal-body">
        <div class="form-grid">
          <label>名称<input v-model="draft.name" required maxlength="60" /></label>
          <label>有效期（天，0 为永久）<input v-model.number="draft.expiresInDays" type="number" min="0" /></label>
          <label>token 额度（0 为不限）<input v-model.number="draft.quotaTokens" type="number" min="0" /></label>
          <label
            >区服
            <select v-model="draft.realm">
              <option value="">不限</option>
              <option value="cn">国内</option>
              <option value="intl">国际</option>
            </select>
          </label>
        </div>
        <label>备注<input v-model="draft.note" maxlength="200" /></label>
      </div>
      <footer class="modal-footer">
        <button class="button" @click="creating = false">取消</button>
        <button class="button primary" :disabled="keyLoading === 'create'" @click="createKey">创建密钥</button>
      </footer>
    </ModalShell>

    <ModalShell v-if="secret" title="完整密钥（只显示一次）" subtitle="关闭后无法再次查看，请立即保存。" @close="secret = null">
      <div class="modal-body">
        <p class="form-section-title">{{ secret.name }}</p>
        <div class="copy-field">
          <code>{{ secret.secret }}</code>
          <button class="icon-button" aria-label="复制密钥" @click="copy(secret.secret)"><Copy :size="14" /></button>
        </div>
      </div>
      <footer class="modal-footer">
        <button class="button primary" @click="secret = null">我已保存</button>
      </footer>
    </ModalShell>

    <ModalShell v-if="confirmDelete" title="删除密钥" :subtitle="`删除「${confirmDelete.name}」后使用它的客户端会立即失败。`" @close="confirmDelete = null">
      <div class="modal-body"><p class="form-error"><CircleAlert :size="14" />此操作不可撤销。</p></div>
      <footer class="modal-footer">
        <button class="button" @click="confirmDelete = null">取消</button>
        <button class="button danger" @click="keyAction(confirmDelete, 'delete')">删除</button>
      </footer>
    </ModalShell>
  </section>
</template>

<style scoped>
.zc-meta {
  display: block;
  margin-top: 4px;
  color: var(--muted);
  font-size: 12px;
}
</style>

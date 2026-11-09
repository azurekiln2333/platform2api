<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { Eye, KeyRound, LoaderCircle, RefreshCw, RotateCw, Trash2 } from '@lucide/vue'
import { copy, notify, reportError } from '../../panel.ts'
import { codebuddy } from './service.ts'

interface CodeBuddyKey {
  id?: string
  [key: string]: unknown
}

const items = ref<CodeBuddyKey[]>([])
const external = ref(false)
const revealed = ref<Record<string, string>>({})
const loading = ref(false)
const loaded = ref(false)
const error = ref('')
const busy = ref('')
const creating = ref(false)
const createBusy = ref(false)
const newName = ref('')
const newType = ref<'user' | 'admin'>('user')
const createdKey = ref('')
let active = false
let generation = 0

const count = computed(() => items.value.length)

async function refresh() {
  if (loading.value) return
  const request = ++generation
  loading.value = true
  try {
    const result = await codebuddy<{ external: boolean; items: CodeBuddyKey[] }>('/admin/keys')
    if (!active || request !== generation) return
    items.value = Array.isArray(result.items) ? result.items : []
    external.value = Boolean(result.external)
    loaded.value = true
    error.value = ''
  } catch (cause) {
    if (active && request === generation)
      error.value = cause instanceof Error ? cause.message : '无法读取 CodeBuddy 密钥'
  } finally {
    if (active && request === generation) loading.value = false
  }
}

/** Creating a key returns its secret exactly once; it is never re-readable. */
async function create() {
  const name = newName.value.trim()
  if (!name) {
    notify('请先填写密钥名称')
    return
  }
  createBusy.value = true
  try {
    const result = await codebuddy<{ key?: string }>('/admin/keys', 'POST', {
      name,
      type: newType.value,
    })
    createdKey.value = result?.key ?? ''
    newName.value = ''
    await refresh()
    notify(createdKey.value ? '密钥已创建，请立即复制并妥善保存' : '密钥已创建')
  } catch (cause) {
    reportError(cause, '创建密钥失败')
  } finally {
    createBusy.value = false
  }
}

/** Closing the create panel drops the one-time secret from memory too. */
function closeCreate() {
  creating.value = false
  createdKey.value = ''
}

/** Revealing a secret is always explicit and never automatic. */
async function reveal(item: CodeBuddyKey) {
  const id = String(item.id ?? '')
  if (!id) return
  if (!confirm('显示该密钥明文？请确认当前屏幕不可被他人看到。')) return
  busy.value = `${id}:reveal`
  try {
    const result = await codebuddy<{ key?: string }>(
      `/admin/keys/${encodeURIComponent(id)}/reveal`,
      'POST',
      {},
    )
    if (result?.key) revealed.value = { ...revealed.value, [id]: result.key }
    else notify('服务未返回可显示的密钥', true)
  } catch (cause) {
    reportError(cause, '读取密钥失败')
  } finally {
    busy.value = ''
  }
}

async function rotate(item: CodeBuddyKey) {
  const id = String(item.id ?? '')
  if (!id) return
  if (!confirm('轮换该密钥？旧密钥会立即失效。')) return
  busy.value = `${id}:rotate`
  try {
    await codebuddy(`/admin/keys/${encodeURIComponent(id)}/rotate`, 'POST', {})
    const next = { ...revealed.value }
    delete next[id]
    revealed.value = next
    await refresh()
    notify('密钥已轮换')
  } catch (cause) {
    reportError(cause, '轮换密钥失败')
  } finally {
    busy.value = ''
  }
}

async function remove(item: CodeBuddyKey) {
  const id = String(item.id ?? '')
  if (!id) return
  if (!confirm('删除该密钥？')) return
  busy.value = `${id}:delete`
  try {
    await codebuddy(`/admin/keys/${encodeURIComponent(id)}`, 'DELETE')
    await refresh()
    notify('密钥已删除')
  } catch (cause) {
    reportError(cause, '删除密钥失败')
  } finally {
    busy.value = ''
  }
}

onMounted(() => {
  active = true
  void refresh()
})
onBeforeUnmount(() => {
  active = false
  generation++
})
</script>

<template>
  <section>
    <header class="page-heading">
      <div>
        <span class="eyebrow"><i class="blue-line" /> CODEBUDDY KEYS</span>
        <h1>
          CodeBuddy 密钥<span class="heading-count">{{ count }}</span>
        </h1>
        <p>密钥由 CodeBuddy 服务持有；显示与轮换都是显式操作，不会自动展开。</p>
      </div>
      <div class="heading-actions">
        <button class="button primary" @click="creating = !creating"><span>新建密钥</span></button>
        <button class="button" :disabled="loading" @click="refresh">
          <RefreshCw :size="15" :class="{ spin: loading }" /><span>刷新密钥</span>
        </button>
      </div>
    </header>

    <section v-if="creating" class="section-panel">
      <div class="panel-head">
        <h2>新建密钥</h2>
        <p class="subtle">密钥明文只在创建时返回一次，面板不会回显已保存的密钥。</p>
      </div>
      <div class="form-field">
        <label for="cb-key-name">名称</label>
        <input id="cb-key-name" v-model="newName" type="text" placeholder="例如 panel-automation" />
      </div>
      <div class="form-field">
        <label for="cb-key-type">类型</label>
        <select id="cb-key-type" v-model="newType">
          <option value="user">user</option>
          <option value="admin">admin</option>
        </select>
      </div>
      <div v-if="createdKey" class="note-box">
        <KeyRound :size="16" />
        <code class="mono">{{ createdKey }}</code>
        <button class="button" @click="copy(createdKey)">复制</button>
      </div>
      <div class="form-actions">
        <button class="button primary" :disabled="createBusy" @click="create">
          <LoaderCircle v-if="createBusy" :size="15" class="spin" /><span>创建</span>
        </button>
        <button class="button" :disabled="createBusy" @click="closeCreate">取消</button>
      </div>
    </section>

    <div v-if="external" class="note-box">
      <KeyRound :size="16" />
      <span>密钥由外部配置（环境变量或 CLI）管理，面板仅展示，修改请在服务端进行。</span>
    </div>

    <div v-if="error" class="error-banner" role="alert">
      <span>{{ error }}</span
      ><button @click="refresh">重试读取密钥</button>
    </div>

    <div v-if="loading && !loaded" class="page-loading">
      <LoaderCircle :size="20" class="spin" /><span>正在读取密钥…</span>
    </div>

    <div v-else-if="!count" class="empty-filter">
      <KeyRound :size="28" />
      <h3>还没有密钥</h3>
      <p>在 CodeBuddy 服务中创建推理密钥后，这里会同步显示。</p>
    </div>

    <div v-else class="table-scroll">
      <table class="account-table">
        <thead>
          <tr>
            <th>标识</th>
            <th>密钥</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in items" :key="String(item.id)">
            <td>
              <strong class="mono">{{ item.id }}</strong>
            </td>
            <td>
              <div class="key-cell">
                <code class="mono">{{ revealed[String(item.id)] || '••••••••••••' }}</code>
                <button
                  v-if="revealed[String(item.id)]"
                  class="icon-button"
                  :aria-label="`复制密钥 ${item.id}`"
                  @click="copy(revealed[String(item.id)])"
                >
                  <KeyRound :size="13" />
                </button>
              </div>
            </td>
            <td>
              <div class="button-group">
                <button
                  class="button"
                  :disabled="busy === `${item.id}:reveal`"
                  @click="reveal(item)"
                >
                  <LoaderCircle v-if="busy === `${item.id}:reveal`" :size="14" class="spin" />
                  <Eye v-else :size="14" />
                  <span>显示</span>
                </button>
                <button
                  class="button"
                  :disabled="busy === `${item.id}:rotate`"
                  @click="rotate(item)"
                >
                  <LoaderCircle v-if="busy === `${item.id}:rotate`" :size="14" class="spin" />
                  <RotateCw v-else :size="14" />
                  <span>轮换</span>
                </button>
                <button
                  class="button danger"
                  :disabled="busy === `${item.id}:delete`"
                  @click="remove(item)"
                >
                  <LoaderCircle v-if="busy === `${item.id}:delete`" :size="14" class="spin" />
                  <Trash2 v-else :size="14" />
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>

<style scoped>
.key-cell {
  display: flex;
  align-items: center;
  gap: 6px;
}
</style>

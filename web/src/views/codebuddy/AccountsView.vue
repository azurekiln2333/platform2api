<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { LoaderCircle, RefreshCw, Search, Trash2, UserPlus, X } from '@lucide/vue'
import { notify, reportError } from '../../panel.ts'
import { statusLabel, statusTone } from '../../systems.ts'
import { CREDENTIAL_TOGGLES, codebuddy, credentialState, formatTime } from './service.ts'
import type { CodeBuddyCredential } from './service.ts'
import EnrollView from './EnrollView.vue'

const credentials = ref<CodeBuddyCredential[]>([])
const search = ref('')
const loading = ref(false)
const loaded = ref(false)
const error = ref('')
const busy = ref('')
const enrolling = ref(false)
const importing = ref(false)
const importingBusy = ref(false)
const importProfile = ref('cn-cli')
const importTokens = ref('')
const uploadBusy = ref(false)
const uploadInput = ref<HTMLInputElement | null>(null)
let active = false
let generation = 0
let poll: number | undefined

const filtered = computed(() => {
  const query = search.value.trim().toLowerCase()
  if (!query) return credentials.value
  return credentials.value.filter((item) =>
    [item.name, item.nickname, ...(item.tags ?? [])]
      .filter((value): value is string => typeof value === 'string')
      .join(' ')
      .toLowerCase()
      .includes(query),
  )
})

async function refresh() {
  if (document.hidden || loading.value) return
  const request = ++generation
  loading.value = true
  try {
    const result = await codebuddy<{ credentials: CodeBuddyCredential[] }>('/admin/credentials')
    if (!active || request !== generation) return
    if (!Array.isArray(result.credentials)) throw new Error('凭证列表格式不正确')
    credentials.value = result.credentials
    loaded.value = true
    error.value = ''
  } catch (cause) {
    if (active && request === generation)
      error.value = cause instanceof Error ? cause.message : '无法读取 CodeBuddy 凭证'
  } finally {
    if (active && request === generation) loading.value = false
  }
}

/** The service accepts exactly one boolean field per credential PATCH. */
async function setToggle(item: CodeBuddyCredential, field: string, value: boolean) {
  busy.value = `${item.name}:${field}`
  try {
    await codebuddy(`/admin/credentials/${encodeURIComponent(item.name)}`, 'PATCH', {
      [field]: value,
    })
    await refresh()
    notify(`已更新 ${item.nickname || item.name} 的${field}`)
  } catch (cause) {
    reportError(cause, '更新凭证失败')
  } finally {
    busy.value = ''
  }
}

async function remove(item: CodeBuddyCredential) {
  if (!confirm(`删除凭证「${item.nickname || item.name}」？该操作会移除服务端凭证文件。`)) return
  busy.value = `${item.name}:delete`
  try {
    await codebuddy(`/admin/credentials/${encodeURIComponent(item.name)}`, 'DELETE')
    await refresh()
    notify('凭证已删除')
  } catch (cause) {
    reportError(cause, '删除凭证失败')
  } finally {
    busy.value = ''
  }
}

const enabledOf = (item: CodeBuddyCredential) => item.enabled !== false && item.disabled !== true

/** Closing the enrollment panel always re-reads the credential list. */
function onEnrolled() {
  enrolling.value = false
  void refresh()
}

/**
 * Batch import. The service takes JSON (`files: [{ name, content }]`), not
 * multipart, so a plain file input plus FileReader is enough and the panel
 * never needs a second upload channel.
 */
async function uploadFiles(event: Event) {
  const input = event.target as HTMLInputElement
  const picked = Array.from(input.files ?? [])
  input.value = ''
  if (!picked.length) return
  if (picked.length > 100) {
    notify('一次最多上传 100 个凭证文件')
    return
  }
  uploadBusy.value = true
  try {
    const files = await Promise.all(
      picked.map(async (file) => ({ name: file.name, content: await file.text() })),
    )
    const result = await codebuddy<{ results: unknown[] }>('/admin/credentials/upload', 'POST', {
      files,
      replace: false,
    })
    await refresh()
    notify(`已导入 ${result?.results?.length ?? files.length} 个凭证文件`)
  } catch (cause) {
    reportError(cause, '上传凭证失败')
  } finally {
    uploadBusy.value = false
  }
}

/** Exchange refresh tokens for credentials; blank lines are dropped. */
async function importTokensNow() {
  const tokens = importTokens.value
    .split(/[\s,]+/)
    .map((token) => token.trim())
    .filter(Boolean)
  if (!tokens.length) {
    notify('请先粘贴至少一个 refresh token')
    return
  }
  importingBusy.value = true
  try {
    const result = await codebuddy<{ results: unknown[] }>(
      '/admin/credentials/refresh-import',
      'POST',
      { profile: importProfile.value, refresh_tokens: tokens },
    )
    importTokens.value = ''
    importing.value = false
    await refresh()
    notify(`已导入 ${result?.results?.length ?? tokens.length} 个刷新令牌`)
  } catch (cause) {
    reportError(cause, '导入刷新令牌失败')
  } finally {
    importingBusy.value = false
  }
}

onMounted(() => {
  active = true
  void refresh()
  poll = window.setInterval(() => void refresh(), 15000)
  window.addEventListener('focus', refresh)
})
onBeforeUnmount(() => {
  active = false
  generation++
  window.clearInterval(poll)
  window.removeEventListener('focus', refresh)
})
</script>

<template>
  <section>
    <header class="page-heading">
      <div>
        <span class="eyebrow"><i class="blue-line" /> CODEBUDDY ACCOUNTS</span>
        <h1>
          CodeBuddy 凭证<span class="heading-count"
            >{{ filtered.length }} / {{ credentials.length }}</span
          >
        </h1>
        <p>凭证与自动化开关由 CodeBuddy 服务持有；面板只调用服务的管理接口，不修改其数据目录。</p>
      </div>
      <div class="heading-actions">
        <button class="button" :disabled="loading" @click="refresh">
          <RefreshCw :size="15" :class="{ spin: loading }" /><span>刷新凭证</span>
        </button>
        <button class="button" :disabled="uploadBusy" @click="uploadInput?.click()">
          <LoaderCircle v-if="uploadBusy" :size="15" class="spin" /><span>上传凭证</span>
        </button>
        <input
          ref="uploadInput"
          type="file"
          accept=".json,application/json"
          multiple
          hidden
          @change="uploadFiles"
        />
        <button class="button" @click="importing = !importing"><span>导入令牌</span></button>
        <button class="button primary" @click="enrolling = !enrolling">
          <UserPlus :size="15" /><span>接入账号</span>
        </button>
      </div>
    </header>

    <section v-if="enrolling" class="section-panel">
      <EnrollView @finished="onEnrolled" @closed="enrolling = false" />
    </section>

    <section v-if="importing" class="section-panel">
      <div class="panel-head">
        <h2>导入刷新令牌</h2>
        <p class="subtle">由 CodeBuddy 服务把 refresh token 兑换成凭证；面板不保存令牌明文。</p>
      </div>
      <div class="form-field">
        <label for="cb-import-profile">端点</label>
        <select id="cb-import-profile" v-model="importProfile">
          <option value="cn-cli">cn-cli</option>
          <option value="cn-work">cn-work</option>
          <option value="intl-cli">intl-cli</option>
          <option value="intl-work">intl-work</option>
        </select>
      </div>
      <div class="form-field">
        <label for="cb-import-tokens">刷新令牌（每行一个，最多 50 个）</label>
        <textarea
          id="cb-import-tokens"
          v-model="importTokens"
          rows="6"
          spellcheck="false"
          placeholder="粘贴 refresh token，每行一个"
        />
      </div>
      <div class="form-actions">
        <button class="button primary" :disabled="importingBusy" @click="importTokensNow">
          <LoaderCircle v-if="importingBusy" :size="15" class="spin" /><span>开始导入</span>
        </button>
        <button class="button" :disabled="importingBusy" @click="importing = false">取消</button>
      </div>
    </section>

    <div v-if="error" class="error-banner" role="alert">
      <span>{{ error }}</span
      ><button @click="refresh">重试读取凭证</button>
    </div>

    <div v-if="loading && !loaded" class="page-loading">
      <LoaderCircle :size="20" class="spin" /><span>正在读取凭证…</span>
    </div>

    <section v-else class="section-panel">
      <div class="table-toolbar">
        <label class="search-field">
          <Search :size="15" />
          <input
            v-model="search"
            type="search"
            aria-label="搜索凭证"
            placeholder="搜索昵称、文件名或标签…"
          />
          <button
            v-if="search"
            type="button"
            class="icon-button"
            aria-label="清空凭证搜索"
            @click="search = ''"
          >
            <X :size="13" />
          </button>
        </label>
        <span class="subtle">{{ credentials.length }} 个凭证</span>
      </div>

      <div v-if="!filtered.length" class="empty-filter">
        <h3>{{ search ? '没有匹配的凭证' : '还没有凭证' }}</h3>
        <p>
          {{ search ? '更换搜索关键字后重试。' : '使用「接入账号」完成一次服务端 OAuth 授权。' }}
        </p>
        <button v-if="search" class="button" @click="search = ''">清空搜索</button>
      </div>

      <div v-else class="table-scroll">
        <table class="account-table">
          <thead>
            <tr>
              <th>凭证</th>
              <th>状态</th>
              <th>自动化</th>
              <th>冷却至</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="item in filtered" :key="item.name">
              <td>
                <strong>{{ item.nickname || item.name }}</strong>
                <p class="cell-secondary mono">{{ item.name }}</p>
              </td>
              <td>
                <span class="status-badge" :class="statusTone(credentialState(item))">
                  <i />{{ statusLabel(credentialState(item)) }}
                </span>
              </td>
              <td>
                <div class="toggle-list">
                  <label v-for="entry in CREDENTIAL_TOGGLES" :key="entry.key">
                    <input
                      type="checkbox"
                      :checked="
                        entry.key === 'enabled'
                          ? enabledOf(item)
                          : Boolean((item as Record<string, unknown>)[entry.key])
                      "
                      :disabled="busy === `${item.name}:${entry.key}`"
                      @change="
                        setToggle(item, entry.key, ($event.target as HTMLInputElement).checked)
                      "
                    />
                    <span>{{ entry.label }}</span>
                  </label>
                </div>
              </td>
              <td class="cell-secondary">{{ formatTime(item.cooldown_until) }}</td>
              <td>
                <button
                  class="icon-button"
                  :disabled="busy === `${item.name}:delete`"
                  :aria-label="`删除凭证 ${item.name}`"
                  @click="remove(item)"
                >
                  <LoaderCircle v-if="busy === `${item.name}:delete`" :size="14" class="spin" />
                  <Trash2 v-else :size="14" />
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </section>
</template>

<style scoped>
.toggle-list {
  display: flex;
  flex-wrap: wrap;
  gap: 4px 12px;
}
.toggle-list label {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--secondary);
  font-size: 12px;
}
</style>

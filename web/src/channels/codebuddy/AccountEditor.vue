<script setup lang="ts">
import { computed, ref } from 'vue'
import { api, consoleApi } from '../../api.ts'
import { channelLabel, useUnsavedChanges } from '../../console.ts'
import { notify } from '../../panel.ts'
import ModalShell from '../../components/ModalShell.vue'
import NativeAccountEditor from '../../components/accounts/NativeAccountEditor.vue'
import AuthFlowDialog from '../../components/AuthFlowDialog.vue'
import type { AccountField } from '../../components/accounts/native-fields.ts'
import type { Account } from '../../console-types.ts'
const props = defineProps<{ account: Account | null; mode: string }>()
const emit = defineEmits<{ close: []; saved: [] }>()
const fields: AccountField[] = [
  { key: 'enabled', label: '启用账号', type: 'bool' },
  { key: 'auto_checkin', label: '自动签到', type: 'bool' },
  { key: 'auto_travel', label: '自动旅行', type: 'bool' },
  { key: 'auto_daily_chat', label: '每日对话', type: 'bool' },
  { key: 'auto_growth', label: '自动成长', type: 'bool' },
]
async function load() {
  const account = props.account!
  const id = account.id.slice(account.id.indexOf(':') + 1)
  const result = await api<{ credentials: Record<string, unknown>[] }>(
    '/p/codebuddy/admin/credentials',
  )
  const item = result.credentials.find((row) => row.name === id)
  if (!item) throw new Error('账号已不存在')
  return { ...item, enabled: item.enabled !== false && item.disabled !== true }
}
async function save(values: Record<string, unknown>) {
  for (const [key, value] of Object.entries(values))
    await consoleApi.updateAccount(props.account!.id, { [key]: value })
}
const profile = ref('cn-cli'),
  tokens = ref(''),
  show = ref(false),
  error = ref(''),
  busy = ref(false)
const site = ref('cn'),
  authStarted = ref(false)
const fileMode = ref(/upload|file|credentials/.test(props.mode)),
  files = ref<File[]>([]),
  results = ref<string[]>([])
const dirty = computed(() => Boolean(tokens.value.trim() || files.value.length))
useUnsavedChanges(dirty)
function close() {
  if (!busy.value && (!dirty.value || window.confirm('放弃未导入的凭据？'))) emit('close')
}
async function submit() {
  if (busy.value) return
  busy.value = true
  error.value = ''
  results.value = []
  try {
    let response: { results?: { name?: string; success?: boolean; ok?: boolean; error?: string }[] }
    if (fileMode.value) {
      if (!files.value.length || files.value.length > 100)
        throw new Error('请选择 1 至 100 个凭证文件')
      if (files.value.some((file) => file.size > 1024 * 1024))
        throw new Error('单个凭证文件不能超过 1 MB')
      const upload = await Promise.all(
        files.value.map(async (file) => ({ name: file.name, content: await file.text() })),
      )
      response = await api('/p/codebuddy/admin/credentials/upload', 'POST', {
        files: upload,
        replace: false,
      })
    } else {
      const list = tokens.value
        .split(/[\s,]+/)
        .map((value) => value.trim())
        .filter(Boolean)
      if (!list.length || list.length > 50) throw new Error('请填写 1 至 50 个刷新令牌')
      response = await api('/p/codebuddy/admin/credentials/refresh-import', 'POST', {
        profile: profile.value,
        refresh_tokens: list,
      })
    }
    const failures = (response.results || []).filter(
      (item) => item.error || item.ok === false || item.success === false,
    )
    if (failures.length) {
      results.value = failures.map((item) => `${item.name || '凭据'}：${item.error || '导入失败'}`)
      error.value = '部分凭据导入失败，请检查后重试。'
      return
    }
    tokens.value = ''
    files.value = []
    notify('凭据已导入')
    emit('saved')
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '导入失败'
  } finally {
    busy.value = false
  }
}
</script>
<template>
  <NativeAccountEditor
    v-if="account"
    :account="account"
    :fields="fields"
    :load="load"
    :save="save"
    @close="emit('close')"
    @saved="emit('saved')"
  />
  <AuthFlowDialog
    v-else-if="mode === 'oauth' && authStarted"
    system="codebuddy"
    :start-values="{ site }"
    @close="emit('close')"
    @authorized="emit('saved')"
  />
  <ModalShell
    v-else-if="mode === 'oauth'"
    :title="`添加账号（${channelLabel('codebuddy')}）`"
    @close="emit('close')"
    ><form @submit.prevent="authStarted = true">
      <div class="modal-body">
        <label
          >授权站点<select v-model="site">
            <option value="cn">国内站</option>
            <option value="intl">国际站</option>
          </select></label
        >
      </div>
      <footer class="modal-footer">
        <button class="button primary" type="submit">开始授权</button>
      </footer>
    </form></ModalShell
  >
  <ModalShell v-else :title="`导入账号（${channelLabel('codebuddy')}）`" :busy="busy" @close="close"
    ><form @submit.prevent="submit">
      <div class="modal-body import-form">
        <div class="segmented">
          <button
            type="button"
            :class="{ active: !fileMode }"
            :disabled="busy"
            @click="fileMode = false"
          >
            刷新令牌</button
          ><button
            type="button"
            :class="{ active: fileMode }"
            :disabled="busy"
            @click="fileMode = true"
          >
            凭证文件
          </button>
        </div>
        <template v-if="!fileMode"
          ><label
            >站点与应用<select v-model="profile" :disabled="busy">
              <option value="cn-cli">国内 · 命令行</option>
              <option value="cn-work">国内 · 工作台</option>
              <option value="intl-cli">国际 · 命令行</option>
              <option value="intl-work">国际 · 工作台</option>
            </select></label
          ><label
            >刷新令牌（空格分隔，最多 50 个）<input
              v-model="tokens"
              :type="show ? 'text' : 'password'"
              required
              :disabled="busy"
              autocomplete="off"
              spellcheck="false" /></label
          ><button type="button" class="text-link" @click="show = !show">
            {{ show ? '隐藏令牌' : '显示令牌' }}
          </button></template
        ><label v-else
          >凭证文件（最多 100 个）<input
            type="file"
            accept=".json,application/json"
            multiple
            :disabled="busy"
            @change="files = Array.from(($event.target as HTMLInputElement).files || [])"
        /></label>
        <p v-if="error" class="form-error" role="alert">{{ error }}</p>
        <ul v-if="results.length">
          <li v-for="message in results" :key="message">{{ message }}</li>
        </ul>
      </div>
      <footer class="modal-footer">
        <button type="button" class="button" :disabled="busy" @click="close">取消</button
        ><button type="submit" class="button primary" :disabled="busy || !dirty">
          {{ busy ? '导入中…' : '导入账号' }}
        </button>
      </footer>
    </form></ModalShell
  >
</template>
<style scoped>
.import-form {
  display: flex;
  flex-direction: column;
  gap: 16px;
}
.import-form label {
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.import-form .text-link {
  align-self: flex-start;
}
</style>

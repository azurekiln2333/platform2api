<script setup lang="ts">
import { computed, ref } from 'vue'
import { api, consoleApi } from '../../api.ts'
import { channelLabel, useUnsavedChanges } from '../../console.ts'
import { notify } from '../../panel.ts'
import ModalShell from '../../components/ModalShell.vue'
import AuthFlowDialog from '../../components/AuthFlowDialog.vue'
import CopyButton from '../../components/CopyButton.vue'
import NativeAccountEditor from '../../components/accounts/NativeAccountEditor.vue'
import type { AccountField } from '../../components/accounts/native-fields.ts'
import type { Account, Descriptor } from '../../console-types.ts'
const props = defineProps<{ account: Account | null; mode?: string }>()
const emit = defineEmits<{
  close: []
  saved: []
  result: [result: { id: string; label: string; display: Descriptor[] }]
}>()
const fields: AccountField[] = [
  { key: 'name', label: '显示名称' },
  { key: 'email', label: '邮箱', type: 'email' },
  {
    key: 'realm',
    label: '区服',
    type: 'select',
    options: [
      { value: '', label: '不修改' },
      { value: 'cn', label: '国内（BigModel）' },
      { value: 'intl', label: '国际（Z.ai）' },
    ],
  },
  { key: 'weight', label: '权重', type: 'number', min: 0, max: 20 },
  { key: 'codingPlanApiKey', label: 'Coding Plan 密钥', type: 'secret' },
  {
    key: 'codingPlanProvider',
    label: 'Coding Plan 渠道',
    type: 'select',
    options: [
      { value: '', label: '不修改' },
      { value: 'zai', label: 'Z.ai' },
      { value: 'bigmodel', label: 'BigModel' },
    ],
  },
  { key: 'enabled', label: '启用账号', type: 'bool' },
]
async function load() {
  const account = props.account!
  const id = account.id.slice(account.id.indexOf(':') + 1)
  const result = await api<{ accounts: Record<string, unknown>[] }>('/p/zcode/api/overview')
  const item = result.accounts.find((row) => row.label === id)
  if (!item) throw new Error('账号已不存在')
  return { ...item, enabled: item.enabled !== false && item.disabled !== true }
}
const save = (values: Record<string, unknown>) =>
  consoleApi.updateAccount(props.account!.id, values)
const provider = ref('zai'),
  authStarted = ref(false),
  planId = ref(''),
  preparation = ref(''),
  error = ref(''),
  busy = ref(false)
useUnsavedChanges(computed(() => Boolean(planId.value)))
function close() {
  if (!busy.value && (!planId.value || window.confirm('放弃未提交的套餐信息？'))) emit('close')
}
async function prepare() {
  if (!props.account || busy.value) return
  busy.value = true
  error.value = ''
  try {
    const result = (await consoleApi.accountAction(props.account.id, 'claim-start', {
      planId: planId.value,
    })) as { preparationId?: string }
    preparation.value = result.preparationId || ''
    if (!preparation.value) throw new Error('渠道未返回领取准备结果，请刷新资格后重试')
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '准备领取失败'
  } finally {
    busy.value = false
  }
}
async function claim() {
  if (!props.account || !preparation.value || busy.value) return
  busy.value = true
  error.value = ''
  try {
    const result = (await consoleApi.accountAction(props.account.id, 'claim', {
      planId: planId.value,
      preparationId: preparation.value,
    })) as { results?: { ok?: boolean; msg?: string }[]; ok?: boolean; message?: string }
    const first = result.results?.[0]
    if (first?.ok === false || result.ok === false)
      throw new Error(first?.msg || result.message || '领取未成功')
    notify(first?.msg || '套餐领取已提交')
    emit('result', {
      id: props.account.id,
      label: '领取 Coding Plan',
      display: [
        { key: 'at', label: '领取时间', kind: 'time', value: new Date().toISOString() },
        {
          key: 'result',
          label: '领取结果',
          kind: 'text',
          value: first?.msg || result.message || '套餐领取已提交',
        },
      ],
    })
    planId.value = ''
    emit('saved')
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '领取失败'
  } finally {
    busy.value = false
  }
}
</script>
<template>
  <AuthFlowDialog
    v-if="mode === 'oauth' && authStarted"
    system="zcode"
    :start-values="{ provider }"
    redeem
    @close="emit('close')"
    @authorized="emit('saved')"
  />
  <ModalShell
    v-else-if="mode === 'oauth'"
    :title="`添加账号（${channelLabel('zcode')}）`"
    @close="emit('close')"
    ><form @submit.prevent="authStarted = true">
      <div class="modal-body">
        <label
          >授权区域<select v-model="provider">
            <option value="zai">国际 · Z.ai</option>
            <option value="bigmodel">国内 · BigModel</option>
          </select></label
        >
      </div>
      <footer class="modal-footer">
        <button class="button primary" type="submit">开始授权</button>
      </footer>
    </form></ModalShell
  >
  <ModalShell
    v-else-if="account && (mode === 'claim' || mode === 'claim-start')"
    :title="`领取 Coding Plan · ${account.label}`"
    :busy="busy"
    @close="close"
    ><form @submit.prevent="preparation ? claim() : prepare()">
      <div class="modal-body">
        <label
          >套餐 ID（可选）<input
            v-model="planId"
            :disabled="busy || Boolean(preparation)"
            placeholder="留空由渠道选择可用套餐"
        /></label>
        <p v-if="preparation">
          已准备领取：<code>{{ preparation }}</code
          ><CopyButton :value="preparation" />
        </p>
        <p v-if="error" class="form-error" role="alert">{{ error }}</p>
      </div>
      <footer class="modal-footer">
        <button type="button" class="button" :disabled="busy" @click="close">取消</button
        ><button class="button primary" type="submit" :disabled="busy">
          {{ busy ? '处理中…' : preparation ? '提交领取' : '准备领取' }}
        </button>
      </footer>
    </form></ModalShell
  >
  <NativeAccountEditor
    v-else-if="account"
    :account="account"
    :fields="fields"
    :load="load"
    :save="save"
    @close="emit('close')"
    @saved="emit('saved')"
  />
</template>

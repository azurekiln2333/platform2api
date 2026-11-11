<script setup lang="ts">
import { api, consoleApi } from '../../api.ts'
import NativeAccountEditor from '../../components/accounts/NativeAccountEditor.vue'
import AuthFlowDialog from '../../components/AuthFlowDialog.vue'
import type { AccountField } from '../../components/accounts/native-fields.ts'
import type { Account } from '../../console-types.ts'
const props = defineProps<{ account: Account | null }>()
const emit = defineEmits<{ close: []; saved: [] }>()
const fields: AccountField[] = [
  { key: 'name', label: '账号名称', required: true },
  { key: 'repo', label: '仓库路径' },
  { key: 'group', label: '分组' },
  { key: 'branch', label: '工作区分支' },
  { key: 'endpoint', label: '工作区地址' },
  {
    key: 'upstreamMode',
    label: '上游模式',
    type: 'select',
    options: [
      { value: 'inherit', label: '继承全局' },
      { value: 'auto', label: '自动' },
      { value: 'ide', label: 'IDE' },
      { value: 'classic', label: 'Classic' },
    ],
  },
  { key: 'weight', label: '权重', type: 'number', min: 1, max: 100 },
  { key: 'priority', label: '优先级', type: 'number', min: 0, max: 100 },
  { key: 'proxyKey', label: '工作区密钥', type: 'secret' },
  { key: 'pat', label: '个人令牌', type: 'secret' },
  { key: 'models', label: '模型白名单', type: 'list', help: '使用逗号分隔；留空使用发现的模型。' },
  { key: 'autoWake', label: '闲置自动唤醒', type: 'bool' },
  { key: 'enabled', label: '启用账号', type: 'bool' },
]
async function load() {
  const account = props.account!
  const id = account.id.slice(account.id.indexOf(':') + 1)
  const result = await api<{ account: Record<string, unknown> }>(
    `/p/${account.system}/api/accounts/${encodeURIComponent(id)}`,
  )
  return result.account
}
const save = (values: Record<string, unknown>) =>
  consoleApi.updateAccount(props.account!.id, values)
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
  <AuthFlowDialog v-else system="cnb" @close="emit('close')" @authorized="emit('saved')" />
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import ModalShell from '../../components/ModalShell.vue'
import { notify, reportError } from '../../panel.ts'
import { accountIdentity, zcode } from './service.ts'
import type { ZcodeAccount } from './types.ts'

const props = defineProps<{ account: ZcodeAccount }>()
const emit = defineEmits<{ close: []; saved: [] }>()

const draft = ref({
  name: props.account.name ?? '',
  email: props.account.email ?? '',
  realm: props.account.realm === 'cn' || props.account.realm === 'intl' ? props.account.realm : '',
  weight: props.account.weight ?? 1,
  enabled: props.account.enabled !== false && props.account.disabled !== true,
  codingPlanApiKey: '',
  codingPlanProvider:
    props.account.codingPlanProvider === 'bigmodel' ? 'bigmodel' : props.account.codingPlanProvider === 'zai' ? 'zai' : '',
})
const saving = ref(false)
const error = ref('')

const title = computed(() => `编辑「${props.account.name || accountIdentity(props.account)}」`)

async function save() {
  if (saving.value) return
  saving.value = true
  error.value = ''
  const payload: Record<string, unknown> = {
    name: draft.value.name.trim(),
    email: draft.value.email.trim(),
    weight: Number(draft.value.weight),
    enabled: draft.value.enabled,
  }
  if (draft.value.realm) payload.realm = draft.value.realm
  if (draft.value.codingPlanApiKey.trim()) payload.codingPlanApiKey = draft.value.codingPlanApiKey.trim()
  if (draft.value.codingPlanProvider) payload.codingPlanProvider = draft.value.codingPlanProvider
  try {
    await zcode(`/api/accounts/${encodeURIComponent(props.account.label)}`, 'PATCH', payload)
    notify('账号已更新')
    emit('saved')
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '保存失败'
    reportError(cause, '保存 ZCode 账号失败')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <ModalShell :title="title" subtitle="与 zcode2api 控制台一致：留空的密钥字段不会覆盖已保存的值。" @close="emit('close')">
    <div class="modal-body">
      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
      <form class="account-form" @submit.prevent="save">
        <div class="form-grid">
          <label>显示名称<input v-model="draft.name" maxlength="60" /></label>
          <label>邮箱<input v-model="draft.email" type="email" maxlength="200" /></label>
          <label
            >区服
            <select v-model="draft.realm">
              <option value="">不修改</option>
              <option value="cn">国内（BigModel）</option>
              <option value="intl">国际（Z.ai）</option>
            </select>
          </label>
          <label>权重（0-20）<input v-model.number="draft.weight" type="number" min="0" max="20" /></label>
        </div>
        <div class="form-grid">
          <label
            >Coding Plan API Key
            <input
              v-model="draft.codingPlanApiKey"
              type="password"
              autocomplete="new-password"
              :placeholder="account.hasCodingPlanKey ? '已配置，留空则不修改' : '未配置'"
            />
          </label>
          <label
            >Coding Plan 渠道
            <select v-model="draft.codingPlanProvider">
              <option value="">不修改</option>
              <option value="zai">Z.ai</option>
              <option value="bigmodel">BigModel</option>
            </select>
          </label>
        </div>
        <label class="check-label"><input v-model="draft.enabled" type="checkbox" />启用账号</label>
        <div class="button-group">
          <button class="submit button primary" type="submit" :disabled="saving">
            {{ saving ? '保存中…' : '保存修改' }}
          </button>
        </div>
      </form>
    </div>
    <footer class="modal-footer">
      <span class="subtle">停用的账号会保留额度可见性，但不再参与调度。</span>
      <button class="button" @click="emit('close')">关闭</button>
    </footer>
  </ModalShell>
</template>

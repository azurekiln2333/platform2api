<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { LoaderCircle } from '@lucide/vue'
import ModalShell from '../ModalShell.vue'
import SystemBadge from '../SystemBadge.vue'
import { notify } from '../../panel.ts'
import { channelLabel, useUnsavedChanges } from '../../console.ts'
import type { Account } from '../../console-types.ts'
import type { AccountField } from './native-fields.ts'
const props = defineProps<{
  account: Account
  fields: AccountField[]
  load: () => Promise<Record<string, unknown>>
  save: (values: Record<string, unknown>) => Promise<unknown>
}>()
const emit = defineEmits<{ close: []; saved: [] }>()
const draft = ref<Record<string, string | number | boolean>>({})
const original = ref<Record<string, string | number | boolean>>({})
const revealed = ref<Record<string, boolean>>({})
const loading = ref(true),
  saving = ref(false),
  error = ref(''),
  loaded = ref(false),
  confirmDisable = ref(false)
const dirty = computed(
  () => loaded.value && JSON.stringify(draft.value) !== JSON.stringify(original.value),
)
useUnsavedChanges(dirty)
function close() {
  if (!saving.value && (!dirty.value || window.confirm('放弃未保存的账号修改？'))) emit('close')
}
async function reload() {
  loading.value = true
  error.value = ''
  try {
    const result = await props.load()
    draft.value = Object.fromEntries(
      props.fields.map((field) => {
        const value = result[field.key]
        return [
          field.key,
          field.type === 'secret'
            ? ''
            : field.type === 'bool'
              ? value === true
              : field.type === 'number'
                ? Number(value ?? field.min ?? 0)
                : Array.isArray(value)
                  ? value.join(', ')
                  : String(value ?? ''),
        ]
      }),
    )
    original.value = { ...draft.value }
    loaded.value = true
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '读取账号详情失败'
  } finally {
    loading.value = false
  }
}
function requestSave() {
  if (original.value.enabled === true && draft.value.enabled === false) confirmDisable.value = true
  else void save()
}
async function save() {
  if (saving.value || !dirty.value) return
  saving.value = true
  error.value = ''
  try {
    const values = Object.fromEntries(
      props.fields
        .filter(
          (field) =>
            draft.value[field.key] !== original.value[field.key] &&
            !(field.type === 'secret' && !draft.value[field.key]),
        )
        .map((field) => [
          field.key,
          field.type === 'list'
            ? String(draft.value[field.key])
                .split(/[,，\n]/)
                .map((value) => value.trim())
                .filter(Boolean)
            : draft.value[field.key],
        ]),
    )
    await props.save(values)
    original.value = { ...draft.value }
    notify('账号已更新')
    emit('saved')
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '保存账号失败'
  } finally {
    saving.value = false
  }
}
onMounted(reload)
</script>
<template>
  <ModalShell
    :title="`编辑账号「${account.label}」（${channelLabel(account.system)}）`"
    :busy="saving"
    wide
    @close="close"
    ><form @submit.prevent="requestSave">
      <div class="modal-body">
        <SystemBadge :system="account.system" />
        <p v-if="loading" role="status"><LoaderCircle :size="16" class="spin" />正在读取账号…</p>
        <p v-if="error" class="form-error" role="alert">{{ error }}</p>
        <button v-if="!loaded && !loading" type="button" class="button" @click="reload">
          重试
        </button>
        <div v-if="loaded" class="native-fields">
          <label
            v-for="field in fields"
            :key="field.key"
            :class="{ 'check-label': field.type === 'bool' }"
            ><span>{{ field.label }}</span
            ><input
              v-if="field.type === 'bool'"
              v-model="draft[field.key]"
              type="checkbox"
              :disabled="saving"
            /><select
              v-else-if="field.type === 'select'"
              v-model="draft[field.key]"
              :disabled="saving"
            >
              <option v-for="option in field.options" :key="option.value" :value="option.value">
                {{ option.label }}
              </option></select
            ><input
              v-else-if="field.type === 'number'"
              v-model.number="draft[field.key]"
              type="number"
              :min="field.min"
              :max="field.max"
              :required="field.required"
              :disabled="saving"
            /><template v-else
              ><input
                v-model="draft[field.key]"
                :type="
                  field.type === 'secret' && !revealed[field.key]
                    ? 'password'
                    : field.type === 'email'
                      ? 'email'
                      : 'text'
                "
                :placeholder="field.type === 'secret' ? '已保存，留空则不修改' : ''"
                :required="field.required"
                :disabled="saving"
                autocomplete="off"
              /><button
                v-if="field.type === 'secret'"
                type="button"
                class="text-link"
                :aria-label="`${revealed[field.key] ? '隐藏' : '显示'}${field.label}`"
                @click="revealed[field.key] = !revealed[field.key]"
              >
                {{ revealed[field.key] ? '隐藏' : '显示' }}
              </button></template
            ><small v-if="field.help">{{ field.help }}</small></label
          >
        </div>
      </div>
      <footer class="modal-footer">
        <button type="button" class="button" :disabled="saving" @click="close">取消</button
        ><button class="button primary" type="submit" :disabled="saving || loading || !dirty">
          <LoaderCircle v-if="saving" :size="15" class="spin" />{{
            saving ? '保存中…' : '保存修改'
          }}
        </button>
      </footer>
    </form></ModalShell
  >
  <ModalShell
    v-if="confirmDisable"
    :title="`停用账号「${account.label}」（${channelLabel(account.system)}）`"
    :busy="saving"
    @close="confirmDisable = false"
    ><div class="modal-body">
      停用后该账号不再参与请求调度。
      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
    </div>
    <footer class="modal-footer">
      <button class="button" :disabled="saving" @click="confirmDisable = false">取消</button
      ><button class="button danger" :disabled="saving" @click="save">
        {{ saving ? '停用中…' : '停用并保存' }}
      </button>
    </footer></ModalShell
  >
</template>
<style scoped>
.native-fields {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 16px;
  margin-top: 18px;
}
.native-fields label {
  display: flex;
  flex-direction: column;
  gap: 7px;
}
.native-fields small {
  color: var(--muted);
}
.native-fields input[type='checkbox'] {
  width: 18px;
  height: 18px;
  min-height: 0;
}
.native-fields .check-label {
  flex-direction: row;
  align-items: center;
}
@media (max-width: 600px) {
  .native-fields {
    grid-template-columns: 1fr;
  }
}
</style>

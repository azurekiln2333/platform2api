<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import { api } from '../../api.ts'
import { channelLabel, errorText, useUnsavedChanges } from '../../console.ts'
import { notify } from '../../panel.ts'
import type { Field, ModelItem } from '../../console-types.ts'
import SystemBadge from '../SystemBadge.vue'
import ModalShell from '../ModalShell.vue'
import SchemaFields from '../SchemaFields.vue'
import ConfirmAction from '../ConfirmAction.vue'

const props = defineProps<{ system: string; item?: ModelItem | null }>()
const emit = defineEmits<{ saved: []; close: [] }>()
const base = computed(() => `/p/${encodeURIComponent(props.system)}/admin/models`)
const opened = ref(false),
  loading = ref(false),
  busy = ref(false),
  error = ref('')
const nativeId = ref(''),
  revision = ref<number | null>(null),
  baseline = ref('')
const values = ref<Record<string, unknown>>({})
const preserved = ref<Record<string, unknown>>({})
const custom = ref(false),
  originallyEnabled = ref(true)
const form = ref<HTMLFormElement>()
let live = true,
  generation = 0
const fields = computed<Field[]>(() => [
  { key: 'public_id', label: '对外模型 ID', type: 'text', required: true },
  { key: 'upstream_id', label: '上游模型 ID', type: 'text', required: true },
  { key: 'region', label: '区域', type: 'text', help: '留空表示不限' },
  { key: 'profile', label: '端点', type: 'text', help: '留空表示不限' },
  {
    key: 'credential_ids',
    label: '绑定账号 ID',
    type: 'list',
    help: '每行一个账号 ID，留空按渠道规则选择',
  },
  { key: 'enabled', label: '启用模型', type: 'bool' },
  ...(!custom.value ? [{ key: 'keep_original', label: '保留原模型 ID', type: 'bool' }] : []),
])
const dirty = computed(
  () => opened.value && (busy.value || JSON.stringify(values.value) !== baseline.value),
)
useUnsavedChanges(dirty)

async function open(item: ModelItem | null) {
  opened.value = true
  loading.value = true
  error.value = ''
  values.value = {}
  baseline.value = '{}'
  revision.value = null
  preserved.value = {}
  nativeId.value = item ? item.id.slice(item.id.indexOf(':') + 1) : ''
  const request = ++generation
  try {
    const catalog = await api<{ revision: number; models: Record<string, unknown>[] }>(base.value)
    if (!live || request !== generation) return
    if (!Number.isInteger(catalog.revision) || !Array.isArray(catalog.models))
      throw new Error('模型目录格式不正确，请重试')
    const row = item ? catalog.models.find((model) => model.id === nativeId.value) : undefined
    if (item && !row) throw new Error('模型已不在目录中，请关闭后刷新列表')
    revision.value = catalog.revision
    originallyEnabled.value = row?.enabled !== false
    custom.value = !item || row?.custom === true
    values.value = {
      public_id: row?.public_id || row?.id || '',
      upstream_id: row?.upstream_id || row?.id || '',
      region: row?.region || '',
      profile: row?.profile || '',
      credential_ids: Array.isArray(row?.credential_ids) ? [...row.credential_ids] : [],
      enabled: row?.enabled !== false,
      keep_original: row?.keep_original === true,
    }
    preserved.value = Object.fromEntries(
      ['routes', 'credits_override']
        .filter((key) => row?.[key] !== undefined)
        .map((key) => [key, row![key]]),
    )
    baseline.value = JSON.stringify(values.value)
  } catch (cause) {
    if (live && request === generation) error.value = errorText(cause)
  } finally {
    if (live && request === generation) {
      loading.value = false
      await nextTick()
      form.value?.querySelector<HTMLInputElement>('input:not([disabled])')?.focus()
    }
  }
}
function close() {
  if (busy.value || (dirty.value && !window.confirm('放弃尚未保存的模型修改？'))) return
  generation++
  opened.value = false
  emit('close')
}
async function save(confirmDisable = false) {
  if (busy.value || loading.value || revision.value === null) return
  if (nativeId.value && originallyEnabled.value && !values.value.enabled && !confirmDisable) {
    confirmation.value = {
      title: `停用模型「${props.item?.model || values.value.public_id}」（${channelLabel(props.system)}）`,
      description: '停用后，此渠道将不再接受该模型的调用。',
      verb: '停用',
      danger: true,
      action: async () => {
        await save(true)
        if (error.value) throw new Error(error.value)
      },
    }
    return
  }
  busy.value = true
  error.value = ''
  try {
    const payload = {
      ...preserved.value,
      ...values.value,
      revision: revision.value,
      region: values.value.region || null,
      profile: values.value.profile || null,
    }
    const result = await api<{ revision: number }>(
      nativeId.value
        ? `${base.value}/${nativeId.value.split('/').map(encodeURIComponent).join('/')}`
        : base.value,
      nativeId.value ? 'PUT' : 'POST',
      payload,
    )
    if (!Number.isInteger(result.revision) || result.revision <= revision.value)
      throw new Error('服务尚未确认模型保存，请刷新核对结果')
    baseline.value = JSON.stringify(values.value)
    opened.value = false
    notify('模型已保存')
    emit('close')
    emit('saved')
  } catch (cause) {
    error.value = errorText(cause)
  } finally {
    busy.value = false
  }
}
const confirmation = ref<{
  title: string
  description: string
  verb: string
  danger: boolean
  action: () => Promise<unknown>
} | null>(null)
const job = ref('')
function start(kind: 'scan' | 'rate-probe') {
  const verb = kind === 'scan' ? '扫描目录' : '计费探测'
  confirmation.value = {
    title: `${verb}（${channelLabel(props.system)}）`,
    verb,
    danger: kind === 'rate-probe',
    description:
      kind === 'rate-probe'
        ? '将探测此渠道的标称免费模型，实际计费时可能消耗少量积分。'
        : '将扫描此渠道的模型目录并更新可用模型。',
    action: async () => {
      await api(`${base.value}/${kind}`, 'POST', {})
      job.value = `已启动${verb}`
      notify(job.value)
      emit('saved')
    },
  }
}
watch(
  () => props.item,
  (item) => {
    if (item) void open(item)
  },
  { immediate: true },
)
onBeforeUnmount(() => {
  live = false
  generation++
})
</script>

<template>
  <div class="console-toolbar catalog-tools">
    <SystemBadge :system="system" />
    <button class="button" :aria-label="`扫描目录 ${channelLabel(system)}`" @click="start('scan')">
      扫描目录
    </button>
    <button
      class="button"
      :aria-label="`计费探测 ${channelLabel(system)}`"
      @click="start('rate-probe')"
    >
      计费探测
    </button>
    <button class="button" :aria-label="`新建模型 ${channelLabel(system)}`" @click="open(null)">
      新建模型
    </button>
    <span v-if="job" role="status">{{ job }}</span>
  </div>
  <ModalShell
    v-if="opened"
    :title="
      nativeId
        ? `编辑模型「${item?.model || values.public_id}」（${channelLabel(system)}）`
        : `新建模型（${channelLabel(system)}）`
    "
    :busy="busy"
    wide
    @close="close"
  >
    <form ref="form" @submit.prevent="save()">
      <div class="modal-body">
        <p v-if="loading" class="loading-state">正在读取模型规则…</p>
        <SchemaFields
          v-else
          v-model="values"
          :fields="fields"
          :disabled="busy || revision === null"
          :error="error"
        />
        <p v-if="error" class="form-error" role="alert">{{ error }}</p>
        <button
          v-if="error && revision === null"
          type="button"
          class="button"
          @click="open(item || null)"
        >
          重试
        </button>
      </div>
      <footer class="modal-footer">
        <button type="button" class="button" :disabled="busy" @click="close">取消</button>
        <button
          type="submit"
          class="button primary"
          :disabled="
            busy ||
            loading ||
            revision === null ||
            !dirty ||
            !values.public_id ||
            !values.upstream_id
          "
        >
          {{ busy ? '保存中…' : '保存' }}
        </button>
      </footer>
    </form>
  </ModalShell>
  <ConfirmAction v-if="confirmation" v-bind="confirmation" @close="confirmation = null" />
</template>

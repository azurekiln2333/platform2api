<script setup lang="ts">
import { computed, ref } from 'vue'
import { LoaderCircle, Plus, X } from '@lucide/vue'
import ModalShell from './ModalShell.vue'
import SystemBadge from './SystemBadge.vue'
import { notify, reportError, saveTags } from '../panel.ts'
import { MAX_TAGS, MAX_TAG_LENGTH, normalizeTags, systemTag } from '../systems.ts'
import type { PanelAccount } from '../types.ts'

const props = defineProps<{ account: PanelAccount; knownTags?: string[] }>()
const emit = defineEmits<{ close: [] }>()

const draft = ref<string[]>(normalizeTags(props.account.tags))
const input = ref('')
const saving = ref(false)
const error = ref('')
const suggestions = computed(() =>
  (props.knownTags ?? []).filter((tag) => !draft.value.includes(tag)).slice(0, 8),
)

function add(raw?: string) {
  const value = (raw ?? input.value).trim()
  if (!value) return
  if (draft.value.length >= MAX_TAGS) {
    error.value = `最多 ${MAX_TAGS} 个标签`
    return
  }
  const next = normalizeTags([...draft.value, value])
  if (next.length === draft.value.length) {
    error.value =
      value.length > MAX_TAG_LENGTH
        ? `单个标签最多 ${MAX_TAG_LENGTH} 个字符`
        : '标签重复或为系统标签'
    return
  }
  draft.value = next
  input.value = ''
  error.value = ''
}

function remove(tag: string) {
  draft.value = draft.value.filter((item) => item !== tag)
}

async function save() {
  saving.value = true
  error.value = ''
  try {
    // The panel store owns the row; re-emitting a stale account here would undo it.
    await saveTags(props.account, draft.value)
    emit('close')
  } catch (failure) {
    error.value = failure instanceof Error ? failure.message : '标签保存失败'
    reportError(failure, '标签保存失败')
  } finally {
    saving.value = false
  }
}

function clearAll() {
  draft.value = []
  notify('已清空自定义标签，保存后生效')
}
</script>

<template>
  <ModalShell
    title="编辑账号标签"
    :subtitle="`标签由面板维护（data/panel/tags.json）；系统标签由平台自动生成，不能修改。`"
    @close="emit('close')"
  >
    <div class="modal-body">
      <p class="form-section-title"><SystemBadge :system="account.system" /> {{ account.label }}</p>
      <div class="tag-chips">
        <span class="tag-chip system" :data-testid="`system-tag-${account.system}`">
          {{ systemTag(account.system) }} · 系统
        </span>
        <span v-for="tag in draft" :key="tag" class="tag-chip" data-testid="tag-chip">
          {{ tag }}
          <button type="button" aria-label="移除标签" @click="remove(tag)"><X :size="12" /></button>
        </span>
        <span v-if="!draft.length" class="cell-secondary">还没有自定义标签</span>
      </div>
      <form class="tag-add" @submit.prevent="add()">
        <label>
          新增标签
          <input
            v-model="input"
            name="tag"
            :maxlength="MAX_TAG_LENGTH"
            placeholder="例如：主力、测试、华东"
            data-testid="tag-input"
          />
        </label>
        <button type="submit" class="button"><Plus :size="14" /><span>添加</span></button>
      </form>
      <div v-if="suggestions.length" class="tag-suggestions">
        <span class="cell-secondary">已有标签：</span>
        <button
          v-for="tag in suggestions"
          :key="tag"
          type="button"
          class="tag-chip ghost"
          @click="add(tag)"
        >
          {{ tag }}
        </button>
      </div>
      <p v-if="error" class="form-error" role="alert" data-testid="tag-error">{{ error }}</p>
      <p class="inline-hint">过滤与标签保存在面板侧；删除标签不会影响各系统自身的账号数据。</p>
    </div>
    <footer class="modal-footer">
      <button class="text-link" type="button" @click="clearAll">清空自定义标签</button>
      <div class="button-group">
        <button class="button" @click="emit('close')">取消</button>
        <button class="button primary" :disabled="saving" data-testid="tag-save" @click="save">
          <LoaderCircle v-if="saving" :size="15" class="spin" /><span>保存标签</span>
        </button>
      </div>
    </footer>
  </ModalShell>
</template>

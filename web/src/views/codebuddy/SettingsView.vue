<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { LoaderCircle, Lock, RefreshCw, Save } from '@lucide/vue'
import { notify, reportError } from '../../panel.ts'
import { codebuddy, isRevisionConflict } from './service.ts'
import type { CodeBuddySettingsItem } from './service.ts'

const items = ref<CodeBuddySettingsItem[]>([])
const revision = ref<number | null>(null)
const draft = ref<Record<string, unknown>>({})
const loading = ref(false)
const saving = ref(false)
const error = ref('')
const conflict = ref(false)

const editable = computed(() => items.value.filter((item) => !item.locked))

const dirty = computed(() => editable.value.filter((item) => draft.value[item.key] !== item.value))

async function load() {
  loading.value = true
  conflict.value = false
  try {
    const result = await codebuddy<{ revision: number | null; items: CodeBuddySettingsItem[] }>(
      '/admin/settings',
    )
    items.value = Array.isArray(result.items) ? result.items : []
    revision.value = result.revision ?? null
    draft.value = Object.fromEntries(items.value.map((item) => [item.key, item.value]))
    error.value = ''
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '无法读取 CodeBuddy 设置'
  } finally {
    loading.value = false
  }
}

/**
 * Writes carry the revision this page was rendered from. A 409 means another
 * session saved first: reload instead of overwriting it.
 */
async function save() {
  if (!dirty.value.length) {
    notify('没有需要保存的修改。')
    return
  }
  saving.value = true
  conflict.value = false
  const values = Object.fromEntries(dirty.value.map((item) => [item.key, draft.value[item.key]]))
  try {
    const result = await codebuddy<{ revision: number | null }>('/admin/settings', 'PATCH', {
      values,
      revision: revision.value,
    })
    revision.value = result.revision ?? revision.value
    await load()
    notify('设置已保存')
  } catch (cause) {
    if (isRevisionConflict(cause)) conflict.value = true
    else reportError(cause, '保存设置失败')
  } finally {
    saving.value = false
  }
}

const sourceLabel = (item: CodeBuddySettingsItem) =>
  item.locked
    ? '锁定'
    : item.mode === 'startup'
      ? '需重启'
      : item.mode === 'readonly'
        ? '只读'
        : '可修改'

onMounted(load)
</script>

<template>
  <section>
    <header class="page-heading">
      <div>
        <span class="eyebrow"><i class="blue-line" /> CODEBUDDY SETTINGS</span>
        <h1>CodeBuddy 设置</h1>
        <p>写入携带配置版本 {{ revision ?? '—' }}；版本冲突时会提示重新加载，不会覆盖他人修改。</p>
      </div>
      <div class="heading-actions">
        <button class="button" :disabled="loading" @click="load">
          <RefreshCw :size="15" :class="{ spin: loading }" /><span>重新加载</span>
        </button>
        <button class="button primary" :disabled="saving || !dirty.length" @click="save">
          <LoaderCircle v-if="saving" :size="15" class="spin" />
          <Save v-else :size="15" />
          <span>保存 {{ dirty.length || '' }}</span>
        </button>
      </div>
    </header>

    <div v-if="conflict" class="note-box conflict" role="alert">
      <span>配置已被其他会话修改，请重新加载后再保存。</span>
      <button class="button" @click="load">重新加载</button>
    </div>

    <div v-if="error" class="error-banner" role="alert">
      <span>{{ error }}</span
      ><button @click="load">重试读取设置</button>
    </div>

    <div v-if="loading && !items.length" class="page-loading">
      <LoaderCircle :size="20" class="spin" /><span>正在读取设置…</span>
    </div>

    <div v-else-if="!items.length" class="empty-filter">
      <h3>暂无可显示的设置项</h3>
      <p>该服务未返回任何可编辑配置。</p>
    </div>

    <div v-else class="table-scroll">
      <table class="account-table">
        <thead>
          <tr>
            <th>设置项</th>
            <th>值</th>
            <th>状态</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in items" :key="item.key">
            <td>
              <strong>{{ item.label || item.key }}</strong>
              <p class="cell-secondary mono">{{ item.key }}</p>
            </td>
            <td>
              <span v-if="item.locked" class="locked-cell">
                <Lock :size="13" />{{ item.value }}
              </span>
              <input
                v-else-if="typeof item.value === 'boolean'"
                v-model="draft[item.key]"
                type="checkbox"
                :aria-label="item.label || item.key"
              />
              <input
                v-else-if="typeof item.value === 'number'"
                v-model.number="draft[item.key]"
                class="input"
                type="number"
                :aria-label="item.label || item.key"
              />
              <input
                v-else
                v-model="draft[item.key]"
                class="input"
                :aria-label="item.label || item.key"
              />
            </td>
            <td class="cell-secondary">{{ sourceLabel(item) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
  </section>
</template>

<style scoped>
.conflict {
  justify-content: space-between;
  margin-bottom: 18px;
}
.locked-cell {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  color: var(--muted);
  font-size: 12px;
}
</style>

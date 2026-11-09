<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { Copy, Layers, LoaderCircle, RefreshCw, Search, X } from '@lucide/vue'
import { copy, notify, reportError } from '../../panel.ts'
import { codebuddy } from './service.ts'

interface CodeBuddyModel {
  id?: string
  policy?: unknown
  [key: string]: unknown
}

const models = ref<CodeBuddyModel[]>([])
const revision = ref<number | null>(null)
const search = ref('')
const loading = ref(false)
const loaded = ref(false)
const error = ref('')
const scanning = ref(false)
const probing = ref(false)
let active = false
let generation = 0
let poll: number | undefined

const filtered = computed(() => {
  const query = search.value.trim().toLowerCase()
  if (!query) return models.value
  return models.value.filter((model) =>
    String(model.id ?? '')
      .toLowerCase()
      .includes(query),
  )
})

async function refresh() {
  if (document.hidden || loading.value) return
  const request = ++generation
  loading.value = true
  try {
    const result = await codebuddy<{ revision: number | null; models: CodeBuddyModel[] }>(
      '/admin/models',
    )
    if (!active || request !== generation) return
    if (!Array.isArray(result.models)) throw new Error('模型列表格式不正确')
    models.value = result.models
    revision.value = result.revision ?? null
    loaded.value = true
    error.value = ''
  } catch (cause) {
    if (active && request === generation)
      error.value = cause instanceof Error ? cause.message : '无法读取 CodeBuddy 模型'
  } finally {
    if (active && request === generation) loading.value = false
  }
}

const policyOf = (model: CodeBuddyModel) =>
  model.policy && typeof model.policy === 'object' ? JSON.stringify(model.policy) : '—'

/** A 409 means the catalog moved: reload instead of overwriting it. */
async function remove(model: CodeBuddyModel) {
  const id = String(model.id ?? '')
  if (!id) return
  if (!confirm(`删除模型 ${id}？`)) return
  try {
    // The service takes `revision` as a query parameter on DELETE.
    const query = revision.value === null ? '' : `?revision=${revision.value}`
    await codebuddy(`/admin/models/${id}${query}`, 'DELETE')
    await refresh()
    notify('模型已删除')
  } catch (cause) {
    reportError(cause, '删除模型失败；若提示冲突请先刷新')
  }
}

/** Creating a custom model is revision-aware, like every catalog write. */
async function create() {
  const publicId = prompt('新模型的公开 ID')
  if (!publicId) return
  try {
    await codebuddy('/admin/models', 'POST', { public_id: publicId, revision: revision.value })
    await refresh()
    notify('模型已创建')
  } catch (cause) {
    reportError(cause, '创建模型失败；若提示冲突请先刷新')
  }
}

/** One user-triggered catalog scan; the service never runs it periodically. */
async function scan() {
  scanning.value = true
  try {
    await codebuddy('/admin/models/scan', 'POST', {})
    notify('已启动目录扫描')
    await refresh()
  } catch (cause) {
    reportError(cause, '启动目录扫描失败')
  } finally {
    scanning.value = false
  }
}

/** Probing every nominally free model can spend a little credit. */
async function probe() {
  if (!confirm('对所有标称免费模型各探测一次？若实际计费会消耗少量积分。')) return
  probing.value = true
  try {
    await codebuddy('/admin/models/rate-probe', 'POST', {})
    notify('已启动计费探测')
  } catch (cause) {
    reportError(cause, '启动计费探测失败')
  } finally {
    probing.value = false
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
        <span class="eyebrow"><i class="blue-line" /> CODEBUDDY MODELS</span>
        <h1>
          CodeBuddy 模型<span class="heading-count"
            >{{ filtered.length }} / {{ models.length }}</span
          >
        </h1>
        <p>目录版本 {{ revision ?? '—' }}；写入携带版本号，冲突时以服务返回的版本为准。</p>
      </div>
      <div class="heading-actions">
        <button class="button" :disabled="scanning" @click="scan">
          <LoaderCircle v-if="scanning" :size="15" class="spin" /><span>扫描目录</span>
        </button>
        <button class="button" :disabled="probing" @click="probe">
          <LoaderCircle v-if="probing" :size="15" class="spin" /><span>计费探测</span>
        </button>
        <button class="button primary" @click="create"><span>新建模型</span></button>
        <button class="button" :disabled="loading" @click="refresh">
          <RefreshCw :size="15" :class="{ spin: loading }" /><span>刷新模型</span>
        </button>
      </div>
    </header>

    <div v-if="error" class="error-banner" role="alert">
      <span>{{ error }}</span
      ><button @click="refresh">重试读取模型</button>
    </div>

    <div v-if="loading && !loaded" class="page-loading">
      <LoaderCircle :size="20" class="spin" /><span>正在读取模型列表…</span>
    </div>

    <section v-else class="section-panel">
      <div class="table-toolbar">
        <label class="search-field">
          <Search :size="15" />
          <input v-model="search" type="search" aria-label="搜索模型" placeholder="搜索模型 ID…" />
          <button
            v-if="search"
            type="button"
            class="icon-button"
            aria-label="清空模型搜索"
            @click="search = ''"
          >
            <X :size="13" />
          </button>
        </label>
        <span class="subtle">{{ models.length }} 个模型</span>
      </div>

      <div v-if="!filtered.length" class="empty-filter">
        <Layers :size="28" />
        <h3>{{ search ? '没有匹配的模型' : '暂无模型' }}</h3>
        <p>{{ search ? '更换搜索关键字后重试。' : '该服务未返回任何模型配置。' }}</p>
      </div>

      <div v-else class="table-scroll">
        <table class="account-table">
          <thead>
            <tr>
              <th>模型 ID</th>
              <th>策略</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="model in filtered" :key="String(model.id)">
              <td>
                <div class="model-id">
                  <strong class="mono">{{ model.id }}</strong>
                  <button
                    class="icon-button"
                    :aria-label="`复制模型 ID ${model.id}`"
                    @click="copy(String(model.id))"
                  >
                    <Copy :size="14" />
                  </button>
                </div>
              </td>
              <td>
                <code class="cell-secondary">{{ policyOf(model) }}</code>
              </td>
              <td>
                <button class="button danger" @click="remove(model)">删除</button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </section>
</template>

<style scoped>
.model-id {
  display: flex;
  align-items: flex-start;
  gap: 6px;
}
</style>

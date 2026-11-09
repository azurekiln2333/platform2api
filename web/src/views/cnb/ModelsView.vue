<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { Copy, Info, Layers, LoaderCircle, RefreshCw, Search, X } from '@lucide/vue'
import { copy } from '../../panel.ts'
import { cnb } from './service.ts'
import type { CnbModelEntry } from './types.ts'

const models = ref<CnbModelEntry[]>([])
const search = ref('')
const loading = ref(false)
const loaded = ref(false)
const error = ref('')
let active = false
let generation = 0
let poll: number | undefined

const filtered = computed(() => {
  const query = search.value.trim().toLowerCase()
  if (!query) return models.value
  return models.value.filter((model) =>
    [
      model.id,
      ...model.configuredAccounts.flatMap((account) => [account.id, account.name]),
      ...model.discoveredAccounts.flatMap((account) => [account.id, account.name]),
      ...model.eligibleAccounts.flatMap((account) => [account.id, account.name]),
    ]
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
    const result = await cnb<{ models: CnbModelEntry[] }>('/api/models')
    if (!active || request !== generation) return
    if (!Array.isArray(result.models)) throw new Error('模型列表格式不正确')
    models.value = result.models
    loaded.value = true
    error.value = ''
  } catch (cause) {
    if (active && request === generation)
      error.value = cause instanceof Error ? cause.message : '无法读取模型列表'
  } finally {
    if (active && request === generation) loading.value = false
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
        <span class="eyebrow"><i class="blue-line" /> CNB MODELS</span>
        <h1>CNB 模型列表<span class="heading-count">{{ filtered.length }} / {{ models.length }}</span></h1>
        <p>账号声明、上游发现与当前路由状态；公开列表对应服务的 /v1/models。</p>
      </div>
      <div class="heading-actions">
        <button class="button" :disabled="loading" @click="refresh">
          <RefreshCw :size="15" :class="{ spin: loading }" /><span>刷新模型</span>
        </button>
      </div>
    </header>

    <div class="note-box models-note">
      <Info :size="16" />
      <span>上游发现不代表推理已验证。配置声明表示账号允许使用该模型。</span>
    </div>

    <section class="section-panel">
      <div class="table-toolbar">
        <label class="search-field">
          <Search :size="15" />
          <input v-model="search" type="search" aria-label="搜索模型" placeholder="搜索模型 ID、账号或来源…" />
          <button v-if="search" type="button" class="icon-button" aria-label="清空模型搜索" @click="search = ''">
            <X :size="13" />
          </button>
        </label>
        <span class="subtle">{{ models.length }} 个模型</span>
      </div>

      <div v-if="error" class="error-banner" role="alert">
        <span>{{ error }}</span><button @click="refresh">重试读取模型</button>
      </div>
      <div v-if="loading && !loaded" class="page-loading">
        <LoaderCircle :size="20" class="spin" /><span>正在读取模型列表…</span>
      </div>
      <div v-else-if="!filtered.length" class="empty-filter">
        <Layers :size="28" />
        <h3>{{ search ? '没有匹配的模型' : '暂无模型' }}</h3>
        <p>{{ search ? '更换搜索关键字后重试。' : '先配置账号模型，或探活工作区以发现模型。' }}</p>
        <button v-if="search" class="button" @click="search = ''">清空搜索</button>
      </div>
      <div v-else class="table-scroll">
        <table class="account-table">
          <thead>
            <tr><th>模型 ID</th><th>来源及账号</th><th>公开列表</th><th>当前路由</th></tr>
          </thead>
          <tbody>
            <tr v-for="model in filtered" :key="model.id">
              <td>
                <div class="model-id">
                  <strong class="mono">{{ model.id }}</strong>
                  <button class="icon-button" :aria-label="`复制模型 ID ${model.id}`" @click="copy(model.id)">
                    <Copy :size="14" />
                  </button>
                </div>
              </td>
              <td>
                <p v-if="model.discoveredAccounts.length" class="model-source">
                  <span class="group-tag">上游发现</span>
                  {{ model.discoveredAccounts.map((account) => account.name).join('、') }}
                </p>
                <p v-if="model.configuredAccounts.length" class="model-source">
                  <span class="group-tag">配置声明</span>
                  {{ model.configuredAccounts.map((account) => account.name).join('、') }}
                </p>
                <span v-if="!model.discoveredAccounts.length && !model.configuredAccounts.length" class="cell-secondary">无</span>
              </td>
              <td>
                <span :class="model.listed ? 'success-text' : 'cell-secondary'">{{ model.listed ? '已收录' : '未收录' }}</span>
              </td>
              <td>
                <span :class="model.eligibleAccounts.length ? 'success-text' : 'cell-secondary'">
                  {{ model.eligibleAccounts.length }} 个就绪账号
                </span>
                <p class="model-source">
                  {{ model.eligibleAccounts.map((account) => account.name).join('、') || '暂无就绪账号' }}
                </p>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </section>
</template>

<style scoped>
.models-note {
  margin-bottom: 18px;
}
.model-id {
  display: flex;
  align-items: flex-start;
  gap: 6px;
}
.model-source {
  margin: 0 0 6px;
  color: var(--secondary);
  font-size: 12px;
  line-height: 1.7;
}
</style>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { Copy, Info, Layers, LoaderCircle, RefreshCw, Search, X } from '@lucide/vue'
import { copy } from '../../panel.ts'
import { zcode } from './service.ts'
import type { ZcodeModelEntry } from './types.ts'

const models = ref<ZcodeModelEntry[]>([])
const search = ref('')
const loading = ref(false)
const error = ref('')

const filtered = computed(() => {
  const text = search.value.trim().toLowerCase()
  if (!text) return models.value
  return models.value.filter((model) =>
    [
      model.id,
      ...(model.configuredAccounts ?? []).flatMap((account) => [account.id, account.name]),
      ...(model.discoveredAccounts ?? []).flatMap((account) => [account.id, account.name]),
      ...(model.eligibleAccounts ?? []).flatMap((account) => [account.id, account.name]),
    ]
      .join(' ')
      .toLowerCase()
      .includes(text),
  )
})

async function refresh() {
  loading.value = true
  try {
    const result = await zcode<{ models: ZcodeModelEntry[] }>('/api/models')
    if (!Array.isArray(result.models)) throw new Error('ZCode 模型列表格式不正确')
    models.value = result.models
    error.value = ''
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '无法读取 ZCode 模型列表'
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  void refresh()
})
</script>

<template>
  <section>
    <header class="page-heading">
      <div>
        <span class="eyebrow"><i class="blue-line" /> ZCODE MODELS</span>
        <h1>ZCode 模型列表<span class="heading-count">{{ filtered.length }} / {{ models.length }}</span></h1>
        <p>模型清单来自 ZCode 服务配置；可用账号由调度器当前状态决定。</p>
      </div>
      <div class="heading-actions">
        <button class="button" :disabled="loading" @click="refresh">
          <RefreshCw :size="15" :class="{ spin: loading }" /><span>刷新模型</span>
        </button>
      </div>
    </header>

    <div class="note-box models-note">
      <Info :size="16" />
      <span>ZCode 的模型清单由服务内置与 ZCODE_EXTRA_MODELS 决定；公开列表对应 /v1/models。</span>
    </div>

    <section class="section-panel">
      <div class="table-toolbar">
        <label class="search-field">
          <Search :size="15" />
          <input v-model="search" type="search" aria-label="搜索 ZCode 模型" placeholder="搜索模型 ID 或账号…" />
          <button v-if="search" class="icon-button" aria-label="清空模型搜索" @click="search = ''"><X :size="13" /></button>
        </label>
        <span class="subtle">{{ models.length }} 个模型</span>
      </div>
      <div v-if="error" class="error-banner" role="alert"><span>{{ error }}</span><button @click="refresh">重试</button></div>
      <div v-if="loading && !models.length" class="page-loading">
        <LoaderCircle :size="20" class="spin" /><span>正在读取模型列表…</span>
      </div>
      <div v-else-if="!filtered.length" class="empty-filter">
        <Layers :size="28" /><h3>{{ search ? '没有匹配的模型' : '暂无模型' }}</h3>
      </div>
      <div v-else class="table-scroll">
        <table class="account-table">
          <thead><tr><th>模型 ID</th><th>配置声明</th><th>上游发现</th><th>可用账号</th></tr></thead>
          <tbody>
            <tr v-for="model in filtered" :key="model.id">
              <td>
                <div class="zc-model-id">
                  <strong class="mono">{{ model.id }}</strong>
                  <button class="icon-button" :aria-label="`复制模型 ID ${model.id}`" @click="copy(model.id)">
                    <Copy :size="14" />
                  </button>
                </div>
              </td>
              <td class="cell-secondary">
                {{ (model.configuredAccounts ?? []).map((account) => account.name || account.id).join('、') || '—' }}
              </td>
              <td class="cell-secondary">
                {{ (model.discoveredAccounts ?? []).map((account) => account.name || account.id).join('、') || '—' }}
              </td>
              <td>
                <span :class="(model.eligibleAccounts ?? []).length ? 'success-text' : 'cell-secondary'">
                  {{ (model.eligibleAccounts ?? []).length }} 个账号
                </span>
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
.zc-model-id {
  display: flex;
  align-items: center;
  gap: 6px;
}
</style>

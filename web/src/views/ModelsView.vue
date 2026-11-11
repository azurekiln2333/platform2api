<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue'
import { consoleApi } from '../api.ts'
import { channels, queryValue, errorText, channelLabel, channelOnline } from '../console.ts'
import type { ModelItem, AggregateError, Action } from '../console-types.ts'
import { notify } from '../panel.ts'
import ChannelFilter from '../components/ChannelFilter.vue'
import PartialErrors from '../components/PartialErrors.vue'
import SystemBadge from '../components/SystemBadge.vue'
import CopyButton from '../components/CopyButton.vue'
import DescriptorList from '../components/DescriptorList.vue'
import ConfirmAction from '../components/ConfirmAction.vue'
import { modelExtensions } from '../components/models/extensions.ts'
const items = ref<ModelItem[]>([]),
  errors = ref<AggregateError[]>([]),
  error = ref(''),
  loading = ref(false)
const system = queryValue('system'),
  search = queryValue('q'),
  merge = queryValue('merge')
const editing = ref<ModelItem | null>(null)
const tools = computed(() =>
  channels.value
    .filter(
      (channel) =>
        (!system.value || channel.system === system.value) &&
        channelOnline(channel.system) &&
        channel.capabilities.models.toggle &&
        modelExtensions[channel.system] &&
        (items.value.some(
          (item) =>
            item.system === channel.system &&
            item.actions?.some((action) => action.id === 'update'),
        ) ||
          (!loading.value &&
            !error.value &&
            !errors.value.some((entry) => entry.system === channel.system) &&
            !items.value.some((item) => item.system === channel.system))),
    )
    .map((channel) => ({ system: channel.system, component: modelExtensions[channel.system] })),
)
const counts = computed(() =>
  items.value.reduce<Record<string, number>>((r, item) => {
    r[item.system] = (r[item.system] || 0) + 1
    return r
  }, {}),
)
const rows = computed(() => {
  const rows = new Map<string, ModelItem[]>()
  for (const item of items.value) {
    if (
      (system.value && system.value !== item.system) ||
      (search.value &&
        !`${item.model} ${item.display?.map((d) => d.value).join(' ')}`
          .toLowerCase()
          .includes(search.value.toLowerCase()))
    )
      continue
    const key = merge.value === '1' ? item.model : item.id
    rows.set(key, [...(rows.get(key) || []), item])
  }
  return [...rows].map(([id, entries]) => ({ id, entries, model: entries[0].model }))
})
let live = true,
  generation = 0
async function load() {
  const request = ++generation
  loading.value = true
  try {
    const response = await consoleApi.models()
    if (live && request === generation) {
      items.value = response.items || []
      errors.value = response.errors || []
      error.value = ''
    }
  } catch (e) {
    if (live && request === generation) error.value = errorText(e)
  } finally {
    if (live && request === generation) loading.value = false
  }
}
const confirmation = ref<{
  title: string
  description?: string
  verb: string
  danger: boolean
  action: () => Promise<unknown>
} | null>(null)
function act(item: ModelItem, action: Action) {
  if (action.id === 'update' && modelExtensions[item.system]) {
    editing.value = item
    return
  }
  confirmation.value = {
    title: `${action.label}模型「${item.model}」（${channelLabel(item.system)}）`,
    description: typeof action.confirm === 'string' ? action.confirm : undefined,
    verb: action.label,
    danger: !!action.danger,
    action: async () => {
      await consoleApi.modelAction(item.id, action.id, {
        revision: item.revision,
        ...(action.id === 'toggle' ? { enabled: !item.enabled } : {}),
      })
      notify('模型已更新')
      void load()
    },
  }
}
onMounted(() => void load())
onBeforeUnmount(() => {
  live = false
  generation++
})
</script>
<template>
  <section>
    <header class="page-heading">
      <h1>模型</h1>
      <button class="button" :disabled="loading" @click="load">
        {{ loading ? '刷新中…' : '刷新' }}
      </button>
    </header>
    <ChannelFilter v-model="system" :channels="channels" :counts="counts" />
    <div class="console-toolbar">
      <label
        >搜索模型<input v-model="search" type="search" placeholder="模型 ID、别名、备注" /></label
      ><label class="check-field"
        ><input
          type="checkbox"
          :checked="merge === '1'"
          @change="merge = ($event.target as HTMLInputElement).checked ? '1' : ''"
        />合并同名模型</label
      >
    </div>
    <component
      v-for="tool in tools"
      :key="tool.system"
      :is="tool.component"
      :system="tool.system"
      :item="editing?.system === tool.system ? editing : null"
      @close="editing = null"
      @saved="load"
    /><PartialErrors :errors="errors" @retry="load" />
    <div v-if="error" class="error-banner" role="alert">
      {{ error }}<button @click="load">重试</button>
    </div>
    <p v-if="loading" class="loading-state">正在加载模型…</p>
    <div v-if="rows.length" class="table-scroll">
      <table class="console-table">
        <thead>
          <tr>
            <th>模型 ID</th>
            <th>渠道</th>
            <th>状态</th>
            <th>模型信息</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in rows" :key="row.id">
            <td>
              <code>{{ row.model }}</code>
              <CopyButton :value="row.model" :label="`复制模型 ${row.model}`" />
            </td>
            <td>
              <SystemBadge v-for="item in row.entries" :key="item.id" :system="item.system" />
            </td>
            <td>
              <div v-for="item in row.entries" :key="item.id">
                <small v-if="row.entries.length > 1" class="cell-secondary"
                  >{{ channelLabel(item.system) }} · </small
                ><button
                  v-if="
                    typeof item.enabled === 'boolean' &&
                    channels.find((c) => c.system === item.system)?.capabilities.models.toggle
                  "
                  role="switch"
                  :aria-checked="item.enabled"
                  class="text-link"
                  :aria-label="`${item.enabled ? '停用' : '启用'} ${row.model} ${channelLabel(item.system)}`"
                  @click="
                    act(item, {
                      id: 'toggle',
                      label: item.enabled ? '停用' : '启用',
                      danger: !!item.enabled,
                    })
                  "
                >
                  {{ item.enabled ? '已启用' : '已停用' }}</button
                ><span v-else>{{ item.enabled === false ? '已停用' : '可用' }}</span>
              </div>
            </td>
            <td>
              <div v-for="item in row.entries" :key="item.id">
                <SystemBadge v-if="row.entries.length > 1" :system="item.system" /><DescriptorList
                  :items="item.display"
                />
              </div>
            </td>
            <td>
              <div v-for="item in row.entries" :key="item.id" class="row-actions">
                <small
                  v-if="
                    row.entries.length > 1 && (item.actions || []).some((a) => a.id !== 'toggle')
                  "
                  class="cell-secondary"
                  >{{ channelLabel(item.system) }}</small
                ><button
                  v-for="action in (item.actions || []).filter((a) => a.id !== 'toggle')"
                  :key="action.id"
                  class="text-link"
                  :aria-label="`${action.label} ${item.model} ${channelLabel(item.system)}`"
                  @click="act(item, action)"
                >
                  {{ action.label }}
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <div v-else-if="!loading" class="empty-state">
      <p>当前筛选下没有模型</p>
      <button class="button" @click="load">刷新模型</button>
    </div>
    <ConfirmAction v-if="confirmation" v-bind="confirmation" @close="confirmation = null" />
  </section>
</template>

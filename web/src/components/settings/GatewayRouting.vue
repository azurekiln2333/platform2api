<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { consoleApi } from '../../api.ts'
import { channels, channelLabel, errorText, useUnsavedChanges } from '../../console.ts'
import { notify } from '../../panel.ts'
import type { Routing } from '../../console-types.ts'
import SystemBadge from '../SystemBadge.vue'
import ConfirmAction from '../ConfirmAction.vue'
const draft = ref<Routing>({ order: [], enabled: {}, failover: false }),
  baseline = ref(''),
  loading = ref(false),
  saving = ref(false),
  error = ref(''),
  confirming = ref(false)
const dirty = computed(() => !!baseline.value && JSON.stringify(draft.value) !== baseline.value)
useUnsavedChanges(dirty)
const order = computed(() => [
  ...draft.value.order.filter((id) => channels.value.some((c) => c.system === id)),
  ...channels.value.map((c) => c.system).filter((id) => !draft.value.order.includes(id)),
])
async function load() {
  loading.value = true
  try {
    draft.value = await consoleApi.routing()
    baseline.value = JSON.stringify(draft.value)
    error.value = ''
  } catch (e) {
    error.value = errorText(e)
  } finally {
    loading.value = false
  }
}
function move(id: string, offset: number) {
  const next = [...order.value],
    index = next.indexOf(id)
  if (index + offset < 0 || index + offset >= next.length) return
  ;[next[index], next[index + offset]] = [next[index + offset], next[index]]
  draft.value.order = next
}
const turnedOff = computed(() => {
  const before = baseline.value ? (JSON.parse(baseline.value) as Routing) : null
  return order.value.filter(
    (id) => before?.enabled[id] !== false && draft.value.enabled[id] === false,
  )
})
async function save() {
  saving.value = true
  error.value = ''
  try {
    const next = { ...draft.value, order: order.value }
    await consoleApi.saveRouting(next)
    draft.value = next
    baseline.value = JSON.stringify(next)
    notify('统一入口路由已保存')
  } catch (e) {
    error.value = errorText(e)
    throw e
  } finally {
    saving.value = false
  }
}
async function submit() {
  if (turnedOff.value.length) {
    confirming.value = true
    return
  }
  try {
    await save()
  } catch {
    /* retain form */
  }
}
onMounted(() => void load())
</script>
<template>
  <section class="console-panel">
    <div class="row-between">
      <h3>统一入口路由</h3>
      <button class="text-link" :disabled="dirty || loading || saving" @click="load">
        重新加载
      </button>
    </div>
    <p class="cell-secondary">同名模型在多个渠道都有时，按此顺序选择。</p>
    <p v-if="loading">正在加载路由…</p>
    <form v-if="baseline" @submit.prevent="submit">
      <ol class="routing-list">
        <li v-for="(id, index) in order" :key="id">
          <SystemBadge :system="id" /><label class="check-field"
            ><input
              type="checkbox"
              :checked="draft.enabled[id] !== false"
              :disabled="saving"
              @change="draft.enabled[id] = ($event.target as HTMLInputElement).checked"
            />参与统一入口</label
          ><button
            type="button"
            class="button"
            :aria-label="`上移 ${channelLabel(id)}`"
            :disabled="!index || saving"
            @click="move(id, -1)"
          >
            上移</button
          ><button
            type="button"
            class="button"
            :aria-label="`下移 ${channelLabel(id)}`"
            :disabled="index === order.length - 1 || saving"
            @click="move(id, 1)"
          >
            下移
          </button>
        </li>
      </ol>
      <label class="check-field"
        ><input
          v-model="draft.failover"
          type="checkbox"
          :disabled="saving"
        />失败时自动切换到下一个渠道</label
      ><button type="submit" class="button primary" :disabled="!dirty || saving">
        {{ saving ? '保存中…' : '保存路由' }}
      </button>
    </form>
    <p v-if="error" class="form-error" role="alert">
      {{ error }} <button v-if="!baseline" class="text-link" @click="load">重试</button>
    </p>
    <ConfirmAction
      v-if="confirming"
      :title="`停用统一入口渠道「${turnedOff.map(channelLabel).join('、')}」`"
      verb="停用并保存"
      :action="save"
      @close="confirming = false"
    />
  </section>
</template>

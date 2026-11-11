<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { api } from '../../api.ts'
import { errorText, useUnsavedChanges } from '../../console.ts'
import { notify } from '../../panel.ts'
import { redact } from '../../redact.ts'
import CopyButton from '../../components/CopyButton.vue'
import RelativeTime from '../../components/RelativeTime.vue'
const props = defineProps<{ system: string; embed: string }>()
const rules = ref(''),
  headers = ref(''),
  baseline = ref(''),
  revealed = ref(false),
  busy = ref(false),
  error = ref(''),
  relay = ref<{
    servers?: {
      id: string
      name: string
      origin: string
      status?: string
      pending?: number
      failed?: number
      lastSuccessAt?: string
    }[]
  } | null>(null)
const dirty = computed(() => rules.value !== baseline.value || !!headers.value)
useUnsavedChanges(dirty)
const request = <T,>(path: string, method = 'GET', body?: unknown) =>
  api<T>(`/p/${props.system}${path}`, method, body)
async function load() {
  busy.value = true
  error.value = ''
  try {
    if (props.embed.includes('relay')) relay.value = await request('/api/registration-relay')
    else if (props.embed.includes('overrides')) {
      const data = await request<{ settings?: { requestOverrides?: unknown } }>('/api/settings')
      rules.value = JSON.stringify(
        redact(data.settings?.requestOverrides ?? { operations: [] }),
        null,
        2,
      )
      baseline.value = rules.value
    }
  } catch (e) {
    error.value = errorText(e)
  } finally {
    busy.value = false
  }
}
async function save() {
  busy.value = true
  error.value = ''
  try {
    const values: Record<string, unknown> = {}
    if (props.embed.includes('overrides')) values.requestOverrides = JSON.parse(rules.value)
    else if (headers.value) values.upstreamHeaders = JSON.parse(headers.value)
    await request('/api/settings', 'PATCH', values)
    baseline.value = rules.value
    headers.value = ''
    notify('高级设置已保存')
  } catch (e) {
    error.value = errorText(e)
  } finally {
    busy.value = false
  }
}
async function sync() {
  busy.value = true
  try {
    relay.value = await request('/api/registration-relay/sync', 'POST', {})
    notify('注册中继已同步')
  } catch (e) {
    error.value = errorText(e)
  } finally {
    busy.value = false
  }
}
onMounted(() => void load())
</script>
<template>
  <section class="console-panel">
    <h3>
      {{
        embed.includes('relay') ? '注册中继' : embed.includes('headers') ? '上游请求头' : '请求改写'
      }}
    </h3>
    <p v-if="error" class="form-error" role="alert">
      {{ error }} <button class="text-link" @click="load">重试</button>
    </p>
    <template v-if="embed.includes('relay')"
      ><button class="button" :disabled="busy" @click="sync">
        {{ busy ? '同步中…' : '立即同步' }}
      </button>
      <div v-if="relay?.servers?.length" class="table-scroll">
        <table class="console-table">
          <thead>
            <tr>
              <th>名称</th>
              <th>地址</th>
              <th>状态</th>
              <th>待处理</th>
              <th>失败</th>
              <th>最近成功</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="server in relay.servers" :key="server.id">
              <td>{{ server.name }}</td>
              <td>{{ server.origin }} <CopyButton :value="server.origin" /></td>
              <td>{{ server.status || '—' }}</td>
              <td>{{ server.pending || 0 }}</td>
              <td>{{ server.failed || 0 }}</td>
              <td><RelativeTime :value="server.lastSuccessAt" /></td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else class="empty-state">暂无中继运行记录</p></template
    >
    <form v-else @submit.prevent="save">
      <label v-if="embed.includes('overrides')" class="form-field"
        >请求改写规则（JSON）<textarea
          v-model="rules"
          rows="8"
          :disabled="busy"
          spellcheck="false"
        /></label
      ><label v-else class="form-field"
        >替换上游请求头（JSON）<span class="secret-input"
          ><input
            v-model="headers"
            :type="revealed ? 'text' : 'password'"
            :disabled="busy"
            autocomplete="new-password"
            placeholder="已保存，留空则不修改"
          /><button class="text-link" type="button" @click="revealed = !revealed">
            {{ revealed ? '隐藏' : '显示' }}
          </button></span
        ></label
      ><button type="submit" class="button primary" :disabled="busy || !dirty">
        {{ busy ? '保存中…' : '保存' }}
      </button>
    </form>
  </section>
</template>

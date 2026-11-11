<script setup lang="ts">
import { computed, onMounted, onBeforeUnmount, ref } from 'vue'
import { consoleApi } from '../api.ts'
import {
  channels,
  unifiedUrl,
  queryValue,
  channelLabel,
  channelOnline,
  errorText,
  useUnsavedChanges,
  formatNumber,
} from '../console.ts'
import { notify } from '../panel.ts'
import type { KeyItem, AggregateError, Field } from '../console-types.ts'
import ChannelFilter from '../components/ChannelFilter.vue'
import SystemBadge from '../components/SystemBadge.vue'
import PartialErrors from '../components/PartialErrors.vue'
import RelativeTime from '../components/RelativeTime.vue'
import CopyButton from '../components/CopyButton.vue'
import ModalShell from '../components/ModalShell.vue'
import SchemaFields from '../components/SchemaFields.vue'
import ConfirmAction from '../components/ConfirmAction.vue'
import { keyFormLimits, keyLimitPayload, keyListItem } from '../components/keys/form.ts'
const items = ref<KeyItem[]>([]),
  errors = ref<AggregateError[]>([]),
  failure = ref(''),
  loading = ref(false)
const system = queryValue('system'),
  via = queryValue('via')
const visible = computed(() =>
  items.value
    .filter(
      (item) =>
        (!via.value || item.via === via.value) &&
        (!system.value || item.channels === '*' || item.channels?.includes(system.value)),
    )
    .sort((a, b) => Number(b.builtin) - Number(a.builtin)),
)
const addressItems = computed(() =>
  items.value.filter((item) => !via.value || item.via === via.value),
)
const counts = computed(() =>
  Object.fromEntries(
    channels.value.map((c) => [
      c.system,
      addressItems.value.filter(
        (item) => item.channels === '*' || item.channels?.includes(c.system),
      ).length,
    ]),
  ),
)
const noUnified = computed(
  () =>
    !items.value.some(
      (item) =>
        item.via === 'unified' &&
        item.enabled &&
        (!item.limits?.expiresAt || Date.parse(item.limits.expiresAt) > Date.now()),
    ),
)
let live = true,
  generation = 0
async function load() {
  const request = ++generation
  loading.value = true
  try {
    const response = await consoleApi.keys()
    if (live && request === generation) {
      items.value = (response.items || []).map(keyListItem)
      errors.value = response.errors || []
      failure.value = ''
    }
  } catch (e) {
    if (live && request === generation) failure.value = errorText(e)
  } finally {
    if (live && request === generation) loading.value = false
  }
}
const dialog = ref(false),
  editing = ref<KeyItem | null>(null),
  busy = ref(false),
  formError = ref(''),
  secret = ref(''),
  secretVisible = ref(false),
  resultAddress = ref('')
const target = ref<'unified' | 'direct'>('unified'),
  scope = ref<'all' | 'selected'>('all'),
  chosen = ref<string[]>([]),
  direct = ref(''),
  name = ref(''),
  enabled = ref(true),
  limits = ref<Record<string, unknown>>({})
const baseline = ref('')
const snapshot = () =>
  JSON.stringify({
    target: target.value,
    scope: scope.value,
    chosen: chosen.value,
    direct: direct.value,
    name: name.value,
    enabled: enabled.value,
    limits: limits.value,
  })
const dirty = computed(
  () => dialog.value && (busy.value || !!secret.value || snapshot() !== baseline.value),
)
useUnsavedChanges(dirty)
const unifiedFields: Field[] = [
  { key: 'models', label: '模型白名单', type: 'list', help: '每行一个模型 ID，留空表示不限' },
  { key: 'expiresAt', label: '到期时间', type: 'datetime' },
  { key: 'quotaRequests', label: '请求额度', type: 'number', min: 0, help: '留空或 0 表示不限' },
  { key: 'quotaTokens', label: 'Token 额度', type: 'number', min: 0, help: '留空或 0 表示不限' },
  { key: 'ipAllow', label: 'IP 白名单', type: 'list', help: '每行一个地址或 CIDR' },
]
const fields = computed(() =>
  (target.value === 'unified'
    ? unifiedFields
    : channels.value.find((c) => c.system === direct.value)?.capabilities.keys.fields || []
  ).map((field) => (field.key === 'expiresAt' ? { ...field, type: 'datetime' } : field)),
)
const address = (item: KeyItem) =>
  item.via === 'unified'
    ? unifiedUrl.value
    : channels.value.find((c) => c.system === item.system)?.inferenceUrl || ''
function allowed(item: KeyItem, operation: 'update' | 'delete' | 'rotate' | 'resetUsage') {
  if (
    item.builtin &&
    (operation !== 'rotate' || !item.enabled || item.id.endsWith(':admin-external'))
  )
    return false
  return (
    item.via === 'unified' ||
    !!channels.value.find((c) => c.system === item.system)?.capabilities.keys[operation]
  )
}
function open(item: KeyItem | null = null) {
  editing.value = item
  target.value = item?.via || (via.value === 'direct' ? 'direct' : 'unified')
  scope.value = item?.channels && item.channels !== '*' ? 'selected' : 'all'
  chosen.value =
    item?.channels && item.channels !== '*'
      ? [...item.channels]
      : system.value
        ? [system.value]
        : []
  if (!item && system.value) scope.value = 'selected'
  direct.value = item?.system || system.value
  name.value = item?.name || ''
  enabled.value = item?.enabled ?? true
  limits.value = keyFormLimits(item, fields.value)
  secret.value = ''
  secretVisible.value = false
  resultAddress.value = ''
  formError.value = ''
  dialog.value = true
  baseline.value = snapshot()
}
function close() {
  if (busy.value || secret.value) return
  if (dirty.value && !window.confirm('放弃尚未保存的密钥修改？')) return
  dialog.value = false
  limits.value = {}
  name.value = ''
  editing.value = null
}
function saved() {
  secret.value = ''
  secretVisible.value = false
  resultAddress.value = ''
  dialog.value = false
  name.value = ''
  limits.value = {}
  editing.value = null
  baseline.value = ''
}
async function submit(confirmDisable = false) {
  if (busy.value) return
  formError.value = ''
  if (!name.value.trim()) {
    formError.value = '请填写名称'
    return
  }
  if (target.value === 'unified' && scope.value === 'selected' && !chosen.value.length) {
    formError.value = '请至少选择一个可用渠道'
    return
  }
  if (
    target.value === 'direct' &&
    (!direct.value ||
      (!editing.value &&
        (!channelOnline(direct.value) ||
          !channels.value.find((c) => c.system === direct.value)?.capabilities.keys.create)))
  ) {
    formError.value = '请选择支持新建密钥的渠道'
    return
  }
  if (editing.value?.enabled && !enabled.value && !confirmDisable) {
    confirmation.value = {
      title: `停用密钥「${editing.value.name}」（${editing.value.via === 'unified' ? '统一地址' : channelLabel(editing.value.system || '')}）`,
      description: '停用后，使用此密钥的调用将被拒绝。',
      verb: '停用',
      action: async () => {
        await submit(true)
        if (formError.value) throw new Error(formError.value)
      },
    }
    return
  }
  busy.value = true
  try {
    const options = keyLimitPayload(limits.value, fields.value, target.value === 'unified')
    const payload = {
      via: target.value,
      ...(target.value === 'unified'
        ? { channels: scope.value === 'all' ? '*' : chosen.value }
        : { system: direct.value }),
      name: name.value.trim(),
      enabled: enabled.value,
      ...options,
      ...(editing.value?.revision !== undefined ? { revision: editing.value.revision } : {}),
    }
    if (editing.value) {
      await consoleApi.updateKey(editing.value.id, payload)
      dialog.value = false
      notify('密钥已保存')
    } else {
      const response = await consoleApi.createKey(payload)
      if (!response.secret) throw new Error('服务未返回密钥，请刷新列表核对创建结果')
      secret.value = response.secret
      resultAddress.value = address(response.item)
      notify('密钥已创建')
    }
    baseline.value = snapshot()
    void load()
  } catch (e) {
    formError.value = errorText(e)
  } finally {
    busy.value = false
  }
}
const confirmation = ref<{
  title: string
  description: string
  verb: string
  action: () => Promise<unknown>
} | null>(null)
function operation(item: KeyItem, kind: 'delete' | 'rotate' | 'reset-usage' | 'toggle') {
  const verb =
    kind === 'delete'
      ? '删除'
      : kind === 'rotate'
        ? '轮换'
        : kind === 'reset-usage'
          ? '重置用量'
          : item.enabled
            ? '停用'
            : '启用'
  confirmation.value = {
    title: `${verb}密钥「${item.name}」（${item.via === 'unified' ? '统一地址' : channelLabel(item.system || '')}）`,
    verb,
    description:
      kind === 'rotate'
        ? '轮换后旧密钥立即失效，请更新所有调用方。'
        : kind === 'reset-usage'
          ? '将清空此密钥的用量统计。'
          : '此操作将立即生效。',
    action: async () => {
      if (kind === 'delete') await consoleApi.deleteKey(item.id, { revision: item.revision })
      else if (kind === 'toggle')
        await consoleApi.updateKey(item.id, { enabled: !item.enabled, revision: item.revision })
      else {
        const response = await consoleApi.keyAction(item.id, kind, { revision: item.revision })
        if (kind === 'rotate') {
          if (!response.secret) throw new Error('服务未返回新密钥，请核对轮换结果')
          open(item)
          secret.value = response.secret
          resultAddress.value = address(item)
        }
      }
      notify(`密钥已${verb}`)
      void load()
    },
  }
}
const example = ref<{ label: string; url: string; routes: string[] } | null>(null)
const exampleRoute = ref('')
const unifiedRoutes = computed(() => [
  ...new Set(channels.value.flatMap((channel) => channel.inference?.routes || [])),
])
const examplePaths = computed(() =>
  example.value?.routes.length ? example.value.routes : ['/v1/chat/completions'],
)
const examplePath = computed(() =>
  examplePaths.value.includes(exampleRoute.value)
    ? exampleRoute.value
    : examplePaths.value.find((path) => path.endsWith('/chat/completions')) ||
      examplePaths.value[0],
)
const exampleRoot = computed(
  () => example.value?.url.replace(/\/?v1\/?$/, '').replace(/\/$/, '') || '',
)
const exampleEndpoint = computed(() => `${exampleRoot.value}${examplePath.value}`)
const exampleBody = computed(() =>
  examplePath.value.endsWith('/responses')
    ? { model: 'MODEL_ID', input: '你好' }
    : examplePath.value.endsWith('/embeddings')
      ? { model: 'MODEL_ID', input: '你好' }
      : examplePath.value.endsWith('/messages')
        ? { model: 'MODEL_ID', max_tokens: 1024, messages: [{ role: 'user', content: '你好' }] }
        : { model: 'MODEL_ID', messages: [{ role: 'user', content: '你好' }] },
)
const shellQuote = (value: string) => "'" + value.replace(/'/g, "'\"'\"'") + "'"
const curl = computed(() =>
  [
    `curl ${shellQuote(exampleEndpoint.value)}`,
    ...(examplePath.value.endsWith('/messages')
      ? [`  -H "x-api-key: YOUR_API_KEY"`, `  -H "anthropic-version: 2023-06-01"`]
      : [`  -H "Authorization: Bearer YOUR_API_KEY"`]),
    `  -H "Content-Type: application/json"`,
    `  -d ${shellQuote(JSON.stringify(exampleBody.value))}`,
  ].join(' \\\n'),
)
const sdk = computed(
  () =>
    `from openai import OpenAI\nclient = OpenAI(base_url=${JSON.stringify(`${exampleRoot.value}/v1`)}, api_key="YOUR_API_KEY")\nresponse = client.chat.completions.create(model="MODEL_ID", messages=[{"role": "user", "content": "你好"}])`,
)
function summary(item: KeyItem) {
  return (
    Object.entries(item.limits || {})
      .filter(([, v]) => v !== null && v !== '' && (!Array.isArray(v) || v.length))
      .map(
        ([k, v]) =>
          `${({ models: '模型', quota: '额度', quotaRequests: '请求额度', quotaTokens: 'Token 额度', expiresAt: '到期', ipAllow: 'IP' } as Record<string, string>)[k] || k}：${
            Array.isArray(v)
              ? v.join('、')
              : k === 'quota' && typeof v === 'object'
                ? Object.entries(v as Record<string, unknown>)
                    .map(
                      ([unit, amount]) =>
                        `${unit === 'requests' ? '请求' : 'token'} ${formatNumber(Number(amount))}`,
                    )
                    .join(' / ')
                : typeof v === 'object'
                  ? JSON.stringify(v)
                  : v
          }`,
      )
      .join(' · ') || '不限'
  )
}
function usage(value: KeyItem['usage']) {
  return typeof value === 'number'
    ? formatNumber(value)
    : value
      ? Object.entries(value)
          .map(
            ([k, v]) =>
              `${({ requests: '请求', tokens: 'token', inputTokens: '输入 token', outputTokens: '输出 token' } as Record<string, string>)[k] || k} ${typeof v === 'number' ? formatNumber(v) : v}`,
          )
          .join(' · ')
      : '—'
}
onMounted(() => void load())
onBeforeUnmount(() => {
  live = false
  generation++
  secret.value = ''
})
</script>
<template>
  <section>
    <header class="page-heading">
      <h1>密钥</h1>
      <div class="heading-actions">
        <button class="button" :disabled="loading" @click="load">
          {{ loading ? '刷新中…' : '刷新' }}</button
        ><button class="button primary" @click="open()">新建密钥</button>
      </div>
    </header>
    <section class="console-panel access-panel">
      <h2>接入信息</h2>
      <div class="access-row">
        <strong>统一地址</strong><code>{{ unifiedUrl || '暂未提供统一地址' }}</code
        ><CopyButton v-if="unifiedUrl" :value="unifiedUrl" label="复制统一地址" /><button
          class="text-link"
          :disabled="!unifiedUrl"
          @click="example = { label: '统一地址', url: unifiedUrl, routes: unifiedRoutes }"
        >
          示例
        </button>
      </div>
      <div v-for="channel in channels" :key="channel.system" class="access-row">
        <SystemBadge :system="channel.system" /><code>{{
          channel.inferenceUrl || '暂未提供直连地址'
        }}</code
        ><CopyButton
          v-if="channel.inferenceUrl"
          :value="channel.inferenceUrl"
          :label="`复制${channel.label}直连地址`"
        /><button
          class="text-link"
          :disabled="!channel.inferenceUrl"
          @click="
            example = {
              label: `${channel.label} 直连`,
              url: channel.inferenceUrl,
              routes: channel.inference?.routes || [],
            }
          "
        >
          示例
        </button>
      </div>
    </section>
    <div v-if="!loading && !failure && noUnified" class="warning-banner">
      还没有可用的统一密钥，统一地址会拒绝所有调用。<button class="text-link" @click="open()">
        新建密钥
      </button>
    </div>
    <ChannelFilter
      v-model="system"
      :channels="channels"
      :counts="counts"
      :total="addressItems.length"
    />
    <div class="console-toolbar">
      <label
        >使用地址<select v-model="via">
          <option value="">全部地址</option>
          <option value="unified">统一地址</option>
          <option value="direct">渠道直连</option>
        </select></label
      >
    </div>
    <PartialErrors :errors="errors" @retry="load" />
    <div v-if="failure" class="error-banner" role="alert">
      {{ failure }}<button @click="load">重试</button>
    </div>
    <p v-if="loading" class="loading-state">正在加载密钥…</p>
    <div v-if="visible.length" class="table-scroll">
      <table class="console-table">
        <thead>
          <tr>
            <th>名称</th>
            <th>使用地址</th>
            <th>可用渠道</th>
            <th>密钥</th>
            <th>状态</th>
            <th>限制</th>
            <th>用量</th>
            <th>最近使用</th>
            <th>创建时间</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in visible" :key="item.id">
            <td>{{ item.name }} <small v-if="item.builtin" class="status-pill">内置</small></td>
            <td>
              {{ item.via === 'unified' ? '统一地址' : `${channelLabel(item.system || '')} 直连` }}
            </td>
            <td>
              <span v-if="item.channels === '*'">全部渠道</span
              ><template v-else
                ><SystemBadge v-for="id in item.channels" :key="id" :system="id"
              /></template>
            </td>
            <td>
              <code>{{ item.masked }}</code>
            </td>
            <td>
              <button
                v-if="allowed(item, 'update')"
                role="switch"
                :aria-checked="item.enabled"
                :aria-label="`${item.enabled ? '停用' : '启用'}密钥 ${item.name}`"
                class="text-link"
                @click="operation(item, 'toggle')"
              >
                {{ item.enabled ? '已启用' : '已停用' }}</button
              ><span v-else>{{ item.enabled ? '已启用' : '已停用' }}</span>
            </td>
            <td class="wrap-cell">{{ summary(item) }}</td>
            <td :title="usage(item.usage)">{{ usage(item.usage) }}</td>
            <td><RelativeTime :value="item.lastUsedAt" /></td>
            <td><RelativeTime :value="item.createdAt" /></td>
            <td>
              <div class="row-actions">
                <button
                  v-if="allowed(item, 'update')"
                  class="text-link"
                  :aria-label="`编辑密钥 ${item.name}`"
                  @click="open(item)"
                >
                  编辑</button
                ><button
                  v-if="allowed(item, 'rotate')"
                  class="text-link"
                  :aria-label="`轮换密钥 ${item.name}`"
                  @click="operation(item, 'rotate')"
                >
                  轮换</button
                ><button
                  v-if="allowed(item, 'resetUsage')"
                  class="text-link"
                  :aria-label="`重置用量 ${item.name}`"
                  @click="operation(item, 'reset-usage')"
                >
                  重置用量</button
                ><button
                  v-if="allowed(item, 'delete')"
                  class="text-link text-danger"
                  :aria-label="`删除密钥 ${item.name}`"
                  @click="operation(item, 'delete')"
                >
                  删除
                </button>
              </div>
            </td>
          </tr>
        </tbody>
      </table>
    </div>
    <div v-else-if="!loading" class="empty-state">
      <p>当前筛选下没有密钥</p>
      <button class="button primary" @click="open()">新建密钥</button>
    </div>
    <ModalShell
      v-if="dialog"
      :title="secret ? '保存新密钥' : editing ? `编辑密钥「${editing.name}」` : '新建密钥'"
      :busy="busy"
      :prevent-close="!!secret"
      wide
      @close="close"
      ><div v-if="secret" class="modal-body key-result">
        <p>关闭后无法再次查看</p>
        <label
          >完整密钥<span class="secret-input"
            ><input
              :type="secretVisible ? 'text' : 'password'"
              :value="secret"
              readonly
              autocomplete="off"
            /><button class="text-link" @click="secretVisible = !secretVisible">
              {{ secretVisible ? '隐藏' : '显示' }}
            </button></span
          ></label
        ><CopyButton :value="secret" label="复制完整密钥" />
        <p>调用地址</p>
        <code>{{ resultAddress }}</code
        ><CopyButton :value="resultAddress" label="复制调用地址" /><button
          class="button primary"
          @click="saved"
        >
          我已保存
        </button>
      </div>
      <form v-else @submit.prevent="submit()">
        <div class="modal-body">
          <fieldset :disabled="busy">
            <legend>用在哪里</legend>
            <div class="choice-grid">
              <label
                ><input
                  v-model="target"
                  type="radio"
                  value="unified"
                  :disabled="!!editing"
                />统一地址（推荐）<small>一把密钥调用多个渠道</small></label
              ><label
                ><input
                  v-model="target"
                  type="radio"
                  value="direct"
                  :disabled="!!editing"
                />渠道自己的地址<small>只在某个渠道的域名下使用</small></label
              >
            </div>
            <fieldset v-if="target === 'unified'">
              <legend>可用渠道</legend>
              <label class="check-field"
                ><input
                  v-model="scope"
                  type="radio"
                  value="all"
                />全部渠道（以后新增的渠道自动包含）</label
              ><label class="check-field"
                ><input v-model="scope" type="radio" value="selected" />指定渠道</label
              >
              <div v-if="scope === 'selected'" class="choice-grid">
                <label v-for="channel in channels" :key="channel.system"
                  ><input v-model="chosen" type="checkbox" :value="channel.system" /><SystemBadge
                    :system="channel.system"
                /></label>
              </div>
            </fieldset>
            <fieldset v-else>
              <legend>选择渠道</legend>
              <div class="choice-grid">
                <label v-for="channel in channels" :key="channel.system"
                  ><input
                    v-model="direct"
                    type="radio"
                    :value="channel.system"
                    :disabled="
                      !!editing ||
                      !channelOnline(channel.system) ||
                      !channel.capabilities.keys.create
                    "
                  /><SystemBadge :system="channel.system" /><small
                    v-if="!channelOnline(channel.system)"
                    >{{ channel.detail || '暂不可达' }}</small
                  ><small v-else-if="!channel.capabilities.keys.create"
                    >暂不支持新建密钥</small
                  ></label
                >
              </div>
            </fieldset>
            <label class="form-field">名称<input v-model="name" required maxlength="200" /></label
            ><label v-if="editing" class="check-field"
              ><input v-model="enabled" type="checkbox" />启用密钥</label
            >
            <details :open="!!editing">
              <summary>限制（可选）</summary>
              <SchemaFields v-model="limits" :fields="fields" :disabled="busy" :error="formError" />
            </details>
            <p v-if="formError" class="form-error" role="alert">{{ formError }}</p>
          </fieldset>
        </div>
        <footer class="modal-footer">
          <button type="button" class="button" :disabled="busy" @click="close">取消</button
          ><button
            type="submit"
            class="button primary"
            :disabled="busy || !name.trim() || (!!editing && !dirty)"
          >
            {{ busy ? '保存中…' : editing ? '保存' : '创建密钥' }}
          </button>
        </footer>
      </form></ModalShell
    >
    <ConfirmAction v-if="confirmation" v-bind="confirmation" @close="confirmation = null" />
    <ModalShell v-if="example" :title="`${example.label} 接入示例`" drawer @close="example = null"
      ><div class="modal-body">
        <label v-if="examplePaths.length > 1" class="form-field"
          >请求协议<select
            :value="examplePath"
            @change="exampleRoute = ($event.target as HTMLSelectElement).value"
          >
            <option v-for="path in examplePaths" :key="path" :value="path">
              {{
                path.endsWith('/messages')
                  ? 'Anthropic Messages'
                  : path.endsWith('/responses')
                    ? 'OpenAI Responses'
                    : path.endsWith('/embeddings')
                      ? '向量嵌入'
                      : '聊天补全'
              }}
            </option>
          </select></label
        >
        <h3>curl</h3>
        <CopyButton :value="curl" label="复制 curl 示例" />
        <pre class="console-json">{{ curl }}</pre>
        <template v-if="examplePath.endsWith('/chat/completions')"
          ><h3>Python SDK</h3>
          <CopyButton :value="sdk" label="复制 SDK 示例" />
          <pre class="console-json">{{ sdk }}</pre>
        </template>
      </div></ModalShell
    >
  </section>
</template>

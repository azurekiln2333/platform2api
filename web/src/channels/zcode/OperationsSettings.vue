<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { api } from '../../api.ts'
import { errorText, useUnsavedChanges, channelLabel } from '../../console.ts'
import { notify } from '../../panel.ts'
import RelativeTime from '../../components/RelativeTime.vue'
import ConfirmAction from '../../components/ConfirmAction.vue'
const props = defineProps<{ system: string; embed: string }>()
type Automation = {
  settings?: { enabled?: boolean; time?: string; timezone?: string }
  running?: boolean
  nextRunAt?: string
  lastRun?: { at?: string; ok?: boolean; error?: string }
  error?: string
}
type Rule = { cidr: string; type: string; note?: string }
const data = ref<Automation>({}),
  rules = ref<Rule[]>([]),
  blocked = ref(0),
  schedule = ref({ enabled: false, time: '09:00', timezone: 'Asia/Shanghai' }),
  baseline = ref(''),
  rule = ref({ cidr: '', type: 'deny', note: '' }),
  busy = ref(false),
  error = ref('')
const dirty = computed(
  () =>
    !!rule.value.cidr || (!!baseline.value && JSON.stringify(schedule.value) !== baseline.value),
)
useUnsavedChanges(dirty)
const request = <T,>(path: string, method = 'GET', body?: unknown) =>
  api<T>(`/p/${props.system}${path}`, method, body)
async function load() {
  busy.value = true
  error.value = ''
  try {
    if (props.embed === 'claim-automation') {
      data.value = await request('/api/claim-automation')
      schedule.value = {
        enabled: data.value.settings?.enabled === true,
        time: data.value.settings?.time || '09:00',
        timezone: data.value.settings?.timezone || 'Asia/Shanghai',
      }
      baseline.value = JSON.stringify(schedule.value)
    } else {
      const next = await request<{
        rules?: Rule[]
        blockedTotal?: number
        security?: { rules?: Rule[]; blockedTotal?: number }
      }>('/security')
      const section = next.security || next
      rules.value = section.rules || []
      blocked.value = section.blockedTotal || 0
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
    await request('/api/claim-automation', 'PATCH', schedule.value)
    baseline.value = JSON.stringify(schedule.value)
    notify('定时领取已保存')
  } catch (e) {
    error.value = errorText(e)
  } finally {
    busy.value = false
  }
}
async function add() {
  busy.value = true
  error.value = ''
  try {
    await request('/security', 'POST', { action: 'add', ...rule.value })
    rule.value = { cidr: '', type: 'deny', note: '' }
    notify('IP 规则已添加')
    await load()
  } catch (e) {
    error.value = errorText(e)
  } finally {
    busy.value = false
  }
}
const confirm = ref<{ title: string; verb: string; action: () => Promise<unknown> } | null>(null)
function action(path: string, label: string, body: unknown = {}) {
  confirm.value = {
    title: `${label}（${channelLabel(props.system)}）`,
    verb: label,
    action: async () => {
      await request(path, 'POST', body)
      notify(`${label}已执行`)
      await load()
    },
  }
}
onMounted(() => void load())
</script>
<template>
  <section class="console-panel">
    <div class="row-between">
      <h3>{{ embed === 'claim-automation' ? '定时领取' : 'IP 规则' }}</h3>
      <button class="text-link" :disabled="busy || dirty" @click="load">刷新</button>
    </div>
    <p v-if="error" class="form-error" role="alert">{{ error }}</p>
    <template v-if="embed === 'claim-automation'"
      ><form @submit.prevent="save">
        <div class="schema-fields">
          <label class="check-field"
            ><input
              v-model="schedule.enabled"
              type="checkbox"
              :disabled="busy"
            />启用每天定时领取</label
          ><label
            >执行时间<input v-model="schedule.time" type="time" required :disabled="busy" /></label
          ><label>时区<input v-model="schedule.timezone" required :disabled="busy" /></label>
        </div>
        <button type="submit" class="button primary" :disabled="busy || !dirty">
          {{ busy ? '保存中…' : '保存' }}
        </button>
      </form>
      <p>下次执行：<RelativeTime :value="data.nextRunAt" /></p>
      <p v-if="data.lastRun">
        上次执行：<RelativeTime :value="data.lastRun.at" />
        {{ data.lastRun.ok === false ? '失败' : '完成' }} {{ data.lastRun.error }}
      </p>
      <p v-if="data.error" class="form-error">{{ data.error }}</p>
      <div class="row-actions">
        <button
          class="button"
          :disabled="busy || data.running"
          @click="action('/api/claim-automation/run', '立即领取一次')"
        >
          立即领取一次</button
        ><button
          class="button"
          :disabled="busy || !data.running"
          @click="action('/api/claim-automation/cancel', '取消当前领取')"
        >
          取消当前领取
        </button>
      </div></template
    ><template v-else
      ><form @submit.prevent="add">
        <div class="schema-fields">
          <label
            >IP / CIDR<input
              v-model="rule.cidr"
              required
              placeholder="例如 10.0.0.0/8"
              :disabled="busy" /></label
          ><label
            >类型<select v-model="rule.type" :disabled="busy">
              <option value="deny">拒绝</option>
              <option value="allow">允许</option>
            </select></label
          ><label>备注<input v-model="rule.note" :disabled="busy" /></label>
        </div>
        <button type="submit" class="button primary" :disabled="busy || !rule.cidr.trim()">
          添加规则
        </button>
      </form>
      <div class="table-scroll">
        <table class="console-table">
          <thead>
            <tr>
              <th>规则</th>
              <th>类型</th>
              <th>备注</th>
              <th>操作</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(item, index) in rules" :key="index">
              <td>{{ item.cidr }}</td>
              <td>{{ item.type === 'allow' ? '允许' : '拒绝' }}</td>
              <td>{{ item.note || '—' }}</td>
              <td>
                <button
                  class="text-link text-danger"
                  :aria-label="`删除 IP 规则 ${item.cidr}`"
                  @click="
                    action('/security', `删除规则「${item.cidr}」`, { action: 'remove', index })
                  "
                >
                  删除
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-if="!rules.length" class="empty-state">还没有 IP 规则</p>
      <p>
        已拦截 {{ blocked.toLocaleString() }} 次
        <button
          class="text-link text-danger"
          @click="action('/security/clear-blocked', '清空拦截记录')"
        >
          清空拦截记录
        </button>
      </p></template
    ><ConfirmAction v-if="confirm" v-bind="confirm" @close="confirm = null" />
  </section>
</template>

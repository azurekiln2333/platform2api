<script setup lang="ts">
import { computed, ref } from 'vue'
import ModalShell from '../../components/ModalShell.vue'
import { notify, reportError } from '../../panel.ts'
import { cnb, modelsOf } from './service.ts'
import type { CnbAccount, CnbModelEntry } from './types.ts'

const props = defineProps<{ account: CnbAccount | null; defaultModels?: string[] }>()
const emit = defineEmits<{ close: []; saved: [] }>()

const draft = ref({
  name: props.account?.name ?? '',
  repo: props.account?.repo ?? '',
  group: props.account?.group ?? '默认分组',
  endpoint: props.account?.endpoint ?? '',
  branch: props.account?.branch ?? 'main',
  weight: props.account?.weight ?? 1,
  priority: props.account?.priority ?? 0,
  upstreamMode: props.account?.upstreamMode ?? 'inherit',
  autoWake: props.account?.autoWake ?? false,
  enabled: props.account?.enabled ?? true,
  proxyKey: '',
  pat: '',
  models: (props.account ? modelsOf(props.account) : (props.defaultModels ?? [])).join(', '),
})
const saving = ref(false)
const error = ref('')
const knownModels = ref<CnbModelEntry[]>([])

void cnb<{ models: CnbModelEntry[] }>('/api/models')
  .then((result) => {
    knownModels.value = Array.isArray(result.models) ? result.models : []
  })
  .catch(() => {
    knownModels.value = []
  })

const title = computed(() => (props.account ? `编辑「${props.account.name}」` : '新建 CNB 账号'))

async function save() {
  if (saving.value) return
  saving.value = true
  error.value = ''
  const payload: Record<string, unknown> = {
    name: draft.value.name.trim(),
    repo: draft.value.repo.trim(),
    group: draft.value.group.trim() || '默认分组',
    endpoint: draft.value.endpoint.trim(),
    branch: draft.value.branch.trim() || 'main',
    weight: Number(draft.value.weight),
    priority: Number(draft.value.priority),
    upstreamMode: draft.value.upstreamMode,
    autoWake: draft.value.autoWake,
    enabled: draft.value.enabled,
    models: draft.value.models
      .split(',')
      .map((model) => model.trim())
      .filter(Boolean),
  }
  if (draft.value.proxyKey.trim()) payload.proxyKey = draft.value.proxyKey.trim()
  if (draft.value.pat.trim()) payload.pat = draft.value.pat.trim()
  try {
    if (props.account)
      await cnb(`/api/accounts/${encodeURIComponent(props.account.id)}`, 'PATCH', payload)
    else await cnb('/api/accounts', 'POST', payload)
    notify(props.account ? '账号已更新' : '账号已创建，请把注册密钥写入工作区')
    emit('saved')
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '保存失败'
    reportError(cause, '保存 CNB 账号失败')
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <ModalShell
    :title="title"
    subtitle="字段与 cnb2api 服务一致；空白的密钥字段不会覆盖已保存的值。"
    wide
    @close="emit('close')"
  >
    <div class="modal-body">
      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
      <form class="account-form" @submit.prevent="save">
        <div class="form-grid">
          <label>账号名称<input v-model="draft.name" required maxlength="60" /></label>
          <label>仓库路径<input v-model="draft.repo" placeholder="组织/仓库" maxlength="200" /></label>
          <label>分组<input v-model="draft.group" maxlength="40" /></label>
          <label>工作区分支<input v-model="draft.branch" maxlength="120" /></label>
          <label
            >工作区地址<input v-model="draft.endpoint" placeholder="https://…（注册后自动填写）"
          /></label>
          <label
            >上游模式
            <select v-model="draft.upstreamMode">
              <option value="inherit">继承全局</option>
              <option value="auto">自动</option>
              <option value="ide">IDE</option>
              <option value="classic">Classic</option>
            </select>
          </label>
          <label
            >权重（1-100）<input v-model.number="draft.weight" type="number" min="1" max="100"
          /></label>
          <label
            >优先级（0-100）<input v-model.number="draft.priority" type="number" min="0" max="100"
          /></label>
          <label
            >工作区 PROXY_KEY
            <input
              v-model="draft.proxyKey"
              type="password"
              autocomplete="new-password"
              :placeholder="account ? '留空则不修改' : '必填'"
            />
          </label>
          <label
            >CNB 个人令牌
            <input
              v-model="draft.pat"
              type="password"
              autocomplete="new-password"
              :placeholder="account ? '留空则不修改' : '可选'"
            />
          </label>
        </div>
        <label
          >模型白名单（逗号分隔）
          <input
            v-model="draft.models"
            :placeholder="
              knownModels.length
                ? knownModels
                    .slice(0, 3)
                    .map((model) => model.id)
                    .join(', ')
                : '留空表示使用上游发现的模型'
            "
          />
        </label>
        <div class="compact-grid">
          <label class="check-label"><input v-model="draft.enabled" type="checkbox" />启用账号</label>
          <label class="check-label"
            ><input v-model="draft.autoWake" type="checkbox" />闲置自动唤醒（需要仓库与个人令牌）</label
          >
        </div>
        <div class="button-group">
          <button type="submit" class="button primary" :disabled="saving">
            {{ saving ? '保存中…' : account ? '保存修改' : '创建账号' }}
          </button>
        </div>
      </form>
    </div>
    <footer class="modal-footer">
      <span class="subtle">注册密钥由服务生成，创建后在「凭据」中查看。</span>
      <button class="button" @click="emit('close')">关闭</button>
    </footer>
  </ModalShell>
</template>

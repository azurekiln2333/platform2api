<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { CircleAlert, RefreshCw, Save, SlidersHorizontal } from '@lucide/vue'
import { notify, reportError } from '../../panel.ts'
import { SETTINGS_FIELDS, zcode } from './service.ts'
import type { ZcodeOverview, ZcodeSettings } from './types.ts'

const settings = ref<ZcodeSettings>({})
const limits = ref<Record<string, unknown>>({})
const fromFile = ref(false)
const loading = ref(false)
const saving = ref('')
const error = ref('')

const applied = computed(() => settings.value)

async function load() {
  loading.value = true
  try {
    const [overview, pool] = await Promise.all([
      zcode<ZcodeOverview>('/api/overview'),
      zcode<{ settings?: ZcodeSettings; limits?: Record<string, unknown>; fromFile?: boolean }>('/pool/settings').catch(
        () => ({}) as { settings?: ZcodeSettings; limits?: Record<string, unknown>; fromFile?: boolean },
      ),
    ])
    settings.value = { ...(pool.settings ?? {}), ...(overview.settings ?? {}) }
    limits.value = pool.limits ?? overview.settings?.limits ?? {}
    fromFile.value = pool.fromFile === true
    error.value = ''
  } catch (cause) {
    error.value = cause instanceof Error ? cause.message : '读取 ZCode 调度设置失败'
  } finally {
    loading.value = false
  }
}

async function save(payload: Record<string, unknown>, label: string) {
  saving.value = label
  try {
    const result = await zcode<{ ok?: boolean; applied?: Record<string, unknown>; settings?: ZcodeSettings }>(
      '/api/settings',
      'PATCH',
      payload,
    )
    if (result.settings) settings.value = { ...settings.value, ...result.settings }
    notify('调度设置已保存')
  } catch (cause) {
    reportError(cause, '保存 ZCode 调度设置失败')
  } finally {
    saving.value = ''
  }
}

async function saveNumbers(event: Event) {
  const form = event.target as HTMLFormElement
  const payload: Record<string, number> = {}
  for (const field of SETTINGS_FIELDS) {
    const input = form.elements.namedItem(field.key)
    if (input instanceof HTMLInputElement) payload[field.key] = Number(input.value)
  }
  await save(payload, 'numbers')
}

async function saveLegacySettings(event: Event) {
  const form = event.target as HTMLFormElement
  const payload: Record<string, number> = {}
  for (const field of SETTINGS_FIELDS) {
    const input = form.elements.namedItem(`legacy-${field.key}`)
    if (input instanceof HTMLInputElement) payload[field.key] = Number(input.value)
  }
  saving.value = 'legacy'
  try {
    await zcode('/pool/settings', 'POST', payload)
    notify('旧版 /pool/settings 已保存')
    await load()
  } catch (cause) {
    reportError(cause, '保存 /pool/settings 失败')
  } finally {
    saving.value = ''
  }
}
</script>

<template>
  <section>
    <header class="page-heading">
      <div>
        <span class="eyebrow"><i class="blue-line" /> ZCODE SETTINGS</span>
        <h1>ZCode 调度设置</h1>
        <p>控制台 PATCH /api/settings 与旧版 /pool/settings 都会写入服务自身。</p>
      </div>
      <div class="heading-actions">
        <button class="button" :disabled="loading" @click="load">
          <RefreshCw :size="15" :class="{ spin: loading }" /><span>重新读取</span>
        </button>
      </div>
    </header>

    <div v-if="error" class="error-banner" role="alert">
      <CircleAlert :size="16" /><span>{{ error }}</span><button @click="load">重试</button>
    </div>

    <section class="section-panel">
      <div class="section-heading">
        <SlidersHorizontal :size="20" />
        <div><h2>调度参数</h2><p>保存后立即生效，返回已应用的字段与最新设置。</p></div>
        <span class="subtle">{{ fromFile ? '来自配置文件' : '来自运行时默认值' }}</span>
      </div>
      <form class="settings-fields" @submit.prevent="saveNumbers">
        <label v-for="field in SETTINGS_FIELDS" :key="field.key">
          {{ field.label }}
          <input
            :name="field.key"
            type="number"
            :min="field.min"
            :max="field.max"
            :value="applied[field.key] ?? field.min"
          />
          <small>
            {{ field.min }}–{{ field.max }}
            <template v-if="Array.isArray(limits[field.key])">
              · 服务限制 {{ (limits[field.key] as number[])[0] }}–{{ (limits[field.key] as number[])[1] }}
            </template>
          </small>
        </label>
        <label class="check-label">
          <input
            type="checkbox"
            :checked="applied.weekendGrab === true"
            @change="save({ weekendGrab: !(applied.weekendGrab === true) }, 'weekend')"
          />周末领取
        </label>
        <label class="check-label">
          <input
            type="checkbox"
            :checked="applied.sessionAffinity === true"
            @change="save({ sessionAffinity: !(applied.sessionAffinity === true) }, 'affinity')"
          />会话保持（超过 0 分钟生效）
        </label>
        <div class="button-group">
          <button class="button primary" type="submit" :disabled="saving === 'numbers'">
            <Save :size="14" /><span>保存参数</span>
          </button>
        </div>
      </form>
    </section>

    <section class="section-panel">
      <div class="section-heading">
        <RefreshCw :size="20" />
        <div><h2>旧版 /pool/settings</h2><p>保留给旧面板与脚本；与上方字段一致，写入同一个调度器。</p></div>
      </div>
      <form class="settings-fields" @submit.prevent="saveLegacySettings">
        <label v-for="field in SETTINGS_FIELDS" :key="field.key">
          {{ field.label }}
          <input
            :name="`legacy-${field.key}`"
            type="number"
            :min="field.min"
            :max="field.max"
            :value="applied[field.key] ?? field.min"
          />
        </label>
        <div class="button-group">
          <button class="button" type="submit" :disabled="saving === 'legacy'">
            <Save :size="14" /><span>写入旧版接口</span>
          </button>
        </div>
      </form>
    </section>
  </section>
</template>

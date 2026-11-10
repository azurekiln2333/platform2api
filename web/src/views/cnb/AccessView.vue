<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { ArrowRight, Braces, Check, Copy, Eye, EyeOff, LoaderCircle, Plug, ShieldCheck, Terminal } from '@lucide/vue'
import { copy, notify } from '../../panel.ts'
import { cnb } from './service.ts'
import type { CnbAccess, CnbModelEntry } from './types.ts'

const MASKED = '••••••••••••••••••••••••'

const access = ref<CnbAccess>({ publicUrl: '', maskedKey: MASKED })
const actualKey = ref('')
const reveal = ref(false)
const keyLoading = ref(false)
const protocol = ref<'openai' | 'responses' | 'anthropic' | 'newapi'>('openai')
const models = ref<string[]>([])

const baseUrl = computed(() => access.value.publicUrl || window.location.origin)
const model = computed(() => models.value[0] ?? 'your-model')

const example = computed(() => {
  const key = 'YOUR_GATEWAY_KEY'
  if (protocol.value === 'openai')
    return `curl ${baseUrl.value}/v1/chat/completions \\\n  -H "Authorization: Bearer ${key}" \\\n  -H "Content-Type: application/json" \\\n  -d '{\n    "model": "${model.value}",\n    "messages": [{"role": "user", "content": "你好"}],\n    "stream": true\n  }'`
  if (protocol.value === 'responses')
    return `curl ${baseUrl.value}/v1/responses \\\n  -H "Authorization: Bearer ${key}" \\\n  -H "Content-Type: application/json" \\\n  -d '{\n    "model": "${model.value}",\n    "input": "你好",\n    "store": false,\n    "stream": true\n  }'`
  if (protocol.value === 'anthropic')
    return `export ANTHROPIC_BASE_URL="${baseUrl.value}"\nexport ANTHROPIC_AUTH_TOKEN="${key}"\nexport ANTHROPIC_MODEL="${model.value}"\n\nclaude`
  return `渠道类型    OpenAI\n代理地址    ${baseUrl.value}\n密钥        ${key}\n模型        ${model.value}`
})

async function loadAccess() {
  try {
    access.value = await cnb<CnbAccess>('/api/access')
  } catch (cause) {
    notify(cause instanceof Error ? cause.message : '接入配置加载失败', true)
  }
}

async function showKey() {
  if (reveal.value) {
    reveal.value = false
    actualKey.value = ''
    return
  }
  keyLoading.value = true
  try {
    if (!actualKey.value) actualKey.value = (await cnb<{ key: string }>('/api/access/key', 'POST', {})).key
    reveal.value = true
  } catch (cause) {
    notify(cause instanceof Error ? cause.message : '读取网关密钥失败', true)
  } finally {
    keyLoading.value = false
  }
}

async function copyKey() {
  keyLoading.value = true
  try {
    if (!actualKey.value) actualKey.value = (await cnb<{ key: string }>('/api/access/key', 'POST', {})).key
    await copy(actualKey.value)
    if (!reveal.value) actualKey.value = ''
  } catch (cause) {
    notify(cause instanceof Error ? cause.message : '读取网关密钥失败', true)
  } finally {
    keyLoading.value = false
  }
}

onMounted(async () => {
  void loadAccess()
  try {
    const result = await cnb<{ models: CnbModelEntry[] }>('/api/models')
    models.value = (result.models ?? []).filter((entry) => entry.listed).map((entry) => entry.id)
  } catch {
    models.value = []
  }
})
</script>

<template>
  <section>
    <header class="page-heading">
      <div>
        <span class="eyebrow"><i class="blue-line" /> CNB ACCESS</span>
        <h1>CNB 接入配置</h1>
        <p>固定地址与网关 Key 由 CNB 服务下发；客户端只与本服务的地址通信。</p>
      </div>
      <span class="protocol-label"><ShieldCheck :size="15" />标准协议兼容</span>
    </header>

    <section class="access-hero">
      <div class="access-hero-icon"><Braces :size="28" /></div>
      <div>
        <span class="eyebrow">CNB ENDPOINT</span>
        <h2>一个地址，连起 CNB 号池。</h2>
        <p>兼容 OpenAI 客户端与 Claude Code，支持流式响应与工具调用。</p>
      </div>
      <div class="access-hero-tags">
        <span><Check :size="12" />OpenAI</span><span><Check :size="12" />Anthropic</span>
      </div>
    </section>

    <div class="access-grid">
      <section class="section-panel">
        <header class="section-heading">
          <Plug :size="20" />
          <div><h2>连接信息</h2><p>工作区启动后会向 CNB 服务注册地址。</p></div>
        </header>
        <div class="connection-fields">
          <label
            >OpenAI Base URL
            <div class="copy-field">
              <code>{{ baseUrl }}/v1</code>
              <button class="icon-button" aria-label="复制 OpenAI 地址" @click="copy(`${baseUrl}/v1`)">
                <Copy :size="15" />
              </button>
            </div>
          </label>
          <label
            >Anthropic Base URL
            <div class="copy-field">
              <code>{{ baseUrl }}</code>
              <button class="icon-button" aria-label="复制 Anthropic 地址" @click="copy(baseUrl)">
                <Copy :size="15" />
              </button>
            </div>
          </label>
          <label
            >统一网关 API Key
            <div class="copy-field">
              <code>{{ reveal ? actualKey : access.maskedKey || MASKED }}</code>
              <button
                class="icon-button"
                :disabled="keyLoading"
                :aria-label="reveal ? '隐藏网关密钥' : '显示网关密钥'"
                @click="showKey"
              >
                <LoaderCircle v-if="keyLoading" :size="15" class="spin" />
                <EyeOff v-else-if="reveal" :size="15" />
                <Eye v-else :size="15" />
              </button>
              <button class="icon-button" :disabled="keyLoading" aria-label="复制网关密钥" @click="copyKey">
                <Copy :size="15" />
              </button>
            </div>
            <small>由服务首次启动时生成，或由环境变量 GATEWAY_KEY 指定，默认遮蔽显示。</small>
          </label>
        </div>
        <div class="access-security">
          <ShieldCheck :size="16" /><span>客户端使用网关 Key；工作区 Key、个人令牌与注册密钥彼此独立。</span>
        </div>
      </section>

      <section class="section-panel client-guide">
        <header class="section-heading">
          <Terminal :size="20" />
          <div><h2>快速开始</h2><p>选择客户端，复制对应配置。</p></div>
        </header>
        <div class="client-tabs" role="tablist" aria-label="客户端类型">
          <button role="tab" :aria-selected="protocol === 'openai'" :class="{ active: protocol === 'openai' }" @click="protocol = 'openai'">
            OpenAI / cURL
          </button>
          <button role="tab" :aria-selected="protocol === 'responses'" :class="{ active: protocol === 'responses' }" @click="protocol = 'responses'">
            Responses
          </button>
          <button role="tab" :aria-selected="protocol === 'anthropic'" :class="{ active: protocol === 'anthropic' }" @click="protocol = 'anthropic'">
            Claude Code
          </button>
          <button role="tab" :aria-selected="protocol === 'newapi'" :class="{ active: protocol === 'newapi' }" @click="protocol = 'newapi'">
            New API
          </button>
        </div>
        <div class="code-block">
          <div class="code-header">
            <span><Terminal :size="13" />{{ protocol === 'newapi' ? '渠道配置' : 'Terminal' }}</span>
            <button class="icon-button" aria-label="复制调用示例" @click="copy(example)"><Copy :size="14" /></button>
          </div>
          <pre>{{ example }}</pre>
        </div>
        <p class="inline-hint">把 YOUR_GATEWAY_KEY 换成左侧网关 Key；模型须在 CNB 工作区中实际可用。</p>
      </section>
    </div>

    <section class="section-panel access-flow">
      <span class="eyebrow">HOW IT CONNECTS</span>
      <div>
        <span
          ><span class="flow-step">01</span><strong>客户端</strong><small>固定地址 + 网关 Key</small></span
        >
        <ArrowRight :size="20" />
        <span
          ><span class="flow-step">02</span><strong>CNB 网关</strong><small>账号选择 / 故障切换</small></span
        >
        <ArrowRight :size="20" />
        <span
          ><span class="flow-step">03</span><strong>CNB 工作区</strong><small>工作区地址 / 自动注册</small></span
        >
      </div>
    </section>
  </section>
</template>

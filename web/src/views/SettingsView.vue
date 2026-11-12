<script setup lang="ts">
import { onMounted, ref, nextTick } from 'vue'
import { consoleApi } from '../api.ts'
import { channels, query, errorText, version, channelLabel } from '../console.ts'
import type { ConsoleSettings } from '../console-types.ts'
import AuthSettingsSection from '../components/settings/AuthSettingsSection.vue'
import SettingsGroup from '../components/settings/SettingsGroup.vue'
import GatewayRouting from '../components/settings/GatewayRouting.vue'
import ServiceConnection from '../components/settings/ServiceConnection.vue'
import PartialErrors from '../components/PartialErrors.vue'
import SystemBadge from '../components/SystemBadge.vue'
import { settingsEmbeds, settingsExtras } from '../channels/registry.ts'
const data = ref<ConsoleSettings | null>(null),
  loading = ref(false),
  error = ref('')
async function load() {
  loading.value = true
  try {
    data.value = await consoleApi.settings()
    version.value = data.value.version || ''
    error.value = ''
    await nextTick()
    if (query.value.system) jump(query.value.system)
  } catch (e) {
    error.value = errorText(e)
  } finally {
    loading.value = false
  }
}
function jump(system: string) {
  document
    .getElementById(`settings-${system}`)
    ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
}
onMounted(() => void load())
</script>
<template>
  <section>
    <header class="page-heading">
      <h1>系统设置</h1>
      <button class="button" :disabled="loading" @click="load">
        {{ loading ? '刷新中…' : '刷新' }}
      </button>
    </header>
    <nav class="settings-anchors" aria-label="设置分区">
      <button class="text-link" @click="jump('common')">通用</button
      ><button
        v-for="channel in channels"
        :key="channel.system"
        class="text-link"
        @click="jump(channel.system)"
      >
        {{ channel.label }}
      </button>
    </nav>
    <div v-if="error" class="error-banner" role="alert">
      {{ error }}<button @click="load">重试</button>
    </div>
    <PartialErrors :errors="data?.errors || []" @retry="load" />
    <section id="settings-common" class="settings-section">
      <h2>通用</h2>
      <AuthSettingsSection />
      <section class="console-panel">
        <h3>服务连接</h3>
        <p v-if="loading && !data">正在读取服务连接…</p>
        <ServiceConnection
          v-for="service in data?.services || []"
          :key="service.system"
          :service="service"
        />
      </section>
      <GatewayRouting /><SettingsGroup
        v-for="group in data?.common || []"
        :key="group.id"
        :group="group"
        :save="(values) => consoleApi.saveCommon(group.id, values)"
      />
    </section>
    <section
      v-for="channel in channels"
      :id="`settings-${channel.system}`"
      :key="channel.system"
      class="settings-section"
    >
      <h2><SystemBadge :system="channel.system" /> {{ channelLabel(channel.system) }}</h2>
      <SettingsGroup
        v-for="group in data?.channels?.find((c) => c.system === channel.system)?.groups || []"
        :key="group.id"
        :group="group"
        :save="(values) => consoleApi.saveChannelSettings(channel.system, group.id, values)"
      /><template
        v-for="embed in data?.channels?.find((c) => c.system === channel.system)?.embeds || []"
        :key="embed"
        ><component
          :is="settingsEmbeds[embed]"
          v-if="settingsEmbeds[embed]"
          :system="channel.system"
          :embed="embed"
        />
        <p v-else class="cell-secondary">{{ embed }} 的编辑器暂不受当前面板支持</p></template
      ><component
        :is="settingsExtras[channel.system]"
        v-if="settingsExtras[channel.system]"
        :system="channel.system"
      />
    </section>
  </section>
</template>

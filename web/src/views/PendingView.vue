<script setup lang="ts">
import { computed } from 'vue'
import { ArrowRight, Layers, PlugZap } from '@lucide/vue'
import SystemBadge from '../components/SystemBadge.vue'
import { systemMeta } from '../systems.ts'
import type { SystemId } from '../types.ts'

const props = defineProps<{ system: SystemId; slug: string; label: string }>()
const emit = defineEmits<{ navigate: [hash: string] }>()
const meta = computed(() => systemMeta(props.system))
</script>

<template>
  <section>
    <header class="page-heading">
      <div>
        <span class="eyebrow"><i class="blue-line" /> {{ meta.label.toUpperCase() }}</span>
        <h1>{{ label }}<SystemBadge :system="system" /></h1>
        <p>{{ meta.service }} 的这个功能页还没有接入统一面板，路由位置已经预留好。</p>
      </div>
    </header>

    <div class="section-panel">
      <div class="section-heading">
        <PlugZap :size="18" />
        <div>
          <h2>该功能页尚未接入</h2>
          <p>
            统一面板已经为 {{ meta.label }} 预留了
            <code class="mono">#{{ system }}/{{ slug }}</code>
            路由。功能页接入前，请先使用统一概览与账号管理，或等待该系统页面补齐。
          </p>
        </div>
      </div>
      <div class="button-group page-pending-actions">
        <button class="button" @click="emit('navigate', '#overview')">
          <Layers :size="14" /><span>运行概览</span>
        </button>
        <button class="button" @click="emit('navigate', '#accounts')">
          <ArrowRight :size="14" /><span>账号管理</span>
        </button>
      </div>
    </div>
  </section>
</template>

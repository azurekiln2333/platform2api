<script setup lang="ts">
import type { Descriptor, Quota } from '../console-types.ts'
import { absoluteTime, relativeTime } from '../console.ts'
import CopyButton from './CopyButton.vue'
import QuotaBar from './QuotaBar.vue'
defineProps<{ items?: Descriptor[]; absolute?: boolean }>()
function text(value: unknown) {
  return value == null ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value)
}
function quota(value: unknown) {
  return typeof value === 'object' && value ? (value as Quota) : null
}
</script>
<template>
  <dl class="descriptor-list">
    <div v-for="item in items || []" :key="item.key">
      <dt>{{ item.label }}</dt>
      <dd>
        <QuotaBar v-if="item.kind === 'quota'" :quota="quota(item.value)" /><template
          v-else-if="item.kind === 'time'"
          ><time :title="absoluteTime(item.value)">{{
            absolute ? absoluteTime(item.value) : relativeTime(item.value)
          }}</time></template
        ><span v-else-if="item.kind === 'bool'">{{ item.value ? '是' : '否' }}</span
        ><span
          v-else
          :class="{ mono: item.kind === 'mono', 'status-pill': item.kind === 'badge' }"
          >{{ text(item.value) }}</span
        ><CopyButton
          v-if="item.kind === 'mono' && item.value"
          :value="text(item.value)"
          :label="`复制${item.label}`"
        />
      </dd>
    </div>
  </dl>
</template>

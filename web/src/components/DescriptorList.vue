<script setup lang="ts">
import { ArrowUpRight } from '@lucide/vue'
import type { Descriptor, Quota } from '../console-types.ts'
import { absoluteTime, relativeTime } from '../console.ts'
import CopyButton from './CopyButton.vue'
import CopyableValue from './accounts/CopyableValue.vue'
import QuotaBar from './QuotaBar.vue'

/**
 * `oneLine`: 值一律单行、超宽省略号，全文放 `title`（长 ID / 仓库名不再换行，F9）。
 * `clickCopy`: 可复制值「点击文字即复制」，不再额外渲染复制按钮（F10）。
 */
const props = withDefaults(
  defineProps<{
    items?: Descriptor[]
    absolute?: boolean
    oneLine?: boolean
    clickCopy?: boolean
  }>(),
  { items: () => [], absolute: false, oneLine: false, clickCopy: false },
)
function text(value: unknown) {
  return value == null ? '—' : typeof value === 'object' ? JSON.stringify(value) : String(value)
}
function quota(value: unknown) {
  return typeof value === 'object' && value ? (value as Quota) : null
}
/** 后端用 `kind:"link"` + `href` 给出可点击地址；没有地址时按普通文本显示。 */
function linkHref(item: Descriptor) {
  if (item.kind !== 'link') return ''
  const href = typeof item.href === 'string' ? item.href.trim() : ''
  return /^https?:\/\//i.test(href) ? href : ''
}
</script>
<template>
  <dl class="descriptor-list" :class="{ 'one-line-list': props.oneLine }">
    <div v-for="item in props.items || []" :key="item.key">
      <dt :title="item.label">{{ item.label }}</dt>
      <dd>
        <QuotaBar v-if="item.kind === 'quota'" :quota="quota(item.value)" /><template
          v-else-if="item.kind === 'time'"
          ><time :title="absoluteTime(item.value)">{{
            props.absolute ? absoluteTime(item.value) : relativeTime(item.value)
          }}</time></template
        ><span v-else-if="item.kind === 'bool'">{{ item.value ? '是' : '否' }}</span
        ><a
          v-else-if="linkHref(item)"
          class="descriptor-value descriptor-link one-line"
          :href="linkHref(item)"
          target="_blank"
          rel="noopener noreferrer"
          :title="linkHref(item)"
          @click.stop
          ><span class="descriptor-link-text">{{ text(item.value) }}</span
          ><ArrowUpRight :size="13" class="descriptor-link-icon" /></a
        ><CopyableValue
          v-else-if="item.kind === 'mono' && item.value && props.clickCopy"
          class="mono"
          :value="text(item.value)"
          :label="item.label"
          mono
        /><template v-else-if="item.kind === 'mono'"
          ><span
            class="mono descriptor-value"
            :class="{ 'one-line': props.oneLine }"
            :title="text(item.value)"
            >{{ text(item.value) }}</span
          ><CopyButton v-if="item.value" :value="text(item.value)" :label="`复制${item.label}`"
        /></template>
        <span
          v-else
          class="descriptor-value"
          :class="[{ 'status-pill': item.kind === 'badge' }, { 'one-line': props.oneLine }]"
          :title="text(item.value)"
          >{{ text(item.value) }}</span
        >
      </dd>
    </div>
  </dl>
</template>
<style scoped>
.descriptor-list dd {
  min-width: 0;
}
.descriptor-value {
  display: inline-block;
  max-width: 100%;
  min-width: 0;
  vertical-align: bottom;
}
.descriptor-value.one-line {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.descriptor-link {
  display: inline-flex;
  align-items: center;
  gap: 3px;
  max-width: 100%;
  color: var(--primary);
  text-decoration: none;
}
.descriptor-link:hover {
  text-decoration: underline;
}
.descriptor-link-text {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.descriptor-link-icon {
  flex: none;
}
</style>

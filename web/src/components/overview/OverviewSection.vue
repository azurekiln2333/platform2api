<script setup lang="ts">
/**
 * Generic renderer for one overview section. The backend declares sections
 * (`kind`), so no channel-specific template lives here (ui-fixes.md F12 §2).
 */
import { computed } from 'vue'
import { absoluteTime, channels, formatNumber, relativeTime } from '../../console.ts'
import StackedChart, { type ChartPart } from '../StackedChart.vue'
import SystemBadge from '../SystemBadge.vue'
import type { OverviewSection, SectionTone, TableColumn } from './types.ts'
import { quotaRemaining } from './types.ts'

const props = defineProps<{ section: OverviewSection }>()

const PALETTE = [
  'var(--primary)',
  'var(--violet)',
  'var(--green)',
  'var(--amber)',
  'var(--red)',
  'var(--muted)',
]

const statsItems = computed(() => (props.section.kind === 'stats' ? props.section.items : []))

function ratioOf(remaining: number | null, total: number | null) {
  if (remaining === null || total === null || total <= 0) return null
  return Math.min(100, Math.max(0, (remaining / total) * 100))
}
/** F4: the bar length is the remaining share — <20% warn, <5% (or 0) error. */
function toneOf(remaining: number | null, total: number | null): SectionTone | undefined {
  const ratio = ratioOf(remaining, total)
  if (ratio === null || remaining === null) return undefined
  if (remaining <= 0 || ratio < 5) return 'error'
  if (ratio < 20) return 'warn'
  return 'ok'
}
const quotaRows = computed(() => {
  if (props.section.kind !== 'quotaList') return []
  return props.section.items.map((item) => {
    const remaining = quotaRemaining(item)
    const total = item.total ?? null
    return {
      item,
      remaining,
      total,
      ratio: ratioOf(remaining, total),
      tone: toneOf(remaining, total),
      unit: item.unit || '',
    }
  })
})

function bucketLabel(value: string) {
  if (!value) return ''
  if (/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    const date = new Date(value)
    if (!Number.isNaN(date.getTime()))
      return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
  }
  return value
}
const seriesRows = computed(() =>
  props.section.kind === 'series'
    ? props.section.buckets.map((bucket) => ({
        label: bucketLabel(bucket.t),
        values: bucket.values,
      }))
    : [],
)
const seriesParts = computed<ChartPart[]>(() => {
  if (props.section.kind !== 'series') return []
  const keys = new Set<string>()
  for (const bucket of props.section.buckets)
    for (const key of Object.keys(bucket.values)) keys.add(key)
  return [...keys].map((key, index) => {
    const channel = channels.value.find((item) => item.system === key)
    return {
      key,
      label: channel?.label || key,
      color: channel?.color || PALETTE[index % PALETTE.length],
    }
  })
})

const tableColumns = computed<TableColumn[]>(() =>
  props.section.kind === 'table' ? props.section.columns : [],
)
const tableRows = computed(() => (props.section.kind === 'table' ? props.section.rows : []))
const isSystem = (value: unknown) =>
  typeof value === 'string' && channels.value.some((item) => item.system === value)

function valueText(value: unknown): string {
  if (value === null || value === undefined || value === '') return '—'
  if (typeof value === 'number') return formatNumber(value)
  if (typeof value === 'boolean') return value ? '是' : '否'
  if (Array.isArray(value)) return value.map((item) => valueText(item)).join('、')
  if (typeof value === 'object') {
    try {
      return JSON.stringify(value)
    } catch {
      return String(value)
    }
  }
  return String(value)
}
function cellText(row: Record<string, unknown>, column: TableColumn) {
  const value = row[column.key]
  if (column.kind === 'number' && typeof value === 'number') return formatNumber(value)
  return valueText(value)
}
function cellHref(row: Record<string, unknown>, column: TableColumn) {
  const candidate =
    row[`${column.key}Href`] ??
    row[`${column.key}_href`] ??
    (column.kind === 'link' ? row[column.key] : undefined)
  return typeof candidate === 'string' && /^(?:https?:\/\/|\/)/i.test(candidate) ? candidate : ''
}
</script>
<template>
  <section class="console-panel ov-section" :data-testid="`overview-section-${section.id}`">
    <h2 class="ov-title" :title="section.title">{{ section.title }}</h2>
    <template v-if="section.kind === 'stats'">
      <div v-if="statsItems.length" class="ov-stats">
        <article v-for="item in statsItems" :key="item.label" class="ov-stat">
          <span class="ov-stat-label" :title="item.label">{{ item.label }}</span>
          <strong
            class="ov-stat-value"
            :class="item.tone ? `tone-${item.tone}` : undefined"
            :title="valueText(item.value)"
            >{{ valueText(item.value) }}</strong
          >
          <small v-if="item.hint" class="ov-muted" :title="item.hint">{{ item.hint }}</small>
        </article>
      </div>
      <p v-else class="empty-state">暂无数据</p>
    </template>
    <template v-else-if="section.kind === 'quotaList'">
      <ul v-if="quotaRows.length" class="ov-quota-list">
        <li v-for="row in quotaRows" :key="row.item.id" class="ov-quota">
          <div class="ov-quota-head">
            <span class="ov-quota-label" :title="row.item.label">{{ row.item.label }}</span>
            <span class="ov-quota-value">
              <template v-if="row.remaining !== null"
                >剩余 {{ formatNumber(row.remaining)
                }}<template v-if="row.total !== null"> / {{ formatNumber(row.total) }}</template>
                {{ row.unit }}</template
              >
              <template v-else-if="row.total !== null"
                >总量 {{ formatNumber(row.total) }} {{ row.unit }}</template
              >
              <template v-else>—</template>
            </span>
          </div>
          <div v-if="row.ratio !== null" class="ov-quota-track" aria-hidden="true">
            <i
              :class="row.tone ? `tone-${row.tone}` : undefined"
              :style="{ width: `${row.ratio}%` }"
            />
          </div>
          <small v-if="row.item.status" class="ov-muted" :title="row.item.status">{{
            row.item.status
          }}</small>
        </li>
      </ul>
      <p v-else class="empty-state">暂无额度数据</p>
    </template>
    <template v-else-if="section.kind === 'series'">
      <StackedChart
        :rows="seriesRows"
        :parts="seriesParts"
        :unit="section.unit"
        :label="section.title"
      />
    </template>
    <template v-else-if="section.kind === 'table'">
      <div v-if="tableRows.length" class="table-scroll">
        <table class="console-table ov-table">
          <thead>
            <tr>
              <th v-for="column in tableColumns" :key="column.key" :title="column.label">
                {{ column.label }}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="(row, index) in tableRows" :key="index">
              <td v-for="column in tableColumns" :key="column.key" :title="cellText(row, column)">
                <a
                  v-if="cellHref(row, column)"
                  class="ov-cell"
                  :href="cellHref(row, column)"
                  target="_blank"
                  rel="noopener noreferrer"
                  >{{ cellText(row, column) }}</a
                >
                <SystemBadge
                  v-else-if="column.kind === 'badge' && isSystem(row[column.key])"
                  :system="String(row[column.key])"
                />
                <time
                  v-else-if="column.kind === 'time' && row[column.key]"
                  :title="absoluteTime(row[column.key])"
                  >{{ relativeTime(row[column.key]) }}</time
                >
                <code v-else-if="column.kind === 'mono'" class="mono ov-cell">{{
                  cellText(row, column)
                }}</code>
                <span v-else class="ov-cell">{{ cellText(row, column) }}</span>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
      <p v-else class="empty-state">暂无记录</p>
    </template>
    <p v-else class="ov-muted" :title="section.source">暂不支持展示该区块</p>
  </section>
</template>
<style scoped>
.ov-section {
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.ov-title {
  margin: 0;
  font-size: 15px;
}
.ov-stats {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(170px, 1fr));
  gap: 14px;
  margin: 0;
}
.ov-stat {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
  margin: 0;
}
.ov-stat-label {
  font-size: 12px;
  color: var(--muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ov-stat-value {
  font-size: 20px;
  font-weight: 650;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.tone-ok {
  color: var(--green);
}
.tone-warn {
  color: var(--amber);
}
.tone-error {
  color: var(--red);
}
.tone-muted {
  color: var(--muted);
}
.ov-muted {
  margin: 0;
  font-size: 12px;
  color: var(--muted);
}
.ov-quota-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 14px;
}
.ov-quota {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-width: 0;
}
.ov-quota-head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 12px;
  min-width: 0;
}
.ov-quota-label {
  min-width: 0;
  font-size: 13px;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ov-quota-value {
  font-size: 13px;
  color: var(--secondary);
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.ov-quota-track {
  height: 6px;
  border-radius: 999px;
  background: var(--line);
  overflow: hidden;
}
.ov-quota-track > i {
  display: block;
  height: 100%;
  border-radius: inherit;
  background: var(--green);
}
.ov-quota-track > i.tone-warn {
  background: var(--amber);
}
.ov-quota-track > i.tone-error {
  background: var(--red);
}
.ov-table td {
  max-width: 360px;
}
.ov-cell {
  display: inline-block;
  max-width: 360px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  vertical-align: bottom;
}
</style>

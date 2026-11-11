<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { SettingsGroup } from '../../console-types.ts'
import { errorText, useUnsavedChanges } from '../../console.ts'
import { notify } from '../../panel.ts'
import SchemaFields from '../SchemaFields.vue'
import ConfirmAction from '../ConfirmAction.vue'
const props = defineProps<{
  group: SettingsGroup
  save: (values: Record<string, unknown>) => Promise<unknown>
}>()
const values = ref<Record<string, unknown>>({}),
  baseline = ref<Record<string, unknown>>({}),
  busy = ref(false),
  error = ref(''),
  confirming = ref(false)
const revision = ref<number>()
const dirty = computed(() => JSON.stringify(values.value) !== JSON.stringify(baseline.value))
useUnsavedChanges(dirty)
watch(
  () => props.group,
  (group) => {
    if (dirty.value) return
    values.value = Object.fromEntries(
      group.fields.map((f) => [f.key, f.type === 'secret' ? '' : (f.value ?? '')]),
    )
    baseline.value = JSON.parse(JSON.stringify(values.value))
    revision.value = group.revision
  },
  { immediate: true },
)
const disabledFields = computed(() =>
  props.group.fields
    .filter(
      (f) => f.type === 'bool' && baseline.value[f.key] === true && values.value[f.key] === false,
    )
    .map((f) => f.label),
)
async function run() {
  busy.value = true
  error.value = ''
  try {
    const changed = Object.fromEntries(
      props.group.fields
        .filter(
          (f) =>
            JSON.stringify(values.value[f.key]) !== JSON.stringify(baseline.value[f.key]) &&
            (f.type !== 'secret' || !!values.value[f.key]),
        )
        .map((f) => [f.key, values.value[f.key]]),
    )
    const result = await props.save({
      ...changed,
      ...(revision.value === undefined ? {} : { revision: revision.value }),
    })
    if (
      result &&
      typeof result === 'object' &&
      'revision' in result &&
      typeof result.revision === 'number'
    )
      revision.value = result.revision
    for (const f of props.group.fields) if (f.type === 'secret') values.value[f.key] = ''
    baseline.value = JSON.parse(JSON.stringify(values.value))
    notify(`${props.group.title}已保存`)
  } catch (e) {
    error.value = errorText(e)
    throw e
  } finally {
    busy.value = false
  }
}
async function submit() {
  if (disabledFields.value.length) {
    confirming.value = true
    return
  }
  try {
    await run()
  } catch {
    /* inline field errors retain draft */
  }
}
</script>
<template>
  <section class="console-panel">
    <h3>{{ group.title }}</h3>
    <p v-if="group.description" class="cell-secondary">{{ group.description }}</p>
    <form @submit.prevent="submit">
      <SchemaFields v-model="values" :fields="group.fields" :disabled="busy" :error="error" />
      <p v-if="error" class="form-error" role="alert">{{ error }}</p>
      <button class="button primary" type="submit" :disabled="busy || !dirty">
        {{ busy ? '保存中…' : '保存' }}
      </button>
    </form>
    <ConfirmAction
      v-if="confirming"
      :title="`关闭「${group.title} · ${disabledFields.join('、')}」`"
      verb="关闭并保存"
      :action="run"
      @close="confirming = false"
    />
  </section>
</template>

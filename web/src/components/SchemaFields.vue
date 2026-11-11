<script setup lang="ts">
import { ref } from 'vue'
import type { Field } from '../console-types.ts'
defineProps<{
  fields: Field[]
  modelValue: Record<string, unknown>
  disabled?: boolean
  error?: string
}>()
const emit = defineEmits<{ 'update:modelValue': [value: Record<string, unknown>] }>()
const revealed = ref<Record<string, boolean>>({})
function list(value: unknown) {
  return Array.isArray(value) ? value.join('\n') : String(value ?? '')
}
function update(values: Record<string, unknown>, field: Field, event: Event) {
  const input = event.target as HTMLInputElement
  const value =
    field.type === 'bool'
      ? input.checked
      : field.type === 'number'
        ? input.value === ''
          ? null
          : Number(input.value)
        : field.type === 'list'
          ? input.value
              .split(/[\n,]/)
              .map((v) => v.trim())
              .filter(Boolean)
          : input.value
  emit('update:modelValue', { ...values, [field.key]: value })
}
</script>
<template>
  <div class="schema-fields">
    <label
      v-for="field in fields"
      :key="field.key"
      :class="{ 'check-field': field.type === 'bool' }"
      ><span>{{ field.label }}<span v-if="field.required"> *</span></span
      ><input
        v-if="field.type === 'bool'"
        type="checkbox"
        :checked="!!modelValue[field.key]"
        :disabled="disabled"
        @change="update(modelValue, field, $event)"
      /><select
        v-else-if="field.type === 'select'"
        :value="modelValue[field.key]"
        :disabled="disabled"
        @change="update(modelValue, field, $event)"
      >
        <option
          v-for="option in field.options || []"
          :key="typeof option === 'string' ? option : option.value"
          :value="typeof option === 'string' ? option : option.value"
        >
          {{ typeof option === 'string' ? option : option.label }}
        </option></select
      ><textarea
        v-else-if="field.type === 'textarea' || field.type === 'list'"
        :value="list(modelValue[field.key])"
        :disabled="disabled"
        :required="field.required"
        rows="3"
        @input="update(modelValue, field, $event)"
      /><span v-else class="secret-input"
        ><input
          :type="
            field.type === 'secret'
              ? revealed[field.key]
                ? 'text'
                : 'password'
              : field.type === 'number'
                ? 'number'
                : field.type === 'datetime'
                  ? 'datetime-local'
                  : 'text'
          "
          :value="modelValue[field.key] ?? ''"
          :min="field.min"
          :max="field.max"
          :disabled="disabled"
          :required="field.required"
          :autocomplete="field.type === 'secret' ? 'new-password' : undefined"
          :placeholder="field.type === 'secret' ? '已保存，留空则不修改' : undefined"
          @input="update(modelValue, field, $event)"
        /><button
          v-if="field.type === 'secret'"
          type="button"
          class="text-link"
          :aria-label="`${revealed[field.key] ? '隐藏' : '显示'}${field.label}`"
          @click="revealed[field.key] = !revealed[field.key]"
        >
          {{ revealed[field.key] ? '隐藏' : '显示' }}
        </button></span
      ><small v-if="field.help" class="cell-secondary">{{ field.help }}</small
      ><small v-if="error" class="form-error">{{ error }}</small></label
    >
  </div>
</template>

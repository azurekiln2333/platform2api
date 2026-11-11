<script setup lang="ts">
import { ref, watch } from 'vue'
import { channelLabel } from '../console.ts'
import type { AggregateError } from '../console-types.ts'
const props = defineProps<{ errors: AggregateError[] }>()
const emit = defineEmits<{ retry: [system: string] }>()
const hidden = ref<string[]>([])
watch(
  () => props.errors,
  () => {
    hidden.value = []
  },
)
</script>
<template>
  <template v-for="error in errors" :key="`${error.system}:${error.message}`"
    ><div v-if="!hidden.includes(error.system)" class="error-banner" role="alert">
      <span
        >{{ channelLabel(error.system) }}{{ error.code === 'usage_partial' ? '：' : ' 暂时不可达：'
        }}{{ error.message }}</span
      ><button type="button" @click="emit('retry', error.system)">重试</button
      ><button type="button" aria-label="关闭渠道警示" @click="hidden.push(error.system)">×</button>
    </div></template
  >
</template>

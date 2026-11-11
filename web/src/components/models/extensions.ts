import { defineAsyncComponent, type Component } from 'vue'

/** Native catalog tools are embedded in the merged page, never separate routes. */
export const modelExtensions: Record<string, Component> = {
  codebuddy: defineAsyncComponent(() => import('./CodebuddyModels.vue')),
}

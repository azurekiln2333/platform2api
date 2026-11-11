import { defineAsyncComponent, type Component } from 'vue'
import CnbAdvanced from './cnb/AdvancedSettings.vue'
import ZcodeOperations from './zcode/OperationsSettings.vue'
export const settingsEmbeds: Record<string, Component> = {
  'cnb-request-overrides': CnbAdvanced,
  'cnb-upstream-headers': CnbAdvanced,
  'cnb-registration-relay': CnbAdvanced,
  'claim-automation': ZcodeOperations,
  'ip-rules': ZcodeOperations,
}
const extras = import.meta.glob<{ default: Component }>('./*/SettingsExtras.vue')
export const settingsExtras = Object.fromEntries(
  Object.entries(extras).map(([path, loader]) => [
    path.split('/')[1],
    defineAsyncComponent(loader),
  ]),
)
const usage = import.meta.glob<{ default: Component }>('./*/UsageExtras.vue')
export const usageExtras = Object.fromEntries(
  Object.entries(usage).map(([path, loader]) => [path.split('/')[1], defineAsyncComponent(loader)]),
)

import { defineConfig } from '@playwright/test'

export default defineConfig({
  testDir: './e2e',
  fullyParallel: false,
  workers: 1,
  timeout: 30000,
  expect: { timeout: 7000 },
  use: {
    baseURL: 'http://127.0.0.1:19300',
    browserName: 'chromium',
    viewport: { width: 1440, height: 1000 },
    // F10 copies values from the clipboard API; grant it instead of relying on
    // the browser default so the「已复制」feedback is deterministic.
    permissions: ['clipboard-read', 'clipboard-write'],
    trace: 'retain-on-failure',
  },
  outputDir: 'test-results/browser',
  webServer: {
    command: 'node e2e/support/panel-fixture.mjs',
    url: 'http://127.0.0.1:19300',
    reuseExistingServer: false,
    timeout: 20000,
  },
})

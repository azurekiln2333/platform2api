import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import { readFileSync } from 'node:fs'

// The console owns its own version; the panel server reads it from here so a
// single source documents what the deployed shell reports.
const consolePackage = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8'))

export default defineConfig({
  plugins: [vue()],
  define: { __APP_VERSION__: JSON.stringify(consolePackage.version) },
  server: {
    port: 5173,
    proxy: { '/api': 'http://127.0.0.1:9000' },
  },
})

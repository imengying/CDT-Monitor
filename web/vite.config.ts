import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import tailwindcss from '@tailwindcss/vite'

/**
 * 前端构建配置（纯 TypeScript，无框架）。
 *
 * 产物输出到 `web/dist`，由 Worker 的 `ASSETS` 绑定托管
 * （见根目录 wrangler.toml 的 `[assets]`）。
 *
 * `server.proxy` 只在 `bun run dev:web` 时生效：把 /api 转发到
 * 本地 wrangler dev（默认 8787）。前端与 API 必须同源——会话 Cookie 是
 * SameSite=Strict，跨端口会被浏览器丢弃。
 */
export default defineConfig({
  plugins: [tailwindcss()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    target: 'es2022',
    rollupOptions: {
      output: {
        // ECharts 单独分包，避免主 chunk 过大
        manualChunks(id) {
          if (id.includes('node_modules/echarts') || id.includes('node_modules/zrender')) {
            return 'echarts'
          }
          if (id.includes('node_modules/lucide')) {
            return 'icons'
          }
          return undefined
        },
      },
    },
    chunkSizeWarningLimit: 900,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: false,
      },
    },
  },
})

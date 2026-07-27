import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // base="./" 让产物用相对路径，支持子路径部署（如 GitHub Pages / Cloudflare Pages）
  base: './',
  plugins: [react()],
  // pyodide 是运行时从 CDN 加载的，不能被 Vite 预打包（否则破坏路径解析）
  optimizeDeps: {
    exclude: ['pyodide'],
  },
  worker: {
    format: 'es',
  },
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8000',
        changeOrigin: true,
      },
    },
  },
})

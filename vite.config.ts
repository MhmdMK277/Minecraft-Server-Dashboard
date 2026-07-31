import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'node:path'

const root = import.meta.dirname

/**
 * The UI build.
 *
 * In development Vite serves on 5173 and proxies /api and /ws to the Node
 * service on 8422; in production the service serves ./dist itself and there is
 * only one port. The proxy exists so `npm run dev` still talks to one origin --
 * no CORS setup that production would not use, and therefore no class of bug
 * that only appears after deployment.
 */
const API_TARGET = process.env.MCDASH_DEV_TARGET ?? 'http://127.0.0.1:8422'

export default defineConfig({
  root: resolve(root, 'web'),
  plugins: [react()],
  resolve: {
    alias: {
      '@': resolve(root, 'web'),
      '@shared': resolve(root, 'shared'),
    },
  },
  build: {
    outDir: resolve(root, 'dist'),
    emptyOutDir: true,
    sourcemap: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: API_TARGET, changeOrigin: true },
      '/ws': { target: API_TARGET, ws: true },
    },
  },
})

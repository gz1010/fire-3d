/// <reference types="vitest/config" />
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// PORT: dev/preview server port (default 5173, strict). VITE_API_TARGET: where /api is proxied (default :8710).
const root = fileURLToPath(new URL('.', import.meta.url))
const port = Number(process.env.PORT ?? 5173)
const apiTarget = process.env.VITE_API_TARGET || 'http://localhost:8710'
const proxy = { '/api': { target: apiTarget, changeOrigin: true } }

export default defineConfig({
  plugins: [react()],
  server: { port, strictPort: true, proxy },
  preview: { port, strictPort: true, proxy },
  build: {
    target: 'es2022',
    chunkSizeWarningLimit: 3000,
    rolldownOptions: {
      input: {
        main: resolve(root, 'index.html'),
        'scene-dev': resolve(root, 'scene-dev.html'),
        'fx-dev': resolve(root, 'fx-dev.html'),
      },
    },
  },
  // `npm test` (vitest run): pure-logic unit tests next to the code (src/**/*.test.ts), Node environment (no DOM).
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
})

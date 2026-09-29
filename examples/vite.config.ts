import { fileURLToPath, URL } from 'node:url'
import tailwindcss from '@tailwindcss/vite'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { munPlugin } from '@mun/vite'

export default defineConfig({
  cacheDir: '../node_modules/.vite-mun-react',
  root: fileURLToPath(new URL('.', import.meta.url)),
  plugins: [
    munPlugin(),
    tailwindcss(),
    react(),
  ],
  optimizeDeps: {
    entries: ["./index.html"],
  },
  build: {
    outDir: '../demo-dist',
    emptyOutDir: true,
  },
})

import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import { munPhotosBridge } from './library-server.mjs'

export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)),
  cacheDir: '../../node_modules/.vite-net-shits-reels',
  plugins: [munPhotosBridge()],
  server: { host: '127.0.0.1', port: 3133, strictPort: true },
  preview: { host: '127.0.0.1', port: 3133, strictPort: true },
  build: {
    outDir: '../../net-shits-reels-dist', emptyOutDir: true,
    rollupOptions: {
      input: {
        app: fileURLToPath(new URL('./index.html', import.meta.url)),
        compare: fileURLToPath(new URL('./compare.html', import.meta.url)),
      },
    },
  },
})

import { fileURLToPath, URL } from "node:url"
import vue from "@vitejs/plugin-vue"
import { defineConfig } from "vite"
import { munPlugin } from "@mun/vite"

export default defineConfig({
  cacheDir: '../node_modules/.vite-mun-parity-vue',
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [munPlugin(), vue()],
  build: {
    rollupOptions: { input: fileURLToPath(new URL("./parity-vue-index.html", import.meta.url)) },
    outDir: "../parity-vue-dist",
    emptyOutDir: true,
  },
})

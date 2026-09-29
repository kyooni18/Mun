import { fileURLToPath, URL } from "node:url"
import tailwindcss from "@tailwindcss/vite"
import vue from "@vitejs/plugin-vue"
import { defineConfig } from "vite"
import { munPlugin } from "@mun/vite"

export default defineConfig({
  cacheDir: '../node_modules/.vite-mun-vue',
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [munPlugin(), tailwindcss(), vue()],
  build: {
    rollupOptions: { input: fileURLToPath(new URL("./vue-index.html", import.meta.url)) },
    outDir: "../vue-demo-dist",
    emptyOutDir: true,
  },
})

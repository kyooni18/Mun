import { fileURLToPath, URL } from "node:url"
import { defineConfig } from "vite"
import { munPlugin } from "@mun/vite"

export default defineConfig({
  cacheDir: '../node_modules/.vite-mun-web',
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [munPlugin()],
  build: {
    rollupOptions: { input: fileURLToPath(new URL("./web-index.html", import.meta.url)) },
    outDir: "../web-demo-dist",
    emptyOutDir: true,
  },
})

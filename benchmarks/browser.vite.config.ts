import { fileURLToPath, URL } from "node:url"
import { defineConfig } from "vite"
import { munPlugin } from "@mun/vite"

export default defineConfig({
  root: fileURLToPath(new URL("./browser", import.meta.url)),
  cacheDir: fileURLToPath(new URL("../node_modules/.vite-mun-browser-bench", import.meta.url)),
  plugins: [munPlugin()],
  build: {
    outDir: fileURLToPath(new URL("../browser-benchmark-dist", import.meta.url)),
    emptyOutDir: true,
    minify: "esbuild",
  },
})

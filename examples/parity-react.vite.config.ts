import { fileURLToPath, URL } from "node:url"
import react from "@vitejs/plugin-react"
import { defineConfig } from "vite"
import { munPlugin } from "@mun/vite"

export default defineConfig({
  cacheDir: '../node_modules/.vite-mun-parity-react',
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [munPlugin(), react()],
  build: {
    rollupOptions: { input: fileURLToPath(new URL("./parity-react-index.html", import.meta.url)) },
    outDir: "../parity-react-dist",
    emptyOutDir: true,
  },
})

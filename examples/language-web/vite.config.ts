import { fileURLToPath } from "node:url"
import { defineConfig } from "vite"
import { munPlugin } from "@mun-ui/vite"

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  plugins: [munPlugin()],
  build: { outDir: "../../output/language-web", emptyOutDir: true, sourcemap: true },
})

import { createServer } from "node:http"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { createServer as createViteServer } from "vite"
import { munPlugin } from "@mun-ui/vite"

// SSR + hydration host for the opt-in progressive-blur example.
const root = fileURLToPath(new URL(".", import.meta.url))
let vite
const server = createServer(async (req, res) => {
  if (req.url === "/") {
    try {
      const { default: App } = await vite.ssrLoadModule("/App.mun")
      const { renderToHTML } = await vite.ssrLoadModule("@mun-ui/web")
      const template = await readFile(new URL("index.html", import.meta.url), "utf8")
      res.writeHead(200, { "Content-Type": "text/html" }).end(await vite.transformIndexHtml("/", template.replace("<!--mun-html-->", renderToHTML(App))))
    } catch (error) {
      vite.ssrFixStacktrace(error)
      console.error(error)
      res.writeHead(500).end(String(error))
    }
    return
  }
  vite.middlewares(req, res, () => res.writeHead(404).end())
})
vite = await createViteServer({ root, configFile: false, plugins: [munPlugin()], server: { middlewareMode: true, hmr: { server } }, appType: "custom" })
server.listen(Number(process.env.PORT ?? 4179), "127.0.0.1", () => console.log("Mun progressive blur: http://127.0.0.1:" + server.address().port))
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, async () => { server.close(); await vite.close(); process.exit(0) })

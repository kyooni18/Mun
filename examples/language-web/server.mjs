import { createServer } from "node:http"
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { createServer as createViteServer } from "vite"
import { munPlugin } from "@mun-ui/vite"

// Demo deployment/transport boundary. No View or application state semantics here.
const root = fileURLToPath(new URL(".", import.meta.url))
let vite
const server = createServer(async (req, res) => {
  if (req.url === "/api/profile" && req.method === "POST") {
    let body = ""
    for await (const chunk of req) body += chunk
    try {
      const { name } = JSON.parse(body)
      await new Promise(resolve => setTimeout(resolve, 250))
      const failed = name === "fail"
      res.writeHead(failed ? 503 : 200, { "Content-Type": "application/json" })
      res.end(JSON.stringify(failed ? { error: "Demo failure" } : { name }))
    } catch {
      res.writeHead(400).end()
    }
    return
  }
  if (req.url === "/") {
    try {
      const { default: App } = await vite.ssrLoadModule("/App.mun")
      const { renderToHTML } = await vite.ssrLoadModule("@mun-ui/web")
      const template = await readFile(new URL("index.html", import.meta.url), "utf8")
      const html = await vite.transformIndexHtml("/", template.replace("<!--mun-html-->", renderToHTML(App)))
      res.writeHead(200, { "Content-Type": "text/html" }).end(html)
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
server.listen(Number(process.env.PORT ?? 4178), "127.0.0.1", () => console.log("Mun milestone: http://127.0.0.1:" + server.address().port))
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, async () => { server.close(); await vite.close(); process.exit(0) })

/** Local-only production server for Memes. No Vite listener or build tools at runtime. */
import { createServer } from 'node:http'
import { createReadStream } from 'node:fs'
import { stat } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { resolve, sep, extname } from 'node:path'
import { mediaMiddleware } from './library-server.mjs'

const host = '127.0.0.1'
const port = Number(process.env.MEMES_PORT || '3133')
const publicDir = resolve(fileURLToPath(new URL('../../net-shits-reels-dist/', import.meta.url)))
const mime = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
  ['.png', 'image/png'], ['.webp', 'image/webp'],
  ['.ico', 'image/x-icon'],
  ['.wasm', 'application/wasm'],
  ['.json', 'application/json; charset=utf-8'],
])

function sendError(res, status, message) {
  if (res.headersSent) return res.destroy()
  res.writeHead(status, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  })
  res.end(message)
}

async function serveStatic(req, res) {
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendError(res, 405, 'Method not allowed')
  let route
  try { route = decodeURIComponent(new URL(req.url || '/', `http://${host}:${port}`).pathname) }
  catch { return sendError(res, 400, 'Invalid URL') }
  if (route === '/healthz') {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    })
    return res.end(req.method === 'HEAD' ? undefined : '{"status":"ok"}')
  }
  const filename = resolve(publicDir, '.' + (route === '/' ? '/index.html' : route))
  if (!filename.startsWith(publicDir + sep)) return sendError(res, 403, 'Forbidden')
  let info
  try { info = await stat(filename) }
  catch (err) {
    if (err.code === 'ENOENT' || err.code === 'ENOTDIR') return sendError(res, 404, 'Not found')
    throw err
  }
  if (!info.isFile()) return sendError(res, 404, 'Not found')
  res.writeHead(200, {
    'Content-Type': mime.get(extname(filename).toLowerCase()) || 'application/octet-stream',
    'Content-Length': info.size,
    'Cache-Control': route.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache',
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
  })
  if (req.method === 'HEAD') return res.end()
  const stream = createReadStream(filename)
  stream.on('error', error => { console.error('Media static read:', error); res.destroy() })
  stream.pipe(res)
}

const bridge = mediaMiddleware()
const server = createServer((req, res) => {
  Promise.resolve().then(() => bridge(req, res, () => serveStatic(req, res)))
    .catch(error => {
      console.error('Request failed:', error)
      sendError(res, 500, 'Internal server error')
    })
})
server.on('error', error => { console.error('Memes server:', error); process.exitCode = 1 })
server.listen(port, host, () => {
  console.log(`Memes ready: http://${host}:${port}/ (${publicDir})`)
})

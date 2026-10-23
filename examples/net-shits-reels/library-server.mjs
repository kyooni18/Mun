/** Loopback-only, read-only bridge to exported Photos media (never reads the .photoslibrary database). */
import { createHash } from 'node:crypto'
import { createReadStream, existsSync } from 'node:fs'
import { mkdir, readdir, rename, stat, unlink } from 'node:fs/promises'
import { homedir, tmpdir } from 'node:os'
import { extname, join } from 'node:path'
import { spawn } from 'node:child_process'

export const mediaRoot = process.env.NETSHITS_MEDIA_DIR || join(homedir(), 'Movies', 'NetShitsShorts', 'assets')
const albums = ['Star Wars', 'IT', 'CATS (and others)', 'aerospace', 'meme_west', 'meme_east', 'KSP']
const formats = new Map([
  ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'], ['.png', 'image/png'],
  ['.webp', 'image/webp'], ['.gif', 'image/gif'], ['.heic', 'image/heic'],
  ['.heif', 'image/heif'], ['.avif', 'image/avif'], ['.tif', 'image/tiff'],
  ['.tiff', 'image/tiff'], ['.bmp', 'image/bmp'], ['.mp4', 'video/mp4'],
  ['.mov', 'video/quicktime'], ['.m4v', 'video/x-m4v'], ['.webm', 'video/webm'],
])
const videoExtensions = new Set(['.mp4', '.mov', '.m4v', '.webm'])
const conversionExtensions = new Set(['.heic', '.heif', '.tif', '.tiff', '.bmp'])
const thumbnails = join(homedir(), 'Movies', 'NetShitsShorts', '.reels-cache', 'posters')
const conversions = join(homedir(), 'Movies', 'NetShitsShorts', '.reels-cache', 'video')
let lastIndex = { items: [], map: new Map(), generatedAt: 0 }
let indexRefresh = null
const pending = new Map()

const hash = value => createHash('sha256').update(value).digest('hex').slice(0, 20)

async function buildIndex() {
  const items = []
  for (const album of albums) {
    let entries = []
    try { entries = await readdir(join(mediaRoot, album), { withFileTypes: true }) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
    for (const file of entries) {
      if (!file.isFile() || file.name.startsWith('.')) continue
      const ext = extname(file.name).toLowerCase()
      if (!formats.has(ext)) continue
      const path = join(mediaRoot, album, file.name)
      const details = await stat(path)
      if (!details.isFile() || details.size <= 0) continue
      const id = hash(album + '\0' + file.name)
      const video = videoExtensions.has(ext)
      items.push({
        id, album, filename: file.name.normalize('NFC'), type: video ? 'video' : 'image',
        url: video && ext !== '.mp4' && ext !== '.webm' ? `/stream/${id}` : (conversionExtensions.has(ext) ? `/poster/${id}` : `/media/${id}`),
        poster: video ? `/poster/${id}` : null,
        mime: formats.get(ext), bytes: details.size, modifiedAt: details.mtimeMs,
        // Strictly internal. Never included in the library JSON response.
        _path: path, _ext: ext,
      })
    }
  }
  // Preserve the source list only as an index; the viewer shuffles it with
  // unbiased, cryptographically sourced Fisher-Yates on every load and reshuffle.
  const map = new Map(items.map(item => [item.id, item]))
  lastIndex = { items, map, generatedAt: Date.now() }
  return lastIndex
}

async function getIndex(force = false) {
  if (!force && lastIndex.generatedAt && Date.now() - lastIndex.generatedAt < 45_000) return lastIndex
  if (!indexRefresh) indexRefresh = buildIndex().finally(() => { indexRefresh = null })
  return indexRefresh
}

function contentType(path) { return formats.get(extname(path).toLowerCase()) || 'application/octet-stream' }
function json(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' })
  res.end(JSON.stringify(value))
}

async function sendFile(req, res, path, mime = contentType(path)) {
  const details = await stat(path)
  const full = details.size
  const range = req.headers.range
  const headers = {
    'Content-Type': mime, 'Accept-Ranges': 'bytes', 'Cache-Control': 'private, max-age=3600',
    'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer',
  }
  let from = 0
  let to = full - 1
  if (range) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim())
    if (!match || (!match[1] && !match[2])) {
      res.writeHead(416, { ...headers, 'Content-Range': `bytes */${full}` })
      res.end()
      return
    }
    if (!match[1]) {
      const last = Number(match[2])
      if (!Number.isSafeInteger(last) || last === 0) { res.writeHead(416, { 'Content-Range': `bytes */${full}` }).end(); return }
      from = Math.max(0, full - last)
    } else {
      from = Number(match[1])
      to = match[2] ? Number(match[2]) : to
    }
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from >= full || from > to || to < 0) {
      res.writeHead(416, { ...headers, 'Content-Range': `bytes */${full}` })
      res.end()
      return
    }
    to = Math.min(to, full - 1)
    headers['Content-Range'] = `bytes ${from}-${to}/${full}`
  }
  headers['Content-Length'] = to - from + 1
  res.writeHead(range ? 206 : 200, headers)
  if (req.method === 'HEAD') { res.end(); return }
  const stream = createReadStream(path, { start: from, end: to })
  stream.on('error', () => res.destroy())
  req.on('close', () => stream.destroy())
  stream.pipe(res)
}

async function runProcess(command, args, timeoutMs = 60_000) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { stdio: 'ignore', windowsHide: true })
    const timeout = setTimeout(() => proc.kill('SIGKILL'), timeoutMs)
    proc.on('error', error => { clearTimeout(timeout); reject(error) })
    proc.on('exit', code => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error(`${command} exited ${code}`)) })
  })
}

async function cachedConversion(item, kind) {
  const root = kind === 'poster' ? thumbnails : conversions
  const destination = join(root, item.id + (kind === 'poster' ? '.jpg' : '.mp4'))
  if (existsSync(destination)) return destination
  const key = kind + ':' + item.id
  if (!pending.has(key)) {
    pending.set(key, (async () => {
      await mkdir(root, { recursive: true })
      const temp = join(root, `${item.id}.${process.pid}.tmp${kind === 'poster' ? '.jpg' : '.mp4'}`)
      try {
        if (kind === 'poster' && conversionExtensions.has(item._ext)) {
          await runProcess('sips', ['-s', 'format', 'jpeg', '-Z', '1440', item._path, '--out', temp])
        } else if (kind === 'poster') {
          try { await runProcess('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-ss', '.3', '-i', item._path, '-frames:v', '1', '-vf', 'scale=720:-2:force_original_aspect_ratio=decrease', '-q:v', '4', temp]) }
          catch { await runProcess('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', item._path, '-frames:v', '1', '-q:v', '4', temp]) }
        } else {
          await runProcess('ffmpeg', ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-i', item._path, '-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'h264_videotoolbox', '-b:v', '2800k', '-c:a', 'aac', '-b:a', '128k', '-movflags', '+faststart', temp], 300_000)
        }
        await rename(temp, destination)
      } catch (error) { await unlink(temp).catch(() => {}); throw error }
      return destination
    })().finally(() => pending.delete(key)))
  }
  return pending.get(key)
}

export function mediaMiddleware() {
  return async (req, res, next) => {
    const pathname = new URL(req.url || '/', 'http://127.0.0.1').pathname
    if (!pathname.startsWith('/api/') && !pathname.startsWith('/media/') && !pathname.startsWith('/poster/') && !pathname.startsWith('/stream/')) return next()
    if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'read only' })
    try {
      if (pathname === '/api/library') {
        const index = await getIndex(req.url?.includes('refresh=1'))
        res.setHeader('Referrer-Policy', 'no-referrer')
        return json(res, 200, { items: index.items.map(({ _path, _ext, filename, ...safe }) => safe), albumOrder: albums })
      }
      const match = /^\/(media|poster|stream)\/([a-f0-9]{20})$/.exec(pathname)
      if (!match) return json(res, 404, { error: 'unknown route' })
      const [, type, id] = match
      const item = (await getIndex()).map.get(id)
      if (!item) return json(res, 404, { error: 'missing item' })
      if (type === 'media') return sendFile(req, res, item._path, item.mime)
      if (type === 'poster' && !videoExtensions.has(item._ext) && !conversionExtensions.has(item._ext)) return json(res, 400, { error: 'not convertible' })
      if (type === 'stream' && !videoExtensions.has(item._ext)) return json(res, 400, { error: 'not video' })
      const dest = await cachedConversion(item, type)
      return sendFile(req, res, dest, type === 'poster' ? 'image/jpeg' : 'video/mp4')
    } catch (error) { return json(res, 500, { error: 'Failed to read media', detail: String(error.message || error).slice(0, 200) }) }
  }
}

export function munPhotosBridge() {
  return {
    name: 'mun-net-shits-readonly-photos-bridge',
    configureServer(server) { server.middlewares.use(mediaMiddleware()) },
    configurePreviewServer(server) { server.middlewares.use(mediaMiddleware()) },
  }
}

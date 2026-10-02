// Mün development protocol v1 (toolchain side). See native/mun-native/src/dev.rs.
// Frames: 4-byte big-endian length + UTF-8 JSON. Loopback TCP only; the host
// connects back and must present the per-session token in its hello.
import { randomBytes } from 'node:crypto'
import { createServer } from 'node:net'

export const DEV_PROTOCOL_VERSION = 1
export const MAX_FRAME_BYTES = 16 * 1024 * 1024

export function encodeFrame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  if (body.length > MAX_FRAME_BYTES) throw new Error(`Dev message of ${body.length} bytes exceeds ${MAX_FRAME_BYTES}`)
  const header = Buffer.alloc(4)
  header.writeUInt32BE(body.length)
  return Buffer.concat([header, body])
}

/** Incremental decoder; throws on oversized or malformed frames. */
export function createFrameDecoder(onMessage) {
  let buffer = Buffer.alloc(0)
  return chunk => {
    buffer = Buffer.concat([buffer, chunk])
    while (buffer.length >= 4) {
      const length = buffer.readUInt32BE(0)
      if (length > MAX_FRAME_BYTES) throw new Error(`Dev frame of ${length} bytes exceeds ${MAX_FRAME_BYTES}`)
      if (buffer.length < 4 + length) return
      const body = buffer.subarray(4, 4 + length)
      buffer = buffer.subarray(4 + length)
      onMessage(JSON.parse(body.toString('utf8')))
    }
  }
}

/**
 * Listen on an ephemeral loopback port for exactly one authenticated host.
 * Resolves `{ endpoint, token, connection }` where `connection` resolves to a
 * channel once the host's hello is verified.
 */
export async function listenForHost({ irVersion, onEvent = () => {} } = {}) {
  const token = randomBytes(24).toString('hex')
  let accept, fail
  const connection = new Promise((resolve, reject) => { accept = resolve; fail = reject })
  connection.catch(() => {})
  const server = createServer({ noDelay: true }, socket => {
    let channel
    const pending = new Map()
    let nextId = 1
    const decode = createFrameDecoder(message => {
      if (!channel) {
        if (message.type !== 'hello' || message.token !== token) { socket.destroy(); return }
        if (message.protocol !== DEV_PROTOCOL_VERSION || (irVersion !== undefined && message.semanticUiIrVersion !== irVersion)) {
          socket.destroy()
          fail(new Error(`Native host speaks dev protocol ${message.protocol} / IR ${message.semanticUiIrVersion}; toolchain expects ${DEV_PROTOCOL_VERSION} / ${irVersion}.`))
          return
        }
        server.close() // one host per session; stop accepting.
        channel = {
          pid: message.pid,
          request(type, payload = {}, timeoutMs = 10000) {
            const id = nextId++
            if (socket.destroyed || !socket.writable) return Promise.reject(new Error('Native app disconnected'))
            return new Promise((resolve, reject) => {
              const timer = setTimeout(() => { pending.delete(id); reject(new Error(`Dev ${type} timed out`)) }, timeoutMs)
              pending.set(id, { resolve, reject, timer })
              try { socket.write(encodeFrame({ type, id, ...payload })) }
              catch (error) { clearTimeout(timer); pending.delete(id); reject(error) }
            })
          },
          close() { socket.end() },
          closed: new Promise(resolve => socket.once('close', resolve)),
        }
        accept(channel)
        return
      }
      const waiter = message.id !== undefined && pending.get(message.id)
      if (waiter) { pending.delete(message.id); clearTimeout(waiter.timer); waiter.resolve(message) }
      else onEvent(message)
    })
    socket.on('data', chunk => { try { decode(chunk) } catch (error) { onEvent({ type: 'protocol-error', message: error.message }); socket.destroy() } })
    socket.on('error', () => {})
    socket.on('close', () => {
      for (const { reject, timer } of pending.values()) { clearTimeout(timer); reject(new Error('Native app disconnected')) }
      pending.clear()
    })
  })
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve) })
  const { port } = server.address()
  return {
    endpoint: `127.0.0.1:${port}`,
    token,
    connection,
    close() { server.close(); fail(new Error('Dev session closed before the native app connected')) },
  }
}

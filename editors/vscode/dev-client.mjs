import { existsSync, readFileSync } from 'node:fs'
import { connect } from 'node:net'
import { resolve } from 'node:path'

export const DEV_PROTOCOL_VERSION = 2
const MAX_FRAME_BYTES = 16 * 1024 * 1024

export function encodeDevFrame(message) {
  const body = Buffer.from(JSON.stringify(message), 'utf8')
  if (body.length > MAX_FRAME_BYTES) throw new Error(`Mün dev message exceeds ${MAX_FRAME_BYTES} bytes.`)
  const header = Buffer.alloc(4)
  header.writeUInt32BE(body.length)
  return Buffer.concat([header, body])
}

export function createDevFrameDecoder(onMessage) {
  let buffer = Buffer.alloc(0)
  return chunk => {
    buffer = Buffer.concat([buffer, chunk])
    while (buffer.length >= 4) {
      const length = buffer.readUInt32BE(0)
      if (length > MAX_FRAME_BYTES) throw new Error(`Mün dev frame exceeds ${MAX_FRAME_BYTES} bytes.`)
      if (buffer.length < length + 4) return
      const body = buffer.subarray(4, length + 4)
      buffer = buffer.subarray(length + 4)
      onMessage(JSON.parse(body.toString('utf8')))
    }
  }
}

export function readDevSession(projectRoot) {
  const file = resolve(projectRoot, '.mun', 'dev', 'session.json')
  if (!existsSync(file)) throw new Error('No running mun dev session for this project.')
  const session = JSON.parse(readFileSync(file, 'utf8'))
  if (session.protocol !== DEV_PROTOCOL_VERSION) throw new Error(`Mün dev protocol ${session.protocol} does not match extension protocol ${DEV_PROTOCOL_VERSION}.`)
  if (typeof session.endpoint !== 'string' || typeof session.token !== 'string') throw new Error('Invalid Mün dev session metadata.')
  const separator = session.endpoint.lastIndexOf(':')
  const host = session.endpoint.slice(0, separator)
  const port = Number(session.endpoint.slice(separator + 1))
  if (host !== '127.0.0.1' || !Number.isInteger(port) || port <= 0 || port > 65535) throw new Error('Refusing invalid or non-loopback Mün inspector endpoint.')
  return { ...session, file, host, port }
}

export async function inspectDevSession(projectRoot, { includeValues = false, timeoutMs = 2500 } = {}) {
  const session = readDevSession(projectRoot)
  const socket = connect({ host: session.host, port: session.port })
  return await new Promise((resolvePromise, reject) => {
    let settled = false
    const finish = (error, value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      if (error) reject(error)
      else resolvePromise(value)
    }
    const timer = setTimeout(() => finish(new Error('Timed out while inspecting the running Mün app.')), timeoutMs)
    const decode = createDevFrameDecoder(message => {
      if (message.type === 'error') finish(new Error(message.message ?? 'Mün inspector rejected the request.'))
      else if (message.type === 'snapshot' && message.snapshot) finish(undefined, message.snapshot)
      else finish(new Error(`Unexpected Mün inspector reply: ${message.type ?? '<missing>'}`))
    })
    socket.once('error', error => finish(new Error(`Could not reach mun dev: ${error.message}`)))
    socket.on('data', chunk => {
      try { decode(chunk) }
      catch (error) { finish(error) }
    })
    socket.once('connect', () => {
      socket.write(encodeDevFrame({ type: 'hello', token: session.token }))
      socket.write(encodeDevFrame({ type: 'inspect', id: 1, includeValues }))
    })
  })
}

export function runtimeTree(snapshot) {
  const byId = new Map((snapshot?.nodes ?? []).map(node => [node.id, node]))
  const roots = (snapshot?.nodes ?? []).filter(node => !node.parent || !byId.has(node.parent))
  return {
    roots,
    byId,
    children(node) { return (node?.children ?? []).map(id => byId.get(id)).filter(Boolean) },
  }
}

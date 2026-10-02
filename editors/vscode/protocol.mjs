// Bounded JSON-RPC/LSP framing. Shared by the server and lightweight editor client.
const MAX_MESSAGE = 8 * 1024 * 1024
export class MessageReader {
  constructor(onMessage, onError) { this.buffer = Buffer.alloc(0); this.onMessage = onMessage; this.onError = onError; this.failed = false }
  feed(chunk) {
    if (this.failed) return
    this.buffer = Buffer.concat([this.buffer, chunk])
    try {
      while (this.buffer.length) {
        const separator = this.buffer.indexOf('\r\n\r\n')
        if (separator < 0) { if (this.buffer.length > 8192) throw new Error('LSP header exceeds 8192 bytes.'); return }
        const headers = this.buffer.subarray(0, separator).toString('ascii')
        const lengths = [...headers.matchAll(/^Content-Length:\s*(\d+)\s*$/gim)]
        if (lengths.length !== 1) throw new Error('LSP requires exactly one Content-Length header.')
        const length = Number(lengths[0][1])
        if (!Number.isSafeInteger(length) || length <= 0 || length > MAX_MESSAGE) throw new Error('LSP Content-Length is outside the supported limit.')
        const start = separator + 4
        if (this.buffer.length < start + length) return
        const body = this.buffer.subarray(start, start + length).toString('utf8')
        this.buffer = this.buffer.subarray(start + length)
        this.onMessage(JSON.parse(body))
      }
    } catch (error) { this.failed = true; this.buffer = Buffer.alloc(0); this.onError(error) }
  }
}
export function encode(message) {
  const body = JSON.stringify(message)
  return `Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`
}

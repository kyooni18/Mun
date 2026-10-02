import { spawn } from 'node:child_process'
import { MessageReader, encode } from './protocol.mjs'
export class LspClient {
  constructor(server, onNotification, onFailure) {
    this.nextId = 0; this.pending = new Map(); this.stopped = false
    this.child = spawn(server.command, server.args, { cwd: server.cwd, env: server.env, stdio: ['pipe', 'pipe', 'pipe'] })
    const fail = error => {
      for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error) }
      this.pending.clear()
      if (!this.stopped) onFailure(error)
    }
    const reader = new MessageReader(message => {
      if (message.id !== undefined) {
        const pending = this.pending.get(message.id)
        if (pending) { clearTimeout(pending.timer); this.pending.delete(message.id); message.error ? pending.reject(new Error(message.error.message)) : pending.resolve(message.result) }
      } else onNotification(message.method, message.params)
    }, error => { fail(error); this.child.kill() })
    this.child.stdout.on('data', chunk => reader.feed(chunk))
    this.child.stderr.on('data', chunk => onNotification('mun/log', { message: chunk.toString() }))
    this.child.once('error', fail)
    this.child.once('close', code => fail(new Error(`Mün language server exited (${code}).`)))
    this.child.stdin.on('error', fail)
  }
  send(message) { this.child.stdin.write(encode({ jsonrpc: '2.0', ...message })) }
  notify(method, params) { this.send({ method, params }) }
  request(method, params) {
    const id = ++this.nextId
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(new Error(`Mün LSP request timed out: ${method}`)) }, 15000)
      this.pending.set(id, { resolve, reject, timer }); this.send({ id, method, params })
    })
  }
  async dispose() {
    if (this.stopped) return
    this.stopped = true
    try { await this.request('shutdown', null); this.notify('exit') } catch { this.child.kill() }
    const timer = setTimeout(() => this.child.kill('SIGKILL'), 2000)
    this.child.once('close', () => clearTimeout(timer))
  }
}

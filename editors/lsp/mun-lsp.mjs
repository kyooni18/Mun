#!/usr/bin/env node

import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

async function loadCompiler() {
  for (const request of ['@vune-ui/compiler', resolve(root, 'packages/compiler/dist/index.js')]) {
    try {
      const compiler = await import(request.startsWith('.') || request.startsWith('/') ? pathToFileURL(request).href : request)
      if (typeof compiler.diagnoseVuneSource === 'function') return compiler
    } catch { /* A published standalone server may run without the optional compiler. */ }
  }
  return undefined
}

const compiler = await loadCompiler()
const documents = new Map()

function send(message) {
  const body = JSON.stringify(message)
  process.stdout.write(`Content-Length: ${Buffer.byteLength(body, 'utf8')}\r\n\r\n${body}`)
}

function response(id, result) { send({ jsonrpc: '2.0', id, result }) }
function notification(method, params) { send({ jsonrpc: '2.0', method, params }) }

function positionAt(source, offset) {
  const bounded = Math.max(0, Math.min(source.length, offset))
  const before = source.slice(0, bounded)
  const line = before.split('\n').length - 1
  return { line, character: bounded - (before.lastIndexOf('\n') + 1) }
}

function offsetAt(source, position) {
  const lines = source.split('\n')
  const line = Math.max(0, Math.min(lines.length - 1, position?.line ?? 0))
  return lines.slice(0, line).reduce((total, value) => total + value.length + 1, 0) + Math.max(0, position?.character ?? 0)
}

function fallbackDiagnostics(source) {
  const result = []
  const stack = []
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if ('({['.includes(character)) stack.push({ character, index })
    if (!')}]'.includes(character)) continue
    const expected = { ')': '(', ']': '[', '}': '{' }[character]
    const opening = stack.pop()
    if (!opening || opening.character !== expected) result.push({ severity: 1, code: 'VUNE_SYNTAX', message: `Unexpected '${character}' in Vune source.`, index })
  }
  for (const opening of stack) result.push({ severity: 1, code: 'VUNE_SYNTAX', message: `Unclosed '${opening.character}' in Vune source.`, index: opening.index })
  return result
}

function diagnosticsFor(source) {
  const diagnostics = compiler ? compiler.diagnoseVuneSource(source) : fallbackDiagnostics(source)
  return diagnostics.map(diagnostic => {
    const index = diagnostic.line && diagnostic.column
      ? offsetAt(source, { line: diagnostic.line - 1, character: diagnostic.column - 1 })
      : diagnostic.index ?? 0
    const start = positionAt(source, index)
    return {
      range: { start, end: { line: start.line, character: start.character + 1 } },
      severity: diagnostic.severity === 'warning' ? 2 : 1,
      code: diagnostic.code,
      source: 'vune',
      message: diagnostic.message,
    }
  })
}

function publish(uri, source) {
  notification('textDocument/publishDiagnostics', { uri, diagnostics: diagnosticsFor(source) })
}

function completionItems(source) {
  const names = new Set(['Text', 'VStack', 'HStack', 'ZStack', 'ScrollView', 'SafeArea', 'GeometryReader', 'Spacer', 'Button', 'ForEach', 'Element'])
  for (const match of source.matchAll(/\bstruct\s+([A-Za-z_$][A-Za-z0-9_$]*)/g)) names.add(match[1])
  const tags = compiler?.semanticHtmlTagNames ?? ['div', 'span', 'button', 'main', 'section', 'header', 'footer', 'input', 'label', 'ul', 'li']
  return [...names].map(label => ({ label, kind: 3, detail: 'Vune View' })).concat(tags.map(label => ({ label, kind: 10, detail: 'Raw HTML element' })))
}

function formatSource(source) {
  let depth = 0
  return source.split(/\r?\n/).map(line => {
    const trimmed = line.trim()
    if (!trimmed) return ''
    if (/^[}\])]/.test(trimmed)) depth = Math.max(0, depth - 1)
    const formatted = `${'  '.repeat(depth)}${trimmed}`
    if (/[{[(]\s*$/.test(trimmed)) depth += 1
    return formatted
  }).join('\n')
}

function handle(message) {
  const { id, method, params = {} } = message
  if (method === 'initialize') {
    response(id, {
      capabilities: {
        textDocumentSync: { openClose: true, change: 1, save: { includeText: true } },
        completionProvider: { triggerCharacters: ['<', ':', '.', '@'] },
        hoverProvider: true,
        documentFormattingProvider: true,
      },
      serverInfo: { name: 'vune-lsp', version: '0.1.0' },
    })
    return
  }
  if (method === 'shutdown') { response(id, null); return }
  if (method === 'exit') { process.exit(0); return }
  if (method === 'textDocument/didOpen') {
    const { uri, text } = params.textDocument
    documents.set(uri, text)
    publish(uri, text)
    return
  }
  if (method === 'textDocument/didChange') {
    const uri = params.textDocument.uri
    const current = documents.get(uri) ?? ''
    const next = params.contentChanges?.at(-1)
    const text = next?.range ? `${current.slice(0, offsetAt(current, next.range.start))}${next.text}${current.slice(offsetAt(current, next.range.end))}` : next?.text ?? current
    documents.set(uri, text)
    publish(uri, text)
    return
  }
  if (method === 'textDocument/didSave') {
    const uri = params.textDocument.uri
    const text = params.text ?? documents.get(uri) ?? ''
    documents.set(uri, text)
    publish(uri, text)
    return
  }
  if (method === 'textDocument/didClose') {
    const uri = params.textDocument.uri
    documents.delete(uri)
    notification('textDocument/publishDiagnostics', { uri, diagnostics: [] })
    return
  }
  if (method === 'textDocument/completion') {
    const source = documents.get(params.textDocument.uri) ?? ''
    response(id, { isIncomplete: false, items: completionItems(source) })
    return
  }
  if (method === 'textDocument/hover') {
    const source = documents.get(params.textDocument.uri) ?? ''
    const offset = offsetAt(source, params.position)
    const prefix = source.slice(0, offset)
    const token = /[A-Za-z_$][A-Za-z0-9_$]*$/.exec(prefix)?.[0]
    if (!token) { response(id, null); return }
    let view
    try { view = compiler?.createVuneSemanticModel(source, params.textDocument.uri).view(token) } catch { view = undefined }
    response(id, view ? { contents: { kind: 'markdown', value: `\`\`\`vune-ui\n${view.name}\n\`\`\`` } } : { contents: { kind: 'markdown', value: `Vune symbol \`${token}\`` } })
    return
  }
  if (method === 'textDocument/formatting') {
    const uri = params.textDocument.uri
    const source = documents.get(uri) ?? ''
    const text = formatSource(source)
    response(id, [{ range: { start: { line: 0, character: 0 }, end: positionAt(source, source.length) }, newText: text }])
    return
  }
  if (id !== undefined) response(id, null)
}

let buffer = Buffer.alloc(0)
process.stdin.on('data', chunk => {
  buffer = Buffer.concat([buffer, chunk])
  while (true) {
    const separator = buffer.indexOf('\r\n\r\n')
    if (separator < 0) return
    const headers = buffer.slice(0, separator).toString('utf8')
    const length = Number(/Content-Length:\s*(\d+)/i.exec(headers)?.[1] ?? 0)
    const start = separator + 4
    if (!length || buffer.length < start + length) return
    const body = buffer.slice(start, start + length).toString('utf8')
    buffer = buffer.slice(start + length)
    let message
    try { message = JSON.parse(body); handle(message) } catch (error) {
      if (message?.id !== undefined) response(message.id, null)
      console.error(error)
    }
  }
})

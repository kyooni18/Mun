#!/usr/bin/env node
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { LanguageService, tokenTypes } from './service.mjs'
import { offsetAt } from './source.mjs'
import { MessageReader, encode } from '../vscode/protocol.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')
const version = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8')).version
const service = new LanguageService()
const open = new Set()
let shutdown = false
function send(message) { process.stdout.write(encode(message)) }
function response(id, result) { send({ jsonrpc: '2.0', id, result }) }
function error(id, code, message) { send({ jsonrpc: '2.0', id, error: { code, message } }) }
function publish(uri) { send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri, diagnostics: service.diagnostics(uri) } }) }

function projectRoot(path) {
  let directory = existsSync(path) && statSync(path).isDirectory() ? path : dirname(path)
  while (true) {
    if (existsSync(resolve(directory, 'mun.toml'))) return directory
    const parent = dirname(directory)
    if (parent === directory) return undefined
    directory = parent
  }
}
function indexProject(path) {
  const directory = projectRoot(path)
  if (!directory) return
  function walk(path) {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || ['node_modules', 'Assets', 'build', 'dist'].includes(entry.name) || entry.isSymbolicLink()) continue
      const file = resolve(path, entry.name)
      if (entry.isDirectory()) walk(file)
      else if (entry.name.endsWith('.mun') && entry.isFile()) {
        const uri = pathToFileURL(file).href
        if (!open.has(uri)) service.update(uri, readFileSync(file, 'utf8'))
      }
    }
  }
  walk(directory)
}
function handle(message) {
  const { id, method, params = {} } = message
  if (method === 'initialize') {
    for (const uri of [...(params.workspaceFolders ?? []).map(folder => folder.uri), ...(params.rootUri ? [params.rootUri] : [])]) {
      try { indexProject(fileURLToPath(uri)) } catch (e) { console.error(e.message) }
    }
    response(id, {
      capabilities: {
        positionEncoding: 'utf-16',
        textDocumentSync: { openClose: true, change: 2, save: { includeText: true } },
        completionProvider: { triggerCharacters: ['.', '@', '$', ':'] }, hoverProvider: true,
        signatureHelpProvider: { triggerCharacters: ['(', ',', ':'] }, definitionProvider: true,
        referencesProvider: true, renameProvider: { prepareProvider: true },
        documentFormattingProvider: true, documentSymbolProvider: true, workspaceSymbolProvider: true,
        semanticTokensProvider: { legend: { tokenTypes, tokenModifiers: [] }, full: true },
        foldingRangeProvider: true, selectionRangeProvider: true,
        codeActionProvider: { codeActionKinds: ['quickfix'] },
      },
      serverInfo: { name: 'mun-lsp', version },
    }); return
  }
  if (method === 'shutdown') { shutdown = true; response(id, null); return }
  if (method === 'exit') { process.exit(shutdown ? 0 : 1); return }
  if (method === 'initialized' || method === '$/cancelRequest') return
  if (shutdown) { if (id !== undefined) error(id, -32600, 'Server has shut down.'); return }
  if (method === 'textDocument/didOpen') {
    const { uri, text, version } = params.textDocument
    if (!uri.endsWith('.mun')) return
    try { indexProject(fileURLToPath(uri)) } catch (e) { console.error(e.message) }
    open.add(uri); service.update(uri, text, version); publish(uri); return
  }
  if (method === 'textDocument/didChange') {
    const { uri, version } = params.textDocument
    let source = service.snapshot(uri)?.source ?? ''
    for (const change of params.contentChanges ?? []) source = change.range ? source.slice(0, offsetAt(source, change.range.start)) + change.text + source.slice(offsetAt(source, change.range.end)) : change.text
    service.update(uri, source, version); publish(uri); return
  }
  if (method === 'textDocument/didSave') {
    const { uri } = params.textDocument
    if (params.text !== undefined) service.update(uri, params.text)
    publish(uri); return
  }
  if (method === 'textDocument/didClose') {
    const { uri } = params.textDocument
    open.delete(uri)
    try { service.update(uri, readFileSync(fileURLToPath(uri), 'utf8')) } catch { service.remove(uri) }
    send({ jsonrpc: '2.0', method: 'textDocument/publishDiagnostics', params: { uri, diagnostics: [] } }); return
  }
  if (method === 'workspace/didChangeWatchedFiles') {
    for (const change of params.changes ?? []) {
      if (!change.uri.endsWith('.mun') || open.has(change.uri)) continue
      if (change.type === 3) service.remove(change.uri)
      else try { service.update(change.uri, readFileSync(fileURLToPath(change.uri), 'utf8')) } catch (e) { console.error(e.message) }
    }
    return
  }
  const uri = params.textDocument?.uri
  const requests = {
    'textDocument/completion': () => ({ isIncomplete: false, items: service.completion(uri, params.position) }),
    'textDocument/hover': () => service.hover(uri, params.position),
    'textDocument/signatureHelp': () => service.signatureHelp(uri, params.position),
    'textDocument/definition': () => service.definition(uri, params.position),
    'textDocument/references': () => service.references(uri, params.position, params.context?.includeDeclaration),
    'textDocument/prepareRename': () => service.prepareRename(uri, params.position),
    'textDocument/rename': () => service.rename(uri, params.position, params.newName),
    'textDocument/formatting': () => service.formatting(uri),
    'textDocument/codeAction': () => service.codeActions(uri, params.range, params.context),
    'textDocument/documentSymbol': () => service.symbols(uri),
    'workspace/symbol': () => service.workspaceSymbols(params.query ?? ''),
    'textDocument/semanticTokens/full': () => service.semanticTokens(uri),
    'textDocument/foldingRange': () => service.folding(uri),
    'textDocument/selectionRange': () => service.selectionRanges(uri, params.positions),
  }
  if (id !== undefined) {
    if (!requests[method]) { error(id, -32601, `Unsupported method: ${method}`); return }
    try { response(id, requests[method]()) } catch (e) { error(id, -32602, e.message) }
  }
}
const reader = new MessageReader(handle, e => { console.error(`LSP protocol error: ${e.message}`); process.exitCode = 1; process.stdin.destroy() })
process.stdin.on('data', chunk => reader.feed(chunk))

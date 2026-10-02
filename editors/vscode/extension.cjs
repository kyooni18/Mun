const vscode = require('vscode')
const path = require('node:path')
const { spawn } = require('node:child_process')

let clients = []
const folderStates = new Map()

class RuntimeTreeProvider {
  constructor() { this.emitter = new vscode.EventEmitter(); this.onDidChangeTreeData = this.emitter.event }
  refresh() { this.emitter.fire(undefined) }
  dispose() { this.emitter.dispose() }
  getChildren(element) {
    if (!element) {
      const active = [...folderStates.values()].filter(state => state.tree)
      if (active.length === 1) return active[0].tree.roots.map(node => ({ type: 'runtime', state: active[0], node }))
      return active.map(state => ({ type: 'folder', state }))
    }
    if (element.type === 'folder') return element.state.tree.roots.map(node => ({ type: 'runtime', state: element.state, node }))
    if (element.type === 'runtime') return element.state.tree.children(element.node).map(node => ({ type: 'runtime', state: element.state, node }))
    return []
  }
  getTreeItem(element) {
    if (element.type === 'folder') {
      const item = new vscode.TreeItem(element.state.folder.name ?? path.basename(element.state.root), vscode.TreeItemCollapsibleState.Expanded)
      item.description = element.state.snapshot ? `rev ${element.state.snapshot.devRevision ?? '?'}` : undefined
      item.contextValue = 'munRuntimeProject'
      return item
    }
    const { node, state } = element
    const children = state.tree.children(node)
    const item = new vscode.TreeItem(node.kind, children.length ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None)
    const component = node.component ? `<${node.component}>` : ''
    const source = node.source ? `${node.source.file}:${node.source.line}` : ''
    item.description = [component, source].filter(Boolean).join('  ')
    const frame = node.frame ? `frame ${node.frame.map(value => Math.round(value)).join(', ')}` : ''
    item.tooltip = [node.id, source, frame].filter(Boolean).join('\n')
    item.contextValue = 'munRuntimeNode'
    if (node.source) item.command = { command: 'mun.openRuntimeSource', title: 'Open Mün Source', arguments: [state, node] }
    return item
  }
}

async function activate(context) {
  const { discoverMunCommand } = await import('./discovery.mjs')
  const { LspClient } = await import('./client.mjs')
  const { inspectDevSession, runtimeTree } = await import('./dev-client.mjs')
  const version = context.extension?.packageJSON?.version ?? require('./package.json').version
  const folders = vscode.workspace.workspaceFolders ?? []
  const diagnostics = vscode.languages.createDiagnosticCollection('mun')
  const runtimeDiagnostics = vscode.languages.createDiagnosticCollection('mun-runtime')
  const output = vscode.window.createOutputChannel('Mün Language Server')
  const devOutput = vscode.window.createOutputChannel('Mün Development')
  const treeProvider = new RuntimeTreeProvider()
  const treeView = vscode.window.createTreeView('mun.runtimeView', { treeDataProvider: treeProvider, showCollapseAll: true })
  context.subscriptions.push(diagnostics, runtimeDiagnostics, output, devOutput, treeProvider, treeView)

  const workspaceEntries = folders.length ? folders : [{ uri: vscode.Uri.file(process.cwd()), name: 'Mün' }]
  for (const folder of workspaceEntries) {
    const state = { folder, root: folder.uri.fsPath, child: undefined, timer: undefined, snapshot: undefined, tree: undefined, runtimeDiagnosticUris: new Set(), toolchain: undefined }
    folderStates.set(folder.uri.toString(), state)
    const config = vscode.workspace.getConfiguration('mun', folder.uri)
    try {
      state.toolchain = await discoverMunCommand({ cwd: folder.uri.fsPath, command: config.get('server.command'), expectedVersion: version })
      const server = { ...state.toolchain, args: [...state.toolchain.args, 'lsp', '--stdio'] }
      const client = new LspClient(server, (method, params) => {
        if (method === 'textDocument/publishDiagnostics') diagnostics.set(vscode.Uri.parse(params.uri), params.diagnostics.map(d => {
          const diagnostic = new vscode.Diagnostic(range(d.range), d.message, d.severity === 2 ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error)
          diagnostic.source = 'mun'; diagnostic.code = d.code; return diagnostic
        }))
        if (method === 'mun/log') output.append(params.message)
      }, error => { output.appendLine(error.message); vscode.window.showErrorMessage(error.message) })
      clients.push(client)
      const initialization = await client.request('initialize', { processId: process.pid, rootUri: folder.uri.toString(), workspaceFolders: [{ uri: folder.uri.toString(), name: folder.name ?? 'Mün' }], capabilities: { general: { positionEncodings: ['utf-16'] } } })
      if (initialization.serverInfo?.version !== version) throw new Error(`Mün LSP ${initialization.serverInfo?.version} does not match extension ${version}.`)
      client.notify('initialized', {})
      const belongs = document => document.languageId === 'mun' && document.uri.scheme === 'file' && (!folders.length || vscode.workspace.getWorkspaceFolder(document.uri)?.uri.toString() === folder.uri.toString())
      const selector = { language: 'mun', scheme: 'file', pattern: `${folder.uri.fsPath.replaceAll('\\', '/')}/**/*.mun` }
      const request = (method, document, params = {}) => client.request(method, { textDocument: { uri: document.uri.toString() }, ...params })
      const open = document => { if (belongs(document)) client.notify('textDocument/didOpen', { textDocument: { uri: document.uri.toString(), languageId: 'mun', version: document.version, text: document.getText() } }) }
      vscode.workspace.textDocuments.forEach(open)
      context.subscriptions.push(
        vscode.workspace.onDidOpenTextDocument(open),
        vscode.workspace.onDidChangeTextDocument(event => { if (belongs(event.document)) client.notify('textDocument/didChange', { textDocument: { uri: event.document.uri.toString(), version: event.document.version }, contentChanges: [{ text: event.document.getText() }] }) }),
        vscode.workspace.onDidCloseTextDocument(document => { if (belongs(document)) client.notify('textDocument/didClose', { textDocument: { uri: document.uri.toString() } }) }),
        vscode.languages.registerDocumentFormattingEditProvider(selector, { provideDocumentFormattingEdits: async (d, options) => (await request('textDocument/formatting', d, { options })).map(e => vscode.TextEdit.replace(range(e.range), e.newText)) }),
        vscode.languages.registerCompletionItemProvider(selector, { provideCompletionItems: async (d, p) => (await request('textDocument/completion', d, { position: p })).items.map(item => {
          const completion = new vscode.CompletionItem(item.label, item.kind === 7 ? vscode.CompletionItemKind.Class : item.kind === 2 ? vscode.CompletionItemKind.Method : vscode.CompletionItemKind.Variable)
          completion.detail = item.detail; completion.insertText = item.insertText; return completion
        }) }, '.', '$', '@', ':'),
        vscode.languages.registerHoverProvider(selector, { provideHover: async (d, p) => { const result = await request('textDocument/hover', d, { position: p }); return result ? new vscode.Hover(new vscode.MarkdownString(result.contents.value), range(result.range)) : undefined } }),
        vscode.languages.registerSignatureHelpProvider(selector, { provideSignatureHelp: async (d, p) => {
          const result = await request('textDocument/signatureHelp', d, { position: p }); if (!result) return undefined
          const help = new vscode.SignatureHelp(); help.activeSignature = result.activeSignature; help.activeParameter = result.activeParameter
          help.signatures = result.signatures.map(s => { const info = new vscode.SignatureInformation(s.label); info.parameters = s.parameters.map(p => new vscode.ParameterInformation(p.label)); return info }); return help
        } }, '(', ',', ':'),
        vscode.languages.registerDefinitionProvider(selector, { provideDefinition: async (d, p) => { const result = await request('textDocument/definition', d, { position: p }); return result ? location(result) : undefined } }),
        vscode.languages.registerReferenceProvider(selector, { provideReferences: async (d, p, requestContext) => (await request('textDocument/references', d, { position: p, context: requestContext })).map(location) }),
        vscode.languages.registerRenameProvider(selector, {
          prepareRename: async (d, p) => { const result = await request('textDocument/prepareRename', d, { position: p }); if (!result) throw new Error('No unambiguous Mün symbol here.'); return { range: range(result.range), placeholder: result.placeholder } },
          provideRenameEdits: async (d, p, newName) => { const result = await request('textDocument/rename', d, { position: p, newName }); const edit = new vscode.WorkspaceEdit(); for (const [uri, edits] of Object.entries(result.changes)) for (const e of edits) edit.replace(vscode.Uri.parse(uri), range(e.range), e.newText); return edit },
        }),
        vscode.languages.registerCodeActionsProvider(selector, { provideCodeActions: async (d, selected, actionContext) => (await request('textDocument/codeAction', d, { range: selected, context: { diagnostics: [], only: actionContext.only ? [actionContext.only.value] : undefined } })).map(action => {
          const result = new vscode.CodeAction(action.title, vscode.CodeActionKind.QuickFix)
          const edit = new vscode.WorkspaceEdit()
          for (const [uri, edits] of Object.entries(action.edit.changes)) for (const e of edits) edit.replace(vscode.Uri.parse(uri), range(e.range), e.newText)
          result.edit = edit; return result
        }) }, { providedCodeActionKinds: [vscode.CodeActionKind.QuickFix] }),
        vscode.languages.registerDocumentSymbolProvider(selector, { provideDocumentSymbols: async d => (await request('textDocument/documentSymbol', d)).map(symbol) }),
        vscode.languages.registerDocumentSemanticTokensProvider(selector, { provideDocumentSemanticTokens: async d => new vscode.SemanticTokens(new Uint32Array((await request('textDocument/semanticTokens/full', d)).data)) }, new vscode.SemanticTokensLegend(initialization.capabilities.semanticTokensProvider.legend.tokenTypes)),
        vscode.languages.registerFoldingRangeProvider(selector, { provideFoldingRanges: async d => (await request('textDocument/foldingRange', d)).map(r => new vscode.FoldingRange(r.startLine, r.endLine)) }),
        vscode.languages.registerSelectionRangeProvider(selector, { provideSelectionRanges: async (d, positions) => (await request('textDocument/selectionRange', d, { positions })).map(selection) }),
      )
      const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(folder, '**/*.mun'))
      for (const [event, type] of [['onDidCreate', 1], ['onDidChange', 2], ['onDidDelete', 3]]) context.subscriptions.push(watcher[event](uri => client.notify('workspace/didChangeWatchedFiles', { changes: [{ uri: uri.toString(), type }] })))
      context.subscriptions.push(watcher, { dispose: () => { void client.dispose() } })
    } catch (error) { output.appendLine(error.message); vscode.window.showErrorMessage(`Mün toolchain unavailable: ${error.message}`) }
  }

  const pickState = async () => {
    const activeFolder = vscode.window.activeTextEditor && vscode.workspace.getWorkspaceFolder(vscode.window.activeTextEditor.document.uri)
    if (activeFolder && folderStates.has(activeFolder.uri.toString())) return folderStates.get(activeFolder.uri.toString())
    const states = [...folderStates.values()]
    if (states.length === 1) return states[0]
    const picked = await vscode.window.showQuickPick(states.map(state => ({ label: state.folder.name ?? path.basename(state.root), state })), { placeHolder: 'Select a Mün project' })
    return picked?.state
  }

  const clearRuntimeDiagnostics = state => {
    for (const uri of state.runtimeDiagnosticUris) runtimeDiagnostics.delete(vscode.Uri.parse(uri))
    state.runtimeDiagnosticUris.clear()
  }

  const publishRuntimeDiagnostics = state => {
    clearRuntimeDiagnostics(state)
    const grouped = new Map()
    for (const diagnostic of state.snapshot?.runtimeDiagnostics ?? []) {
      if (!diagnostic.source?.file) continue
      const uri = vscode.Uri.file(path.resolve(state.root, diagnostic.source.file))
      const key = uri.toString()
      const item = new vscode.Diagnostic(sourceRange(diagnostic.source), diagnostic.message, diagnostic.severity === 'warning' ? vscode.DiagnosticSeverity.Warning : vscode.DiagnosticSeverity.Error)
      item.source = 'mun-runtime'
      const list = grouped.get(key) ?? []; list.push(item); grouped.set(key, list)
    }
    for (const [uri, items] of grouped) { runtimeDiagnostics.set(vscode.Uri.parse(uri), items); state.runtimeDiagnosticUris.add(uri) }
  }

  const refreshRuntime = async (state, showErrors = false) => {
    try {
      const snapshot = await inspectDevSession(state.root)
      const changed = snapshot.devRevision !== state.snapshot?.devRevision || snapshot.revision !== state.snapshot?.revision || snapshot.runtimeDiagnostics?.length !== state.snapshot?.runtimeDiagnostics?.length
      state.snapshot = snapshot
      state.tree = runtimeTree(snapshot)
      publishRuntimeDiagnostics(state)
      if (changed) treeProvider.refresh()
      return snapshot
    } catch (error) {
      if (showErrors) vscode.window.showErrorMessage(`Mün inspect failed: ${error.message}`)
      return undefined
    }
  }

  const stopDev = async state => {
    if (state.timer) { clearInterval(state.timer); state.timer = undefined }
    const child = state.child
    state.child = undefined
    if (child && child.exitCode === null) {
      await new Promise(resolveClose => {
        const timer = setTimeout(resolveClose, 2000)
        child.once('close', () => { clearTimeout(timer); resolveClose() })
        child.kill()
      })
    }
    state.snapshot = undefined; state.tree = undefined; clearRuntimeDiagnostics(state); treeProvider.refresh()
  }

  const startDev = async state => {
    if (!state) return
    if (state.child && state.child.exitCode === null) { vscode.window.showInformationMessage('Mün dev is already running for this project.'); return }
    if (!state.toolchain) {
      const config = vscode.workspace.getConfiguration('mun', state.folder.uri)
      state.toolchain = await discoverMunCommand({ cwd: state.root, command: config.get('server.command'), expectedVersion: version })
    }
    clearRuntimeDiagnostics(state)
    devOutput.show(true)
    devOutput.appendLine(`Starting Mün dev: ${state.root}`)
    const child = spawn(state.toolchain.command, [...state.toolchain.args, 'dev', '--project', state.root], { cwd: state.root, env: state.toolchain.env, stdio: ['ignore', 'pipe', 'pipe'] })
    state.child = child
    const append = chunk => devOutput.append(chunk.toString('utf8'))
    child.stdout.on('data', append); child.stderr.on('data', append)
    child.once('error', error => { devOutput.appendLine(`Mün dev failed: ${error.message}`); vscode.window.showErrorMessage(`Mün dev failed: ${error.message}`) })
    child.once('close', code => {
      if (state.child === child) state.child = undefined
      if (state.timer) { clearInterval(state.timer); state.timer = undefined }
      state.snapshot = undefined; state.tree = undefined; clearRuntimeDiagnostics(state); treeProvider.refresh()
      devOutput.appendLine(`Mün dev exited${code === null ? '' : ` (${code})`}.`)
    })
    const poll = () => { void refreshRuntime(state, false) }
    state.timer = setInterval(poll, 500)
    setTimeout(poll, 100)
  }

  context.subscriptions.push(
    vscode.commands.registerCommand('mun.formatDocument', () => vscode.commands.executeCommand('editor.action.formatDocument')),
    vscode.commands.registerCommand('mun.startDev', async () => { try { await startDev(await pickState()) } catch (error) { vscode.window.showErrorMessage(`Mün dev failed: ${error.message}`) } }),
    vscode.commands.registerCommand('mun.stopDev', async () => { const state = await pickState(); if (state) await stopDev(state) }),
    vscode.commands.registerCommand('mun.restartDev', async () => { const state = await pickState(); if (!state) return; await stopDev(state); await startDev(state) }),
    vscode.commands.registerCommand('mun.inspectRunningApp', async () => { const state = await pickState(); if (state) await refreshRuntime(state, true) }),
    vscode.commands.registerCommand('mun.openRuntimeSource', async (state, node) => {
      if (!node?.source?.file) return
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path.resolve(state.root, node.source.file)))
      const editor = await vscode.window.showTextDocument(document)
      const selected = sourceRange(node.source)
      editor.selection = new vscode.Selection(selected.start, selected.end)
      editor.revealRange(selected, vscode.TextEditorRevealType.InCenterIfOutsideViewport)
    }),
    { dispose: () => { for (const state of folderStates.values()) { if (state.timer) clearInterval(state.timer); if (state.child?.exitCode === null) state.child.kill() } folderStates.clear() } },
  )
}

function range(r) { return new vscode.Range(r.start.line, r.start.character, r.end.line, r.end.character) }
function sourceRange(source) { return new vscode.Range(Math.max(0, source.line - 1), Math.max(0, source.column - 1), Math.max(0, (source.endLine ?? source.line) - 1), Math.max(0, (source.endColumn ?? source.column) - 1)) }
function location(l) { return new vscode.Location(vscode.Uri.parse(l.uri), range(l.range)) }
function symbol(s) { const result = new vscode.DocumentSymbol(s.name, s.detail ?? '', s.kind === 23 ? vscode.SymbolKind.Struct : vscode.SymbolKind.Property, range(s.range), range(s.selectionRange)); result.children = (s.children ?? []).map(symbol); return result }
function selection(s) { return new vscode.SelectionRange(range(s.range), s.parent ? selection(s.parent) : undefined) }
async function deactivate() { for (const state of folderStates.values()) { if (state.timer) clearInterval(state.timer); if (state.child?.exitCode === null) state.child.kill() } folderStates.clear(); await Promise.all(clients.map(client => client.dispose())); clients = [] }
module.exports = { activate, deactivate }

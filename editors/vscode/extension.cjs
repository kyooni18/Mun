const vscode = require('vscode')
const path = require('node:path')
let clients = []

async function activate(context) {
  const { discoverToolchain } = await import('./discovery.mjs')
  const { LspClient } = await import('./client.mjs')
  const version = context.extension?.packageJSON?.version ?? require('./package.json').version
  const folders = vscode.workspace.workspaceFolders ?? []
  const diagnostics = vscode.languages.createDiagnosticCollection('mun')
  const output = vscode.window.createOutputChannel('Mün Language Server')
  context.subscriptions.push(diagnostics, output)
  for (const folder of folders.length ? folders : [{ uri: vscode.Uri.file(process.cwd()) }]) {
    const config = vscode.workspace.getConfiguration('mun', folder.uri)
    try {
      const server = await discoverToolchain({ cwd: folder.uri.fsPath, command: config.get('server.command'), expectedVersion: version })
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
        vscode.languages.registerReferenceProvider(selector, { provideReferences: async (d, p, context) => (await request('textDocument/references', d, { position: p, context })).map(location) }),
        vscode.languages.registerRenameProvider(selector, {
          prepareRename: async (d, p) => { const result = await request('textDocument/prepareRename', d, { position: p }); if (!result) throw new Error('No unambiguous Mün symbol here.'); return { range: range(result.range), placeholder: result.placeholder } },
          provideRenameEdits: async (d, p, newName) => { const result = await request('textDocument/rename', d, { position: p, newName }); const edit = new vscode.WorkspaceEdit(); for (const [uri, edits] of Object.entries(result.changes)) for (const e of edits) edit.replace(vscode.Uri.parse(uri), range(e.range), e.newText); return edit },
        }),
        vscode.languages.registerCodeActionsProvider(selector, { provideCodeActions: async (d, selected, context) => (await request('textDocument/codeAction', d, { range: selected, context: { diagnostics: [], only: context.only ? [context.only.value] : undefined } })).map(action => {
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
  context.subscriptions.push(vscode.commands.registerCommand('mun.formatDocument', () => vscode.commands.executeCommand('editor.action.formatDocument')))
}
function range(r) { return new vscode.Range(r.start.line, r.start.character, r.end.line, r.end.character) }
function location(l) { return new vscode.Location(vscode.Uri.parse(l.uri), range(l.range)) }
function symbol(s) { const result = new vscode.DocumentSymbol(s.name, s.detail ?? '', s.kind === 23 ? vscode.SymbolKind.Struct : vscode.SymbolKind.Property, range(s.range), range(s.selectionRange)); result.children = (s.children ?? []).map(symbol); return result }
function selection(s) { return new vscode.SelectionRange(range(s.range), s.parent ? selection(s.parent) : undefined) }
async function deactivate() { await Promise.all(clients.map(client => client.dispose())); clients = [] }
module.exports = { activate, deactivate }

import assert from "node:assert/strict"
import Module, { createRequire } from "node:module"
import { readFileSync } from "node:fs"
import test from "node:test"

const root = new URL("../editors/vscode/", import.meta.url)

test("VS Code extension declares Mün language, grammar, and formatter entry points", () => {
  const manifest = JSON.parse(readFileSync(new URL("package.json", root), "utf8"))
  assert.equal(manifest.main, "./extension.cjs")
  assert.deepEqual(manifest.activationEvents, ["onLanguage:mun", "onLanguage:vue"])
  assert.deepEqual(manifest.contributes.languages[0].extensions, [".mun"])
  assert.equal(manifest.contributes.grammars[0].scopeName, "source.mun")
  assert.equal(manifest.contributes.commands[0].command, "mun.formatDocument")
  const extension = readFileSync(new URL("extension.cjs", root), "utf8")
  assert.match(extension, /createDiagnosticCollection\('mun'\)/)
  assert.match(extension, /registerDocumentFormattingEditProvider\(languages/)
  assert.match(extension, /registerCompletionItemProvider/)
  assert.match(extension, /registerHoverProvider/)
  assert.match(extension, /registerSignatureHelpProvider/)
  assert.match(extension, /registerDefinitionProvider/)
  assert.match(extension, /registerRenameProvider/)
  assert.match(extension, /registerDocumentSemanticTokensProvider/)
  assert.match(extension, /enableVue/)
  const grammar = JSON.parse(readFileSync(new URL("syntaxes/mun.tmLanguage.json", root), "utf8"))
  assert.equal(grammar.patterns.some(pattern => pattern.include === "#html"), false)
})

test("VS Code providers return canonical Mün tooling results", async () => {
  const registrations = { formatting: [], completion: [], hover: [], signature: [], definition: [], rename: [], semantic: [] }
  let openDocument
  let diagnosticRuns = []
  const workspaceDocuments = []
  class Position {
    constructor(line, character) { this.line = line; this.character = character }
    translate(lineDelta = 0, characterDelta = 0) { return new Position(this.line + lineDelta, this.character + characterDelta) }
  }
  class Range { constructor(start, end) { this.start = start; this.end = end } }
  class CompletionItem { constructor(label, kind) { this.label = label; this.kind = kind } }
  class MarkdownString {
    constructor(value = "") { this.value = value }
    appendCodeblock(value, language) { this.value += "\\n```" + language + "\\n" + value + "\\n```"; return this }
  }
  class Hover { constructor(contents, range) { this.contents = contents; this.range = range } }
  class SignatureInformation { constructor(label) { this.label = label } }
  class SignatureHelp { constructor() { this.signatures = []; this.activeSignature = 0; this.activeParameter = 0 } }
  class Location { constructor(uri, range) { this.uri = uri; this.range = range } }
  class WorkspaceEdit {
    constructor() { this.edits = [] }
    replace(uri, range, newText) { this.edits.push({ uri, range, newText }) }
  }
  class SemanticTokensLegend { constructor(tokenTypes) { this.tokenTypes = tokenTypes } }
  class SemanticTokensBuilder {
    constructor(legend) { this.legend = legend; this.tokens = [] }
    push(line, character, length, tokenType) { this.tokens.push({ line, character, length, tokenType }) }
    build() { return { tokens: this.tokens } }
  }
  const vscode = {
    Position,
    Range,
    CompletionItem,
    CompletionItemKind: { Property: 1, Value: 2, Function: 3, Keyword: 4 },
    MarkdownString,
    Hover,
    SignatureInformation,
    SignatureHelp,
    Location,
    WorkspaceEdit,
    SemanticTokensLegend,
    SemanticTokensBuilder,
    TextEdit: { replace: (range, newText) => ({ range, newText }) },
    Diagnostic: class Diagnostic { constructor(range, message, severity) { this.range = range; this.message = message; this.severity = severity } },
    DiagnosticSeverity: { Error: 0, Warning: 1 },
    languages: {
      createDiagnosticCollection: () => ({ set(uri, diagnostics) { diagnosticRuns.push({ uri, diagnostics }) }, dispose() {} }),
      registerDocumentFormattingEditProvider: (_language, provider) => { registrations.formatting.push(provider); return { dispose() {} } },
      registerCompletionItemProvider: (_language, provider) => { registrations.completion.push(provider); return { dispose() {} } },
      registerHoverProvider: (_language, provider) => { registrations.hover.push(provider); return { dispose() {} } },
      registerSignatureHelpProvider: (_language, provider) => { registrations.signature.push(provider); return { dispose() {} } },
      registerDefinitionProvider: (_language, provider) => { registrations.definition.push(provider); return { dispose() {} } },
      registerRenameProvider: (_language, provider) => { registrations.rename.push(provider); return { dispose() {} } },
      registerDocumentSemanticTokensProvider: (_language, provider, legend) => { registrations.semantic.push({ provider, legend }); return { dispose() {} } },
    },
    workspace: {
      textDocuments: workspaceDocuments,
      onDidOpenTextDocument: handler => { openDocument = handler; return { dispose() {} } },
      onDidChangeTextDocument: () => ({ dispose() {} }),
      getConfiguration: () => ({ get: (_key, fallback) => fallback }),
    },
    commands: { registerCommand: () => ({ dispose() {} }), executeCommand: () => undefined },
  }
  const require = createRequire(import.meta.url)
  const extensionPath = require.resolve("../editors/vscode/extension.cjs")
  const originalLoad = Module._load
  try {
    Module._load = function load(request, parent, isMain) {
      if (request === "vscode") return vscode
      return originalLoad.call(this, request, parent, isMain)
    }
    delete require.cache[extensionPath]
    const extension = require(extensionPath)
    const context = { subscriptions: [] }
    extension.activate(context)
    const lines = ["const local = true", "VStack()", "Text(\"Card\")", "Card()", "// Card must not be renamed"]
    const source = lines.join("\n")
    const document = {
      uri: "file:///Card.mun",
      languageId: "mun",
      lineCount: lines.length,
      lineAt: line => ({ text: lines[line] }),
      getText: () => source,
      offsetAt(position) {
        return source.split("\n").slice(0, position.line).reduce((total, line) => total + line.length + 1, 0) + position.character
      },
      positionAt(offset) {
        const before = source.slice(0, offset)
        const split = before.split("\n")
        return new Position(split.length - 1, split.at(-1).length)
      },
    }
    const declarationSource = "struct Card: View { init(title: string) { self.title = title } }"
    const declarationDocument = {
      ...document,
      uri: "file:///CardDefinition.mun",
      lineCount: 1,
      lineAt: () => ({ text: declarationSource }),
      getText: () => declarationSource,
      positionAt: offset => new Position(0, offset),
    }
    workspaceDocuments.push(document, declarationDocument)
    const munPosition = new Position(1, 3)
    const completionProvider = registrations.completion[0]
    const viewCompletions = completionProvider.provideCompletionItems(document, munPosition)
    assert.ok(viewCompletions.some(item => item.label === "VStack"))
    const buttonCompletion = viewCompletions.find(item => item.label === "Button")
    assert.equal(buttonCompletion?.detail, "Button(_ title: string, @Action action) | Button(action: @Action, @ViewBuilder label)")
    assert.doesNotMatch(buttonCompletion?.detail ?? "", /Button\(@Action action\)/)
    assert.match(viewCompletions.find(item => item.label === "Card")?.detail ?? "", /Card\(title: string\)/)
    const hoverResult = registrations.hover[0].provideHover(document, munPosition)
    assert.match(hoverResult.contents.value, /VStack/)
    const signatureResult = registrations.signature[0].provideSignatureHelp(document, new Position(1, 7))
    assert.ok(signatureResult.signatures.some(item => /ViewBuilder/.test(item.label)))
    const customSignature = registrations.signature[0].provideSignatureHelp(document, new Position(3, 5))
    assert.equal(customSignature.signatures[0].label, "Card(title: string)")
    const definitionResult = await registrations.definition[0].provideDefinition(document, new Position(3, 2))
    assert.equal(definitionResult.uri, declarationDocument.uri)
    assert.equal(definitionResult.range.start.line, 0)
    const renameResult = await registrations.rename[0].provideRenameEdits(document, new Position(3, 2), "Panel")
    assert.equal(renameResult.edits.length, 2)
    assert.equal(await registrations.rename[0].provideRenameEdits(document, new Position(3, 2), "not-valid!") , undefined)
    const vueUsageSource = "<template><Card /></template>"
    const vueUsageDocument = {
      ...document,
      uri: "file:///CardUsage.vue",
      languageId: "vue",
      lineCount: 1,
      lineAt: () => ({ text: vueUsageSource }),
      getText: () => vueUsageSource,
      positionAt: offset => new Position(0, offset),
    }
    workspaceDocuments.push(vueUsageDocument)
    const vueDefinition = await registrations.definition[0].provideDefinition(vueUsageDocument, new Position(0, 14))
    assert.equal(vueDefinition.uri, declarationDocument.uri)
    const workspaceRename = await registrations.rename[0].provideRenameEdits(vueUsageDocument, new Position(0, 14), "Panel")
    assert.equal(workspaceRename.edits.length, 3)
    const semanticResult = registrations.semantic[0].provider.provideDocumentSemanticTokens(document)
    assert.ok(semanticResult.tokens.some(token => token.tokenType === "function" && token.line === 1))
    const declarationTokens = registrations.semantic[0].provider.provideDocumentSemanticTokens(declarationDocument)
    assert.ok(declarationTokens.tokens.some(token => token.tokenType === "class" && token.line === 0))

    const lexicalLines = [
      "const pattern = /[{}]/g",
      "const value = `nested ${format({ ready: true })}`",
      "// unmatched } is comment trivia",
      "/* unmatched { is also trivia */",
    ]
    const lexicalSource = lexicalLines.join("\n")
    const lexicalDocument = {
      ...document,
      uri: "file:///Lexical.mun",
      lineCount: lexicalLines.length,
      lineAt: line => ({ text: lexicalLines[line] }),
      getText: () => lexicalSource,
      positionAt(offset) {
        const split = lexicalSource.slice(0, offset).split("\n")
        return new Position(split.length - 1, split.at(-1).length)
      },
    }
    openDocument(lexicalDocument)
    assert.equal(diagnosticRuns.at(-1).diagnostics.length, 0)

    const malformedSource = "Text('ok')\n/* unfinished"
    const malformedDocument = {
      ...document,
      uri: "file:///Malformed.mun",
      lineCount: 2,
      lineAt: line => ({ text: malformedSource.split("\n")[line] }),
      getText: () => malformedSource,
      positionAt(offset) {
        const split = malformedSource.slice(0, offset).split("\n")
        return new Position(split.length - 1, split.at(-1).length)
      },
    }
    openDocument(malformedDocument)
    const malformedDiagnostic = diagnosticRuns.at(-1).diagnostics[0]
    assert.match(malformedDiagnostic.message, /Unclosed block comment/)
    assert.equal(malformedDiagnostic.range.start.line, 1)
    assert.equal(malformedDiagnostic.range.start.character, 0)


    const vueSource = `<template><div :class="{ active: enabled"></div></template>\n<script setup>\nconst count=State(0)\nif(count.value){\nText('ready')\n}\n</script>`
    const vueDocument = {
      uri: "file:///Counter.vue",
      languageId: "vue",
      lineCount: vueSource.split("\\n").length,
      lineAt: line => ({ text: vueSource.split("\\n")[line] }),
      getText: () => vueSource,
      positionAt(offset) {
        const before = vueSource.slice(0, offset)
        const split = before.split("\\n")
        return new Position(split.length - 1, split.at(-1).length)
      },
    }
    const vueEdits = registrations.formatting[0].provideDocumentFormattingEdits(vueDocument)
    assert.equal(vueEdits.length, 1)
    assert.match(vueEdits[0].newText, /const count=State\(0\)/)
    assert.doesNotMatch(vueEdits[0].newText, /template/)
    openDocument(vueDocument)
    assert.equal(diagnosticRuns.at(-1).uri, vueDocument.uri)
    assert.equal(diagnosticRuns.at(-1).diagnostics.length, 0)
  } finally {
    Module._load = originalLoad
    delete require.cache[extensionPath]
  }
})

test("VS Code semantic diagnostics render Mun warnings as warnings", () => {
  const source = readFileSync(new URL("extension.cjs", root), "utf8")
  assert.match(source, /diagnostic\.severity === 'warning' \? vscode\.DiagnosticSeverity\.Warning/)
})

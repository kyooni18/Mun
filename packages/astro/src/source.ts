import * as ts from "typescript"
import * as Core from "@mun/core/compat"
import {
  analyzeMunSource,
  assertCanonicalMunSource,
  createMunSourceMap,
  parseMunBuilder,
  transformMunSource,
  type MunSourceMap,
} from "@mun/compiler"

const PUBLIC_VIRTUAL_PREFIX = "virtual:mun-astro:"
const RESOLVED_VIRTUAL_PREFIX = "\0virtual:mun-astro:"
const rawElementNames = new Set(["script", "style", "pre", "code", "textarea"])
const identifierPattern = /^[A-Za-z_$][A-Za-z0-9_$]*/

export type MunAstroClientDirective = "load" | "idle" | "visible" | "media" | "only"

interface HydrationPolicy {
  readonly directive?: MunAstroClientDirective
  readonly media?: string
}

interface ImportBinding {
  readonly local: string
  readonly imported?: string
  readonly module: string
  readonly kind: "default" | "named" | "namespace"
}

interface FrontmatterBinding {
  readonly name: string
  readonly definitelyNonSerializable: boolean
}

export interface MunAstroEmbeddedBlock {
  readonly id: string
  readonly publicId: string
  readonly resolvedId: string
  readonly fileName: string
  readonly name?: string
  readonly body: string
  readonly setup: string
  readonly root: string
  readonly props: readonly string[]
  readonly imports: readonly ImportBinding[]
  readonly builtins: readonly string[]
  readonly interactive: boolean
  readonly hydration: HydrationPolicy
  readonly start: number
  readonly sourceLineOffset: number
  readonly end: number
}

export interface MunAstroSourceTransform {
  readonly code: string
  readonly blocks: readonly MunAstroEmbeddedBlock[]
}

interface FrontmatterInfo {
  readonly code: string
  readonly contentStart: number
  readonly contentEnd: number
  readonly closeEnd: number
}

function syntaxError(message: string, fileName: string, offset: number): SyntaxError & { readonly offset: number } {
  const error = new SyntaxError(`${message} (${fileName})`) as SyntaxError & { offset: number }
  error.offset = offset
  return error
}

function skipQuoted(source: string, index: number): number {
  const quote = source[index]
  for (let cursor = index + 1; cursor < source.length; cursor += 1) {
    if (source[cursor] === "\\") {
      cursor += 1
      continue
    }
    if (source[cursor] === quote) return cursor + 1
  }
  return source.length
}

function skipLineComment(source: string, index: number): number {
  const end = source.indexOf("\n", index + 2)
  return end < 0 ? source.length : end + 1
}

function skipBlockComment(source: string, index: number): number {
  const end = source.indexOf("*/", index + 2)
  return end < 0 ? source.length : end + 2
}

const regexAfterKeywords = new Set([
  "case", "delete", "do", "else", "in", "instanceof", "of", "return", "throw", "typeof", "void", "yield", "await",
])

function regexCanStart(source: string, index: number): boolean {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (/\s/.test(source[cursor])) continue
    if ("([{=,:;!?&|+-*%^~<>".includes(source[cursor])) return true
    if (/[A-Za-z_$]/.test(source[cursor])) {
      const end = cursor + 1
      while (cursor >= 0 && /[A-Za-z0-9_$]/.test(source[cursor])) cursor -= 1
      return regexAfterKeywords.has(source.slice(cursor + 1, end))
    }
    return false
  }
  return true
}

function skipRegex(source: string, index: number): number {
  let inClass = false
  for (let cursor = index + 1; cursor < source.length; cursor += 1) {
    if (source[cursor] === "\\") {
      cursor += 1
      continue
    }
    if (source[cursor] === "[") inClass = true
    else if (source[cursor] === "]") inClass = false
    else if (source[cursor] === "/" && !inClass) {
      cursor += 1
      while (/[A-Za-z]/.test(source[cursor] ?? "")) cursor += 1
      return cursor
    }
    if (source[cursor] === "\n" || source[cursor] === "\r") return index + 1
  }
  return index + 1
}

function skipTemplate(source: string, index: number): number {
  for (let cursor = index + 1; cursor < source.length; cursor += 1) {
    if (source[cursor] === "\\") {
      cursor += 1
      continue
    }
    if (source[cursor] === "`") return cursor + 1
    if (source[cursor] === "$" && source[cursor + 1] === "{") {
      cursor = matching(source, cursor + 1, "{", "}")
    }
  }
  return source.length
}

function matching(source: string, open: number, left: string, right: string): number {
  let depth = 0
  for (let cursor = open; cursor < source.length; cursor += 1) {
    const character = source[cursor]
    if (character === "\"" || character === "'") {
      cursor = skipQuoted(source, cursor) - 1
      continue
    }
    if (character === "`") {
      cursor = skipTemplate(source, cursor) - 1
      continue
    }
    if (source.startsWith("//", cursor)) {
      cursor = skipLineComment(source, cursor) - 1
      continue
    }
    if (source.startsWith("/*", cursor)) {
      cursor = skipBlockComment(source, cursor) - 1
      continue
    }
    if (character === "/" && regexCanStart(source, cursor)) {
      cursor = skipRegex(source, cursor) - 1
      continue
    }
    if (character === left) depth += 1
    else if (character === right && --depth === 0) return cursor
  }
  return -1
}

function skipWhitespace(source: string, index: number): number {
  let cursor = index
  while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1
  return cursor
}

function readIdentifier(source: string, index: number): { readonly value: string; readonly end: number } | undefined {
  const match = identifierPattern.exec(source.slice(index))
  if (!match) return undefined
  return { value: match[0], end: index + match[0].length }
}


function collectBindingName(name: ts.BindingName, result: string[]): void {
  if (ts.isIdentifier(name)) {
    result.push(name.text)
    return
  }
  for (const element of name.elements) {
    if (!ts.isOmittedExpression(element)) collectBindingName(element.name, result)
  }
}


function parseFrontmatter(source: string): FrontmatterInfo | undefined {
  const bom = source.charCodeAt(0) === 0xfeff ? 1 : 0
  if (!source.startsWith("---", bom)) return undefined
  const openingEnd = source.indexOf("\n", bom + 3)
  if (openingEnd < 0) return undefined
  const contentStart = openingEnd + 1
  let lineStart = contentStart
  while (lineStart < source.length) {
    const lineEnd = source.indexOf("\n", lineStart)
    const end = lineEnd < 0 ? source.length : lineEnd
    let line = source.slice(lineStart, end)
    if (line.endsWith("\r")) line = line.slice(0, -1)
    if (line.trim() === "---") {
      return {
        code: source.slice(contentStart, lineStart),
        contentStart,
        contentEnd: lineStart,
        closeEnd: lineEnd < 0 ? end : lineEnd + 1,
      }
    }
    if (lineEnd < 0) break
    lineStart = lineEnd + 1
  }
  return undefined
}


function frontmatterSymbols(frontmatter: FrontmatterInfo | undefined, fileName: string) {
  const imports = new Map<string, ImportBinding>()
  const bindings = new Map<string, FrontmatterBinding>()
  if (!frontmatter) return { imports, bindings }
  const file = ts.createSourceFile(fileName + ".frontmatter.ts", frontmatter.code, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)

  for (const statement of file.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const module = statement.moduleSpecifier.text
      const clause = statement.importClause
      if (!clause || clause.isTypeOnly) continue
      if (clause.name) imports.set(clause.name.text, { local: clause.name.text, module, kind: "default" })
      const named = clause.namedBindings
      if (named && ts.isNamespaceImport(named)) {
        imports.set(named.name.text, { local: named.name.text, module, kind: "namespace" })
      } else if (named && ts.isNamedImports(named)) {
        for (const element of named.elements) {
          if (element.isTypeOnly) continue
          imports.set(element.name.text, {
            local: element.name.text,
            imported: element.propertyName?.text ?? element.name.text,
            module,
            kind: "named",
          })
        }
      }
      continue
    }

    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        const names: string[] = []
        collectBindingName(declaration.name, names)
        const initializer = declaration.initializer
        const definitelyNonSerializable = Boolean(
          initializer
          && (ts.isArrowFunction(initializer) || ts.isFunctionExpression(initializer) || ts.isClassExpression(initializer)),
        )
        for (const name of names) bindings.set(name, { name, definitelyNonSerializable })
      }
      continue
    }
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      bindings.set(statement.name.text, { name: statement.name.text, definitelyNonSerializable: true })
    } else if (ts.isClassDeclaration(statement) && statement.name) {
      bindings.set(statement.name.text, { name: statement.name.text, definitelyNonSerializable: true })
    } else if (ts.isEnumDeclaration(statement)) {
      bindings.set(statement.name.text, { name: statement.name.text, definitelyNonSerializable: false })
    }
  }
  return { imports, bindings }
}


function collectUsedIdentifiers(source: string, fileName: string): Set<string> {
  const generated = transformMunSource(source, fileName + ".embedded.mun")
  const file = ts.createSourceFile(fileName + ".embedded.ts", generated, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const used = new Set<string>()
  const declared = new Set<string>()

  const declare = (name: ts.BindingName): void => {
    const names: string[] = []
    collectBindingName(name, names)
    for (const item of names) declared.add(item)
  }

  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) declare(node.name)
    else if (ts.isParameter(node)) declare(node.name)
    else if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isEnumDeclaration(node)) && node.name) declared.add(node.name.text)
    else if (ts.isImportClause(node) && node.name) declared.add(node.name.text)
    else if (ts.isNamespaceImport(node)) declared.add(node.name.text)
    else if (ts.isImportSpecifier(node)) declared.add(node.name.text)

    if (ts.isIdentifier(node)) {
      const parent = node.parent
      const memberName = ts.isPropertyAccessExpression(parent) && parent.name === node
      const propertyName =
        (ts.isPropertyAssignment(parent) && parent.name === node && !ts.isShorthandPropertyAssignment(parent))
        || (ts.isPropertyDeclaration(parent) && parent.name === node)
        || (ts.isPropertySignature(parent) && parent.name === node)
        || (ts.isMethodDeclaration(parent) && parent.name === node)
      const declarationName =
        (ts.isVariableDeclaration(parent) && parent.name === node)
        || (ts.isParameter(parent) && parent.name === node)
        || ((ts.isFunctionDeclaration(parent) || ts.isClassDeclaration(parent) || ts.isEnumDeclaration(parent)) && parent.name === node)
        || (ts.isImportClause(parent) && parent.name === node)
        || (ts.isNamespaceImport(parent) && parent.name === node)
        || (ts.isImportSpecifier(parent) && parent.name === node)
      if (!memberName && !propertyName && !declarationName) used.add(node.text)
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  for (const item of declared) used.delete(item)
  return used
}


function parseHydrationOptions(source: string, fileName: string, offset: number): HydrationPolicy {
  const text = source.trim()
  if (!text) return {}
  const match = /^client\s*:\s*(load|idle|visible|only)$/.exec(text)
  if (match) return { directive: match[1] as MunAstroClientDirective }
  const media = /^client\s*:\s*media\s*\(\s*(["'])(.*?)\1\s*\)$/.exec(text)
  if (media) return { directive: "media", media: media[2] }
  throw syntaxError("Unsupported @mun client option", fileName, offset)
}

function hydrationAttribute(policy: HydrationPolicy): string {
  if (!policy.directive) return ""
  if (policy.directive === "media") return ` client:media=${JSON.stringify(policy.media ?? "")}`
  if (policy.directive === "only") return ' client:only="@mun/astro"'
  return ` client:${policy.directive}`
}


function skipTag(source: string, index: number): number {
  for (let cursor = index + 1; cursor < source.length; cursor += 1) {
    const character = source[cursor]
    if (character === "\"" || character === "'") {
      cursor = skipQuoted(source, cursor) - 1
      continue
    }
    if (character === ">") return cursor + 1
  }
  return source.length
}

function skipMarkup(source: string, index: number): number {
  if (source.startsWith("<!--", index)) {
    const end = source.indexOf("-->", index + 4)
    return end < 0 ? source.length : end + 3
  }
  const tag = /^<([A-Za-z][A-Za-z0-9:_-]*)\b/.exec(source.slice(index))
  if (!tag) return skipTag(source, index)
  const openEnd = skipTag(source, index)
  if (!rawElementNames.has(tag[1].toLowerCase())) return openEnd
  const lower = source.toLowerCase()
  const closing = lower.indexOf("</" + tag[1].toLowerCase(), openEnd)
  return closing < 0 ? source.length : skipTag(source, closing)
}

function stableHash(value: string): string {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(36)
}


function makeEmbeddedBlock(
  body: string,
  fileName: string,
  name: string | undefined,
  ordinal: number,
  start: number,
  end: number,
  sourceLineOffset: number,
  requestedHydration: HydrationPolicy,
  symbols: ReturnType<typeof frontmatterSymbols>,
): MunAstroEmbeddedBlock {
  assertCanonicalMunSource(body, fileName + ".embedded.mun")
  const program = parseMunBuilder(body)
  if (program.statements.length === 0) {
    throw syntaxError("@mun must contain a root Mün View expression", fileName, start)
  }

  const rootNode = program.statements[program.statements.length - 1]
  const setup = body.slice(0, rootNode.range.start)
  const root = body.slice(rootNode.range.start, rootNode.range.end)
  if (setup.trim().length > 0) {
    const setupFile = ts.createSourceFile(fileName + ".embedded.setup.ts", setup, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    for (const statement of setupFile.statements) {
      const declaration =
        ts.isVariableStatement(statement)
        || ts.isFunctionDeclaration(statement)
        || ts.isClassDeclaration(statement)
        || ts.isInterfaceDeclaration(statement)
        || ts.isTypeAliasDeclaration(statement)
        || ts.isEnumDeclaration(statement)
        || ts.isEmptyStatement(statement)
      if (!declaration) {
        throw syntaxError("Only local declarations may precede the root View in @mun", fileName, start + rootNode.range.start)
      }
    }
  }

  const analysis = analyzeMunSource(body, fileName + ".embedded.mun")
  const used = collectUsedIdentifiers(body, fileName)
  const props = [...symbols.bindings.keys()].filter(item => used.has(item))
  const imports = [...symbols.imports.values()].filter(item => used.has(item.local))

  const importedNames = new Set(imports.map(item => item.local))
  const propNames = new Set(props)
  const builtins = Object.keys(Core).filter(item => used.has(item) && !importedNames.has(item) && !propNames.has(item))
  const hydration = requestedHydration.directive
    ? requestedHydration
    : analysis.interactive
      ? { directive: "load" as const }
      : {}

  if (hydration.directive) {
    for (const binding of imports) {
      if (binding.module.startsWith("node:") || /(?:^|[/.-])server(?:[/.-]|$)/i.test(binding.module)) {
        throw syntaxError("Interactive @mun cannot import a server-only module: " + binding.module, fileName, start)
      }
    }
  }

  if (hydration.directive) {
    for (const prop of props) {
      if (symbols.bindings.get(prop)?.definitelyNonSerializable) {
        throw syntaxError("Interactive @mun cannot capture a server-only function or class: " + prop, fileName, start)
      }
    }
  }


  const key = name ?? ("block-" + ordinal)
  const id = encodeURIComponent(fileName) + ":" + key + ".mun"

  return {
    id,
    publicId: PUBLIC_VIRTUAL_PREFIX + id,
    resolvedId: RESOLVED_VIRTUAL_PREFIX + id,
    fileName,
    name,
    body,
    setup,
    root,
    props,
    imports,
    builtins,
    interactive: analysis.interactive,
    hydration,
    sourceLineOffset,
    start,
    end,
  }
}


interface SourceRewrite {
  readonly start: number
  readonly end: number
  readonly text: string
}

export function transformAstroMunSource(source: string, fileName: string): MunAstroSourceTransform {
  const frontmatter = parseFrontmatter(source)
  const symbols = frontmatterSymbols(frontmatter, fileName)
  const blocks: MunAstroEmbeddedBlock[] = []
  const rewrites: SourceRewrite[] = []
  const imports: string[] = []
  const names = new Set<string>()
  let cursor = frontmatter?.closeEnd ?? 0
  let ordinal = 0


  while (cursor < source.length) {
    if (source[cursor] === "<") {
      cursor = skipMarkup(source, cursor)
      continue
    }
    if (source[cursor] === "{") {
      const close = matching(source, cursor, "{", "}")
      cursor = close < 0 ? source.length : close + 1
      continue
    }

    if (!source.startsWith("@mun", cursor)) {
      cursor += 1
      continue
    }

    const previous = source[cursor - 1]
    const next = source[cursor + 4]
    if ((previous && /[A-Za-z0-9_$]/.test(previous)) || (next && /[A-Za-z0-9_$]/.test(next))) {
      cursor += 4
      continue
    }
    const blockStart = cursor
    cursor = skipWhitespace(source, cursor + 4)
    let name: string | undefined


    if (source[cursor] !== "(" && source[cursor] !== "{") {
      const identifier = readIdentifier(source, cursor)
      if (!identifier) throw syntaxError("Expected @mun block name or body", fileName, cursor)
      name = identifier.value
      if (names.has(name)) throw syntaxError("Duplicate named @mun block: " + name, fileName, cursor)
      names.add(name)
      cursor = skipWhitespace(source, identifier.end)
    }

    let requestedHydration: HydrationPolicy = {}
    if (source[cursor] === "(") {
      const close = matching(source, cursor, "(", ")")
      if (close < 0) throw syntaxError("Unclosed @mun option list", fileName, cursor)
      requestedHydration = parseHydrationOptions(source.slice(cursor + 1, close), fileName, cursor)
      cursor = skipWhitespace(source, close + 1)
    }
    if (source[cursor] !== "{") throw syntaxError("Expected { after @mun", fileName, cursor)


    const bodyClose = matching(source, cursor, "{", "}")
    if (bodyClose < 0) throw syntaxError("Unclosed @mun body", fileName, cursor)
    const body = source.slice(cursor + 1, bodyClose)
    const sourceLineOffset = source.slice(0, cursor + 1).split("\n").length - 1
    const block = makeEmbeddedBlock(
      body,
      fileName,
      name,
      ordinal,
      blockStart,
      bodyClose + 1,
      sourceLineOffset,
      requestedHydration,
      symbols,
    )
    const componentName = "MunAstro_" + stableHash(fileName + ":" + (name ?? ordinal))
    const props = block.props.map(prop => " " + prop + "={" + prop + "}").join("")
    rewrites.push({
      start: blockStart,
      end: bodyClose + 1,
      text: "<" + componentName + props + hydrationAttribute(block.hydration) + " />",
    })
    imports.push("import " + componentName + " from " + JSON.stringify(block.publicId) + ";")
    blocks.push(block)
    ordinal += 1
    cursor = bodyClose + 1
  }


  if (blocks.length === 0) return { code: source, blocks }
  let code = source
  for (const rewrite of [...rewrites].sort((left, right) => right.start - left.start)) {
    code = code.slice(0, rewrite.start) + rewrite.text + code.slice(rewrite.end)
  }


  const importText = imports.join("\n")
  if (frontmatter) {
    code = code.slice(0, frontmatter.contentEnd) + importText + "\n" + code.slice(frontmatter.contentEnd)
  } else {
    code = "---\n" + importText + "\n---\n" + code
  }
  return { code, blocks }
}


function importStatement(binding: ImportBinding): string {
  const module = JSON.stringify(binding.module)
  if (binding.kind === "default") return "import " + binding.local + " from " + module + ";"
  if (binding.kind === "namespace") return "import * as " + binding.local + " from " + module + ";"
  const imported = binding.imported ?? binding.local
  const specifier = imported === binding.local ? imported : imported + " as " + binding.local
  return "import { " + specifier + " } from " + module + ";"
}


export function generateVirtualMunModule(block: MunAstroEmbeddedBlock): string {
  const lines: string[] = []
  if (block.builtins.length > 0) {
    lines.push("import { " + block.builtins.join(", ") + ' } from "@mun/core/compat";')
  }
  for (const binding of block.imports) lines.push(importStatement(binding))
  lines.push("const __MunAstroComponent = (__props) => {")
  if (block.props.length > 0) lines.push("  const { " + block.props.join(", ") + " } = __props")
  if (block.setup.trim().length > 0) lines.push(block.setup.trimEnd())
  lines.push("  return " + block.root.trim())
  lines.push("}")
  lines.push('Object.defineProperty(__MunAstroComponent, "__munComponent", { value: true })')
  lines.push("export default __MunAstroComponent")
  return lines.join("\n")
}


interface ResolveContext {
  resolve(source: string, importer?: string, options?: { readonly skipSelf?: boolean }): Promise<unknown>
}

interface HotUpdateContext {
  readonly file: string
  readonly modules: readonly unknown[]
  readonly server: {
    readonly moduleGraph: {
      getModuleById(id: string): unknown
      invalidateModule(module: unknown): void
    }
  }
}


export interface MunAstroSourcePlugin {
  readonly name: "mun:astro-source"
  readonly enforce: "pre"
  readonly resolveId: (this: ResolveContext, source: string, importer?: string) => Promise<unknown>
  readonly load: (id: string) => { readonly code: string; readonly map: MunSourceMap } | null
  readonly handleHotUpdate: (context: HotUpdateContext) => readonly unknown[]
}

export function createMunAstroSourcePlugin(): MunAstroSourcePlugin {
  const virtualBlocks = new Map<string, MunAstroEmbeddedBlock>()
  const fileVirtualIds = new Map<string, Set<string>>()

  const clearFile = (fileName: string): void => {
    const ids = fileVirtualIds.get(fileName)
    if (!ids) return
    for (const id of ids) virtualBlocks.delete(id)
    fileVirtualIds.delete(fileName)
  }


  return {
    name: "mun:astro-source",
    enforce: "pre" as const,

    async resolveId(this: ResolveContext, source: string, importer?: string) {
      if (source.startsWith(PUBLIC_VIRTUAL_PREFIX)) {
        return RESOLVED_VIRTUAL_PREFIX + source.slice(PUBLIC_VIRTUAL_PREFIX.length)
      }
      if (importer?.startsWith(RESOLVED_VIRTUAL_PREFIX) && source.startsWith(".")) {
        const block = virtualBlocks.get(importer)
        if (block) return this.resolve(source, block.fileName, { skipSelf: true })
      }
      return null
    },


    load(id: string) {
      const virtual = virtualBlocks.get(id)
      if (virtual) {
        const code = generateVirtualMunModule(virtual)
        const original = "\n".repeat(virtual.sourceLineOffset) + virtual.body
        return { code, map: createMunSourceMap(original, code, virtual.fileName) }
      }

      const fileName = id.split("?", 1)[0]
      if (!fileName.endsWith(".astro")) return null
      const source = ts.sys.readFile(fileName)
      if (source === undefined) return null

      if (!source.includes("@mun")) {
        clearFile(fileName)
        return null
      }

      const transformed = transformAstroMunSource(source, fileName)
      clearFile(fileName)
      if (transformed.blocks.length === 0) return null

      const ids = new Set<string>()
      for (const block of transformed.blocks) {
        virtualBlocks.set(block.resolvedId, block)
        ids.add(block.resolvedId)
      }
      fileVirtualIds.set(fileName, ids)

      return {
        code: transformed.code,
        map: createMunSourceMap(source, transformed.code, fileName),
      }
    },


    handleHotUpdate(context: HotUpdateContext) {
      if (!context.file.endsWith(".astro")) return context.modules
      const ids = fileVirtualIds.get(context.file)
      if (!ids) return context.modules

      const modules = [...context.modules]
      for (const id of ids) {
        const module = context.server.moduleGraph.getModuleById(id)
        if (!module) continue
        context.server.moduleGraph.invalidateModule(module)
        if (!modules.includes(module)) modules.push(module)
      }
      return modules
    },
  }
}

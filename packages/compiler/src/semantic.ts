import * as ts from "typescript"
import * as Core from "@mun/core/compat"
import {
  SemanticModel,
  resolveSemanticCall,
  type SemanticBuilderTypeSymbol,
  type SemanticForeignComponentTypeSymbol,
  type SemanticInitializerParameter,
  type SemanticInitializerSymbol,
  type SemanticArgument,
  type SemanticCallResolution,
  type SemanticStateSymbol,
  type SemanticSymbol,
  type SemanticViewTypeSymbol,
} from "@mun/core/compat"
import {
  parseMunBuilder,
  parseMunStructs,
  type MunBuilderNode,
  type MunBuilderProgram,
  type MunStructDeclaration,
  type MunSourceRange,
} from "./ast.js"
import { createMunSourceMap, mapGeneratedPosition, type MunSourcePosition } from "./source-map.js"

export interface MunSemanticInitializer {
  readonly index: number
  readonly signature: string
  readonly parametersSource: string
  readonly parameters: readonly SemanticInitializerParameter[]
  readonly symbol: SemanticInitializerSymbol
  readonly range: MunSourceRange
  readonly synthesized?: "memberwise"
}

export interface MunSemanticField {
  readonly name: string
  readonly kind: MunStructDeclaration["fields"][number]["kind"]
  readonly type?: string
  readonly initializer?: string
  readonly range: MunSourceRange
}

export interface MunSemanticView {
  readonly name: string
  readonly qualifiedName: string
  readonly genericParameters?: string
  readonly fields: readonly MunSemanticField[]
  readonly initializers: readonly MunSemanticInitializer[]
  readonly symbol: SemanticViewTypeSymbol
  readonly bodyRange: MunSourceRange
  readonly range: MunSourceRange
}

export interface MunSemanticCall {
  readonly callee: string
  /** Qualified lexical View scope that owns this builder call, when any. */
  readonly scope?: string
  readonly arguments: readonly {
    readonly label?: string
    readonly kind: "expression" | "closure"
    readonly source: string
    readonly range: MunSourceRange
  }[]
  readonly trailingClosure: boolean
  readonly range: MunSourceRange
  /** The shared semantic answer consumed by compiler and IDE clients. */
  readonly resolution: SemanticCallResolution
}

export interface MunSemanticImport {
  readonly module: string
  readonly range: MunSourceRange
}


export interface MunSemanticForeignComponent {
  readonly localName: string
  readonly module: string
  /** Range mapped back to the original Mün source. */
  readonly range: MunSourceRange
  readonly generatedRange: MunSourceRange
  readonly symbol: SemanticForeignComponentTypeSymbol
}

/**
 * Shared compiler/editor view of a Mun file.
 *
 * Mun-only declarations and builder blocks stay in the Mun AST. Normal
 * imports, expressions, types, and diagnostics are represented by the
 * TypeScript SourceFile produced from the lowered snapshot.
 */
export interface MunSemanticModel {
  readonly kind: "MunSemanticModel"
  readonly fileName: string
  readonly source: string
  readonly generatedSource: string
  readonly typescript: ts.SourceFile
  readonly typeChecker: ts.TypeChecker
  readonly typescriptDiagnostics: readonly ts.Diagnostic[]
  readonly structs: readonly MunStructDeclaration[]
  readonly views: readonly MunSemanticView[]
  readonly builderPrograms: readonly MunBuilderProgram[]
  readonly calls: readonly MunSemanticCall[]
  readonly imports: readonly MunSemanticImport[]
  readonly foreignComponents: readonly MunSemanticForeignComponent[]
  /** Canonical symbol table shared with runtime ViewType metadata. */
  readonly symbolTable: SemanticModel
  readonly symbols: readonly SemanticSymbol[]
  view(name: string): MunSemanticView | undefined
  symbol(name: string): SemanticSymbol | undefined
}

function splitParameterSource(source: string): readonly string[] {
  const parts: string[] = []
  let start = 0
  let angle = 0
  let square = 0
  let parens = 0
  let braces = 0
  let quote: string | undefined
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if (quote) {
      if (character === "\\") { index += 1; continue }
      if (character === quote) quote = undefined
      continue
    }
    if (character === "\"" || character === "'" || character === "`") { quote = character; continue }
    if (character === "<") angle += 1
    else if (character === ">") angle = Math.max(0, angle - 1)
    else if (character === "[") square += 1
    else if (character === "]") square = Math.max(0, square - 1)
    else if (character === "(") parens += 1
    else if (character === ")") parens = Math.max(0, parens - 1)
    else if (character === "{") braces += 1
    else if (character === "}") braces = Math.max(0, braces - 1)
    else if (character === "," && angle === 0 && square === 0 && parens === 0 && braces === 0) {
      parts.push(source.slice(start, index).trim())
      start = index + 1
    }
  }
  parts.push(source.slice(start).trim())
  return parts.filter(Boolean)
}

function topLevelCharacter(source: string, expected: string): number {
  let angle = 0
  let square = 0
  let parens = 0
  let braces = 0
  let quote: string | undefined
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if (quote) {
      if (character === "\\") { index += 1; continue }
      if (character === quote) quote = undefined
      continue
    }
    if (character === "\"" || character === "'" || character === "`") { quote = character; continue }
    if (character === "<") angle += 1
    else if (character === ">") angle = Math.max(0, angle - 1)
    else if (character === "[") square += 1
    else if (character === "]") square = Math.max(0, square - 1)
    else if (character === "(") parens += 1
    else if (character === ")") parens = Math.max(0, parens - 1)
    else if (character === "{") braces += 1
    else if (character === "}") braces = Math.max(0, braces - 1)
    else if (character === expected && angle === 0 && square === 0 && parens === 0 && braces === 0) return index
  }
  return -1
}

function semanticInitializerParameters(source: string): readonly SemanticInitializerParameter[] {
  const parsed = splitParameterSource(source).map(parameterSource => {
    const kind = parameterSource.includes("@ViewBuilder")
      ? "viewBuilder" as const
      : parameterSource.includes("@Action")
        ? "action" as const
        : parameterSource.includes("@Binding")
          ? "binding" as const
          : "value" as const
    const clean = parameterSource.replace(/@(?:ViewBuilder|Action|Binding)\s*/g, "").trim()
    const equals = topLevelCharacter(clean, "=")
    const declaration = equals < 0 ? clean : clean.slice(0, equals).trim()
    const defaultValue = equals < 0 ? undefined : clean.slice(equals + 1).trim()
    const colon = topLevelCharacter(declaration, ":")
    const head = (colon < 0 ? declaration : declaration.slice(0, colon)).trim()
    const words = head.split(/\s+/).filter(Boolean)
    const name = (words.at(-1) ?? "value").replace(/^_+/, "")
    return {
      name,
      label: words[0] === "_" ? undefined : words[0],
      kind,
      required: defaultValue === undefined,
      type: colon < 0 ? undefined : declaration.slice(colon + 1).trim(),
    }
  })
  return parsed.map((parameter, index) => {
    const trailing = index === parsed.length - 1 && (parameter.kind === "viewBuilder" || parameter.kind === "action")
    return {
      ...parameter,
      trailing,
      labelRequired: parameter.label !== undefined && !trailing,
    }
  })
}

function synthesizedMemberwiseInitializer(declaration: MunStructDeclaration): MunSemanticInitializer {
  const constructorFields = declaration.fields.filter(field => field.kind !== "state")
  const parameters: SemanticInitializerParameter[] = constructorFields.map(field => ({
    name: field.name,
    label: field.name,
    labelRequired: true,
    kind: field.kind === "binding" ? "binding" : "value",
    required: field.initializer === undefined,
    type: field.kind === "binding" && field.type ? `Binding<${field.type}>` : field.type,
  }))
  const parametersSource = constructorFields.map((field, index) => {
    const parameter = parameters[index]
    const binding = field.kind === "binding" ? "@Binding " : ""
    const type = parameter.type ? `: ${parameter.type}` : ""
    const fallback = field.initializer === undefined ? "" : ` = ${field.initializer}`
    return `${binding}${field.name}${type}${fallback}`
  }).join(", ")
  const signature = `${declaration.name}(${parametersSource})`
  const symbol: SemanticInitializerSymbol = {
    kind: "initializer",
    index: 0,
    signature,
    parameters,
  }
  return {
    index: 0,
    signature,
    parametersSource,
    parameters,
    symbol,
    range: declaration.range,
    synthesized: "memberwise",
  }
}

/**
 * Build the canonical semantic View symbols for parsed source structs.
 *
 * A struct without an explicit init receives the same synthesized memberwise
 * initializer contract used by native lowering and language-service call
 * resolution. @State storage is identity-owned and therefore not an initializer
 * argument; @Binding remains an explicit binding input.
 */
export function semanticViewsForStructs(
  structs: readonly MunStructDeclaration[],
  prefix = "",
): MunSemanticView[] {
  const result: MunSemanticView[] = []
  for (const declaration of structs) {
    const qualifiedName = prefix ? `${prefix}.${declaration.name}` : declaration.name
    const initializers = declaration.initializers.length > 0
      ? declaration.initializers.map((initializer, index) => {
          const parameters = semanticInitializerParameters(initializer.parametersSource)
          const symbol: SemanticInitializerSymbol = {
            kind: "initializer",
            index,
            signature: `${declaration.name}(${initializer.parametersSource.trim()})`,
            parameters,
          }
          return {
            index,
            signature: symbol.signature,
            parametersSource: initializer.parametersSource,
            parameters,
            symbol,
            range: initializer.range,
          }
        })
      : [synthesizedMemberwiseInitializer(declaration)]
    const fields = declaration.fields.map(field => ({
      name: field.name,
      kind: field.kind,
      type: field.type,
      initializer: field.initializer,
      range: field.range,
    }))
    const symbol: SemanticViewTypeSymbol = {
      kind: "view",
      name: declaration.name,
      qualifiedName,
      genericParameters: declaration.genericParameters,
      fields: fields.map(field => ({ name: field.name, kind: field.kind, type: field.type, defaultValue: field.initializer })),
      initializers: initializers.map(initializer => initializer.symbol),
    }
    result.push({
      name: declaration.name,
      qualifiedName,
      genericParameters: declaration.genericParameters,
      fields,
      initializers,
      symbol,
      bodyRange: declaration.bodyExpressionRange,
      range: declaration.range,
    })
    result.push(...semanticViewsForStructs(declaration.nested ?? [], qualifiedName))
  }
  return result
}


/**
 * Canonical lexical lookup order for a View constructor used inside another View.
 * The current View's nested types win, then each enclosing scope, then a top-level type.
 */
export function semanticViewLookupCandidates(name: string, scope?: string): readonly string[] {
  if (name.includes(".")) return [name]
  const candidates: string[] = []
  let current = scope
  while (current) {
    candidates.push(`${current}.${name}`)
    const separator = current.lastIndexOf(".")
    current = separator >= 0 ? current.slice(0, separator) : undefined
  }
  candidates.push(name)
  return candidates
}

function collectCalls(program: MunBuilderProgram, output: MunSemanticCall[], scope?: string): void {
  const visit = (node: MunBuilderNode): void => {
    if (node.kind === "call") {
      output.push({
        callee: node.callee,
        ...(scope ? { scope } : {}),
        arguments: node.arguments.map(argument => ({
          label: argument.label,
          kind: argument.value.kind === "closure" ? "closure" as const : "expression" as const,
          source: argument.value.kind === "closure" ? "" : argument.value.source,
          range: argument.range,
        })),
        trailingClosure: node.trailing !== undefined,
        range: node.range,
        resolution: resolveSemanticCall(undefined, []),
      })
      for (const argument of node.arguments) {
        if (argument.value.kind === "closure") collectCalls(argument.value.body, output, scope)
      }
      if (node.trailing) collectCalls(node.trailing.body, output, scope)
      return
    }
    if (node.kind === "conditional") {
      for (const child of node.then.statements) visit(child)
      if (node.otherwise) {
        if (node.otherwise.kind === "conditional") visit(node.otherwise)
        else for (const child of node.otherwise.statements) visit(child)
      }
    }
  }
  for (const node of program.statements) visit(node)
}

function runtimeViewSymbols(): Map<string, SemanticViewTypeSymbol> {
  const result = new Map<string, SemanticViewTypeSymbol>()
  for (const [name, value] of Object.entries(Core)) {
    if (typeof value !== "function") continue
    const symbol = (value as { readonly viewType?: { readonly semanticSymbol?: SemanticViewTypeSymbol } }).viewType?.semanticSymbol
    if (symbol) result.set(name, symbol)
  }
  return result
}

export function canonicalViewSymbols(): Map<string, SemanticViewTypeSymbol> {
  const result = runtimeViewSymbols()
  // The canonical language manifest must be sufficient on its own. @mun/core
  // intentionally excludes legacy runtime View constructors, so runtime metadata
  // can enrich a symbol when present but can never be required for source semantics.
  for (const name of Core.swiftUIViewNames()) {
    const initializers = Core.swiftUIInitializerSymbols(name)
    if (!initializers) continue
    const runtime = result.get(name)
    result.set(name, runtime
      ? { ...runtime, initializers }
      : {
          kind: "view",
          name,
          qualifiedName: name,
          fields: [],
          initializers,
        })
  }
  return result
}

function checkerTypeForExpression(source: string, checker: ts.TypeChecker, sourceFile: ts.SourceFile): string | undefined {
  const wanted = source.trim()
  if (!wanted) return undefined
  let candidate: ts.Expression | undefined
  const visit = (node: ts.Node): void => {
    if (candidate || !ts.isExpression(node)) {
      if (!candidate) ts.forEachChild(node, visit)
      return
    }
    if (node.getText(sourceFile).trim() === wanted) candidate = node
    if (!candidate) ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  if (!candidate) return undefined
  try {
    const type = checker.getTypeAtLocation(candidate)
    if (type.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Never)) return undefined
    // `const label = "x"` has the literal type `"x"`, but a normal Mun
    // initializer accepting `string` must still accept it. Preserve literal
    // precision in TypeScript itself while normalizing the compiler-facing
    // semantic category used for overload matching.
    const primitiveCategory = (value: ts.Type): "string" | "number" | "boolean" | undefined => {
      if (value.flags & (ts.TypeFlags.String | ts.TypeFlags.StringLiteral)) return "string"
      if (value.flags & (ts.TypeFlags.Number | ts.TypeFlags.NumberLiteral)) return "number"
      if (value.flags & (ts.TypeFlags.Boolean | ts.TypeFlags.BooleanLiteral)) return "boolean"
      if (value.isUnion()) {
        const categories = new Set(value.types.map(primitiveCategory))
        if (categories.size === 1 && !categories.has(undefined)) return [...categories][0]
      }
      return undefined
    }
    return primitiveCategory(type) ?? checker.typeToString(type)
  } catch {
    // Type inference is an optional refinement for semantic overload scoring.
    // Generated Mun expressions can occasionally drive TypeScript's
    // contextual-type machinery into an internal error; preserve compilation
    // by falling back to the declared/unknown semantic type instead.
    return undefined
  }
}

function compilerSemanticArgument(
  source: string,
  label: string | undefined,
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
  declaredTypes: ReadonlyMap<string, string> = new Map(),
): SemanticArgument {
  const value = source.trim()
  if (/^(?:\$[A-Za-z_$][A-Za-z0-9_$]*|Binding\s*\()/.test(value)) return { label, kind: "binding", type: "binding" }
  const implicitMember = /^\.([A-Za-z_$][A-Za-z0-9_$]*)$/.exec(value)
  if (implicitMember) return { label, type: "string", value: implicitMember[1] }
  if (/^(?:"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|`(?:[^`\\]|\\.)*`)$/.test(value)) {
    const literalFile = ts.createSourceFile("literal.ts", `(${value})`, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
    const statement = literalFile.statements[0]
    const expression = statement && ts.isExpressionStatement(statement) ? statement.expression : undefined
    const unwrapped = expression && ts.isParenthesizedExpression(expression) ? expression.expression : expression
    return unwrapped && ts.isStringLiteralLike(unwrapped)
      ? { label, type: "string", value: unwrapped.text }
      : { label, type: "string" }
  }
  if (/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(value)) return { label, type: "number" }
  if (/^(?:true|false)$/.test(value)) return { label, type: "boolean" }
  if (/^null$/.test(value)) return { label, type: "null" }
  if (/^undefined$/.test(value)) return { label, type: "undefined" }
  if (/^(?:\[|Array\s*\()/.test(value)) return { label, type: "array" }
  if (/^\{[\s\S]*\}$/.test(value)) return { label, type: "object" }
  if (/=>|^function\b/.test(value)) return { label, type: "function" }
  const declared = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value) ? declaredTypes.get(value) : undefined
  return { label, type: checkerTypeForExpression(value, checker, sourceFile) ?? declared ?? "unknown" }
}

function resolvedCalls(
  calls: readonly MunSemanticCall[],
  views: readonly MunSemanticView[],
  checker: ts.TypeChecker,
  sourceFile: ts.SourceFile,
): MunSemanticCall[] {
  const runtimeSymbols = runtimeViewSymbols()
  const canonicalSymbols = canonicalViewSymbols()
  const sourceViews = new Map(views.map(view => [view.qualifiedName, view] as const))

  const sourceViewFor = (call: MunSemanticCall): MunSemanticView | undefined => {
    for (const candidate of semanticViewLookupCandidates(call.callee, call.scope)) {
      const view = sourceViews.get(candidate)
      if (view) return view
    }
    return undefined
  }

  return calls.map(call => {
    const scopedView = call.scope ? sourceViews.get(call.scope) : undefined
    const declaredTypes = new Map<string, string>()
    for (const field of scopedView?.fields ?? []) if (field.type) declaredTypes.set(field.name, field.type)

    const arguments_: SemanticArgument[] = call.arguments.map((argument, argumentIndex) => argument.kind === "closure"
      ? { label: argument.label, type: "function" }
      : call.callee === "ForEach" && argumentIndex === 1 && /^\{\s*(?:id|key)\s*:/.test(argument.source) && /=>/.test(argument.source)
        ? { label: "key", type: "function" }
        : compilerSemanticArgument(argument.source, argument.label, checker, sourceFile, declaredTypes))
    if (call.trailingClosure) arguments_.push({ type: "function", trailing: true })
    const swiftStyleSource = call.trailingClosure || call.arguments.some(argument => argument.label !== undefined)
    const sourceView = sourceViewFor(call)
    const symbol = sourceView?.symbol
      ?? (swiftStyleSource ? canonicalSymbols : runtimeSymbols).get(call.callee)
    return {
      ...call,
      resolution: resolveSemanticCall(symbol, arguments_),
    }
  })
}

interface ScopedBuilderProgram {
  readonly program: MunBuilderProgram
  readonly scope?: string
}

function builderProgramsFor(source: string, structs: readonly MunStructDeclaration[]): ScopedBuilderProgram[] {
  const programs: ScopedBuilderProgram[] = []
  const seen = new Set<string>()
  const add = (program: MunBuilderProgram, scope?: string): void => {
    const key = `${program.range.start}:${program.range.end}:${scope ?? ""}`
    if (seen.has(key)) return
    seen.add(key)
    programs.push({ program, ...(scope ? { scope } : {}) })
  }
  const visit = (declarations: readonly MunStructDeclaration[], prefix = ""): void => {
    for (const declaration of declarations) {
      const qualifiedName = prefix ? `${prefix}.${declaration.name}` : declaration.name
      add(parseMunBuilder(declaration.bodyExpressionSource, declaration.bodyExpressionRange.start), qualifiedName)
      visit(declaration.nested ?? [], qualifiedName)
    }
  }
  if (structs.length > 0) {
    // Struct bodies are indexed separately above. Mask declarations while
    // preserving offsets so top-level builder calls are not lost when a file
    // also contains custom Views.
    let masked = source
    for (const declaration of [...structs].sort((left, right) => right.range.start - left.range.start)) {
      masked = masked.slice(0, declaration.range.start) + " ".repeat(declaration.range.end - declaration.range.start) + masked.slice(declaration.range.end)
    }
    add(parseMunBuilder(masked))
  }
  visit(structs)
  if (programs.length === 0 && /\b[A-Z][A-Za-z0-9_$]*\s*\(/.test(source)) add(parseMunBuilder(source))
  return programs
}

function importsOf(source: string, generatedSource: string, sourceFile: ts.SourceFile, sourceMap: ReturnType<typeof createMunSourceMap>): MunSemanticImport[] {
  return sourceFile.statements.flatMap(statement => {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) return []
    const generatedRange = { start: statement.getStart(sourceFile), end: statement.end }
    return [{
      module: statement.moduleSpecifier.text,
      range: mapRange(source, generatedSource, sourceMap, generatedRange),
    }]
  })
}


function positionAt(source: string, offset: number): MunSourcePosition {
  const bounded = Math.max(0, Math.min(source.length, offset))
  const prefix = source.slice(0, bounded)
  const line = prefix.split("\n")
  return { line: line.length, column: (line[line.length - 1]?.length ?? 0) + 1 }
}

function offsetAt(source: string, position: MunSourcePosition): number {
  const lines = source.split("\n")
  const line = Math.max(1, Math.min(lines.length, position.line))
  const offset = lines.slice(0, line - 1).reduce((sum, value) => sum + value.length + 1, 0)
  return Math.min(source.length, offset + Math.max(0, position.column - 1))
}

function mapRange(source: string, generatedSource: string, map: ReturnType<typeof createMunSourceMap>, generatedRange: MunSourceRange): MunSourceRange {
  const start = mapGeneratedPosition(map, positionAt(generatedSource, generatedRange.start))
  const end = mapGeneratedPosition(map, positionAt(generatedSource, generatedRange.end))
  return { start: offsetAt(source, start), end: Math.max(offsetAt(source, start), offsetAt(source, end)) }
}

function matchingDelimiter(source: string, open: number, opener: string, closer: string): number {
  let depth = 0
  for (let index = open; index < source.length; index += 1) {
    if (source[index] === "\"" || source[index] === "'" || source[index] === "`") {
      const quote = source[index]
      index += 1
      while (index < source.length) {
        if (source[index] === "\\") { index += 2; continue }
        if (source[index] === quote) break
        index += 1
      }
      continue
    }
    if (source[index] === opener) depth += 1
    else if (source[index] === closer && --depth === 0) return index
  }
  return source.length - 1
}

function originalCallRange(source: string, name: string): MunSourceRange | undefined {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const expression = new RegExp(`\\b${escaped}\\s*\\(`, "g")
  const match = expression.exec(source)
  if (!match) return undefined
  const open = source.indexOf("(", match.index + name.length)
  if (open < 0) return undefined
  const close = matchingDelimiter(source, open, "(", ")")
  return { start: match.index, end: Math.min(source.length, close + 1) }
}


function typescriptGraphSymbols(
  source: string,
  generatedSource: string,
  sourceFile: ts.SourceFile,
  sourceMap: ReturnType<typeof createMunSourceMap>,
): {
  readonly foreignComponents: MunSemanticForeignComponent[]
} {
  const foreignComponents: MunSemanticForeignComponent[] = []
  const vueImports = new Map<string, string>()
  const reactImports = new Map<string, string>()
  for (const statement of sourceFile.statements) {
    if (!ts.isImportDeclaration(statement) || !ts.isStringLiteral(statement.moduleSpecifier)) continue
    const module = statement.moduleSpecifier.text
    if (/\.vue$/i.test(module) && statement.importClause?.name) vueImports.set(statement.importClause.name.text, module)
    if (/\.(?:tsx|jsx)$/i.test(module) && statement.importClause?.name) reactImports.set(statement.importClause.name.text, module)
  }

  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isCallExpression(node.initializer)) {
      const expression = node.initializer.expression
      const argument = node.initializer.arguments[0]
      if (ts.isIdentifier(expression) && /^(?:__munForeignComponent|__munVueComponent|__munReactComponent)/.test(expression.text) && ts.isIdentifier(argument)) {
        const isReact = expression.text === "__munReactComponent"
        const module = (isReact ? reactImports : vueImports).get(argument.text)
        if (module) {
          const generatedRange = { start: node.getStart(sourceFile), end: node.end }
          foreignComponents.push({
            localName: node.name.text,
            module,
            range: originalCallRange(source, node.name.text) ?? mapRange(source, generatedSource, sourceMap, generatedRange),
            generatedRange,
            symbol: {
              kind: "foreign-component",
              localName: node.name.text,
              module,
              rendererAdapter: isReact ? "@mun/react" : "@mun/vue",
            },
          })
        }
      }
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return { foreignComponents }
}

function typescriptSnapshot(fileName: string, source: string): {
  readonly sourceFile: ts.SourceFile
  readonly checker: ts.TypeChecker
  readonly diagnostics: readonly ts.Diagnostic[]
} {
  const options: ts.CompilerOptions = {
    allowJs: false,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    noEmit: true,
    noResolve: true,
    skipLibCheck: true,
    target: ts.ScriptTarget.ES2022,
  }
  const host = ts.createCompilerHost(options, true)
  const normalize = (value: string): string => value.replaceAll("\\", "/")
  const requestedRoot = normalize(fileName)
  const originalGetSourceFile = host.getSourceFile.bind(host)
  const originalReadFile = host.readFile.bind(host)
  const originalFileExists = host.fileExists.bind(host)
  host.fileExists = requested => normalize(requested) === requestedRoot || originalFileExists(requested)
  host.readFile = requested => normalize(requested) === requestedRoot ? source : originalReadFile(requested)
  host.getSourceFile = (requested, languageVersion, onError, shouldCreateNewSourceFile) => normalize(requested) === requestedRoot
    ? ts.createSourceFile(requested, source, languageVersion, true, /\.tsx$/i.test(fileName) ? ts.ScriptKind.TSX : ts.ScriptKind.TS)
    : originalGetSourceFile(requested, languageVersion, onError, shouldCreateNewSourceFile)
  const program = ts.createProgram([fileName], options, host)
  const sourceFile = program.getSourceFile(fileName) ?? ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  return {
    sourceFile,
    checker: program.getTypeChecker(),
    diagnostics: program.getSyntacticDiagnostics(sourceFile),
  }
}

export function createSemanticModel(source: string, fileName: string, generatedSource: string): MunSemanticModel {
  const snapshot = typescriptSnapshot(fileName, generatedSource)
  const typescript = snapshot.sourceFile
  const structs = parseMunStructs(source)
  const scopedBuilderPrograms = builderProgramsFor(source, structs)
  const builderPrograms = scopedBuilderPrograms.map(({ program }) => program)
  const collectedCalls: MunSemanticCall[] = []
  for (const { program, scope } of scopedBuilderPrograms) collectCalls(program, collectedCalls, scope)
  const views = semanticViewsForStructs(structs)
  const calls = resolvedCalls(collectedCalls, views, snapshot.checker, typescript)
  const sourceMap = createMunSourceMap(source, generatedSource, fileName)
  const graphSymbols = typescriptGraphSymbols(source, generatedSource, typescript, sourceMap)
  const symbolTable = new SemanticModel()
  for (const view of canonicalViewSymbols().values()) {
    symbolTable.register(view)
    for (const initializer of view.initializers) symbolTable.register(initializer)
  }
  for (const view of views) {
    symbolTable.register(view.symbol)
    for (const initializer of view.symbol.initializers) symbolTable.register(initializer)
    for (const field of view.symbol.fields) {
      if (field.kind === "state") symbolTable.register({ kind: "state", name: `${view.qualifiedName}.${field.name}`, type: field.type } satisfies SemanticStateSymbol)
      if (field.kind === "binding") symbolTable.register({ kind: "binding", name: `${view.qualifiedName}.${field.name}`, type: field.type })
    }
  }
  symbolTable.register({
    kind: "builder",
    name: "ViewBuilder",
    contentType: "View",
    operations: ["buildBlock", "buildOptional", "buildEither", "buildArray"],
  } satisfies SemanticBuilderTypeSymbol)
  for (const foreign of graphSymbols.foreignComponents) symbolTable.register(foreign.symbol)
  return {
    kind: "MunSemanticModel",
    fileName,
    source,
    generatedSource,
    typescript,
    typeChecker: snapshot.checker,
    typescriptDiagnostics: snapshot.diagnostics,
    structs,
    views,
    builderPrograms,
    calls,
    imports: importsOf(source, generatedSource, typescript, sourceMap),
    foreignComponents: graphSymbols.foreignComponents,
    symbolTable,
    symbols: symbolTable.values(),
    view(name) {
      const qualified = views.find(view => view.qualifiedName === name)
      if (qualified) return qualified
      const simple = views.filter(view => view.name === name)
      return simple.length === 1 ? simple[0] : undefined
    },
    symbol(name) {
      return symbolTable.get(name)
    },
  }
}

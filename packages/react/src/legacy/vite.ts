import * as ts from 'typescript'
import { transformMunBuilderSyntax } from './compiler/builder-transform.js'
import { transformMunStructSyntax } from './compiler/struct-transform.js'
import { createLegacyMunSourceMap } from './compiler/source-map.js'

export interface MunSourceMap {
  readonly version: 3
  readonly file?: string
  readonly sources: readonly string[]
  readonly sourcesContent?: readonly string[]
  readonly names: readonly string[]
  readonly mappings: string
  readonly x_mun?: {
    readonly lineMappings: readonly { line: number; column: number }[]
  }
}

export interface MunMacroPlugin {
  name: string
  enforce: 'pre'
  transform(this: MunTransformContext, code: string, id: string): { code: string; map: MunSourceMap | null } | null
}

export interface MunTransformContext {
  warn(message: string): void
}

type EditOrigin = { generatedOffset: number; originalOffset: number }
type Edit = { start: number; end: number; replacement: string; origins?: EditOrigin[] }

interface StateDeclaration {
  name: string
  call: ts.CallExpression
  initializer: ts.Expression
  statement: ts.VariableStatement
  declaration: ts.VariableDeclaration
}

interface MacroDiagnostic {
  message: string
  start: number
}

function scriptKindFor(id: string): ts.ScriptKind {
  const pathname = id.split('?', 1)[0].toLowerCase()
  if (pathname.endsWith('.tsx')) return ts.ScriptKind.TSX
  if (pathname.endsWith('.jsx')) return ts.ScriptKind.JSX
  if (pathname.endsWith('.js') || pathname.endsWith('.mjs') || pathname.endsWith('.cjs')) {
    return ts.ScriptKind.JS
  }
  return ts.ScriptKind.TS
}

function isNamedCall(node: ts.Node, name: string): node is ts.CallExpression {
  return ts.isCallExpression(node)
    && ts.isIdentifier(node.expression)
    && node.expression.text === name
}

function unwrapParentheses<T extends ts.Expression>(node: T): ts.Expression {
  let current: ts.Expression = node
  while (ts.isParenthesizedExpression(current)) current = current.expression
  return current
}

function unwrapExpression(node: ts.Expression): ts.Expression {
  let current = unwrapParentheses(node)
  while (
    ts.isAsExpression(current)
    || ts.isTypeAssertionExpression(current)
    || ts.isNonNullExpression(current)
    || ts.isSatisfiesExpression(current)
  ) {
    current = unwrapParentheses(current.expression)
  }
  return current
}

function isFunctionArgument(node: ts.Expression): boolean {
  const unwrapped = unwrapParentheses(node)
  return ts.isArrowFunction(unwrapped) || ts.isFunctionExpression(unwrapped)
}

function collectTopLevelStates(sourceFile: ts.SourceFile): StateDeclaration[] {
  const states: StateDeclaration[] = []

  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue
    if ((statement.declarationList.flags & ts.NodeFlags.Const) === 0) continue
    if (statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue

    const candidates = statement.declarationList.declarations.filter(declaration =>
      ts.isIdentifier(declaration.name)
      && declaration.initializer
      && isNamedCall(unwrapExpression(declaration.initializer), 'State'),
    ) as Array<ts.VariableDeclaration & { name: ts.Identifier; initializer: ts.CallExpression }>

    for (const declaration of candidates) {
      states.push({
        name: declaration.name.text,
        call: unwrapExpression(declaration.initializer) as ts.CallExpression,
        initializer: declaration.initializer,
        statement,
        declaration,
      })
    }
  }

  return states
}

function collectMacroDiagnostics(sourceFile: ts.SourceFile): MacroDiagnostic[] {
  const diagnostics: MacroDiagnostic[] = []

  for (const statement of sourceFile.statements) {
    if (!ts.isVariableStatement(statement)) continue

    const exported = statement.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword) ?? false
    const isConst = (statement.declarationList.flags & ts.NodeFlags.Const) !== 0
    for (const declaration of statement.declarationList.declarations) {
      if (!declaration.initializer || !isNamedCall(unwrapExpression(declaration.initializer), 'State')) continue
      if (exported) {
        diagnostics.push({
          start: declaration.getStart(sourceFile),
          message: 'Top-level State declarations used by view() must not be exported; the declaration remains module-scoped.',
        })
      } else if (!isConst) {
        diagnostics.push({
          start: declaration.getStart(sourceFile),
          message: 'Top-level State declarations used by view() must use const so the Mun macro can make them instance-local.',
        })
      } else if (!ts.isIdentifier(declaration.name)) {
        diagnostics.push({
          start: declaration.getStart(sourceFile),
          message: 'The Mun macro only hoists identifier State declarations; destructuring remains module-scoped.',
        })
      }
    }
  }

  return diagnostics
}

function collectViewCalls(sourceFile: ts.SourceFile): ts.CallExpression[] {
  const views: ts.CallExpression[] = []
  const visit = (node: ts.Node): void => {
    if (isNamedCall(node, 'view')) {
      views.push(node)
      // A nested view() belongs to the already transformed view expression;
      // treating it as a second top-level owner would duplicate its edits.
      return
    }
    ts.forEachChild(node, visit)
  }
  visit(sourceFile)
  return views.sort((left, right) => left.getStart(sourceFile) - right.getStart(sourceFile))
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text]
  if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
    return name.elements.flatMap(element => ts.isOmittedExpression(element) ? [] : bindingNames(element.name))
  }
  return []
}

function isNonReferenceIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return true
  if (ts.isPropertyAssignment(parent) && parent.name === node) return true
  if (ts.isMethodDeclaration(parent) && parent.name === node) return true
  if (ts.isPropertyDeclaration(parent) && parent.name === node) return true
  if (ts.isMethodSignature(parent) && parent.name === node) return true
  if (ts.isPropertySignature(parent) && parent.name === node) return true
  if (ts.isVariableDeclaration(parent) && parent.name === node) return true
  if (ts.isParameter(parent) && parent.name === node) return true
  if (ts.isBindingElement(parent) && parent.name === node) return true
  if (ts.isFunctionDeclaration(parent) && parent.name === node) return true
  if (ts.isClassDeclaration(parent) && parent.name === node) return true
  return false
}

function directBlockBindings(node: ts.SourceFile | ts.Block): Set<string> {
  const bindings = new Set<string>()
  for (const statement of node.statements) {
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        for (const name of bindingNames(declaration.name)) bindings.add(name)
      }
    } else if (ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)) {
      if (statement.name) bindings.add(statement.name.text)
    }
  }
  return bindings
}

/** Collect free references to top-level State names, respecting local closures. */
function referencedStateNames(root: ts.Node, stateNames: ReadonlySet<string>): Set<string> {
  const result = new Set<string>()
  const visit = (node: ts.Node, shadowed: ReadonlySet<string>): void => {
    if (ts.isIdentifier(node) && stateNames.has(node.text) && !shadowed.has(node.text) && !isNonReferenceIdentifier(node)) {
      result.add(node.text)
    }

    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node)) {
      const local = new Set(shadowed)
      for (const parameter of node.parameters) for (const name of bindingNames(parameter.name)) local.add(name)
      if (ts.isFunctionDeclaration(node) && node.name) local.add(node.name.text)
      if (node.body) visit(node.body, local)
      return
    }

    if (ts.isSourceFile(node) || ts.isBlock(node)) {
      const local = new Set(shadowed)
      for (const name of directBlockBindings(node)) local.add(name)
      ts.forEachChild(node, child => visit(child, local))
      return
    }

    if (ts.isCatchClause(node)) {
      const local = new Set(shadowed)
      if (node.variableDeclaration) for (const name of bindingNames(node.variableDeclaration.name)) local.add(name)
      visit(node.block, local)
      return
    }

    ts.forEachChild(node, child => visit(child, shadowed))
  }
  visit(root, new Set())
  return result
}

function statesForView(view: ts.CallExpression, states: readonly StateDeclaration[], sourceFile: ts.SourceFile): StateDeclaration[] {
  const byName = new Map(states.map(state => [state.name, state] as const))
  const names = referencedStateNames(view.arguments[0] ?? view, new Set(byName.keys()))
  const queue = [...names]
  while (queue.length > 0) {
    const name = queue.pop()!
    const state = byName.get(name)
    if (!state) continue
    for (const dependency of referencedStateNames(state.call, new Set(byName.keys()))) {
      if (!names.has(dependency)) {
        names.add(dependency)
        queue.push(dependency)
      }
    }
  }
  return states
    .filter(state => names.has(state.name))
    .sort((left, right) => left.declaration.getStart(sourceFile) - right.declaration.getStart(sourceFile))
}

function collectActionEdits(sourceFile: ts.SourceFile, root: ts.Node): Edit[] {
  const edits: Edit[] = []

  function visit(node: ts.Node): void {
    if (isNamedCall(node, 'Action') && node.arguments.length === 1) {
      const argument = node.arguments[0]
      if (!isFunctionArgument(argument)) {
        edits.push({
          start: node.getStart(sourceFile),
          end: node.end,
          replacement: `(() => (${sourceFile.text.slice(argument.getStart(sourceFile), argument.end).trim()}))`,
        })
      }
    }
    ts.forEachChild(node, visit)
  }

  visit(root)
  return edits
}

function removeTopLevelStateDeclarations(sourceFile: ts.SourceFile, states: StateDeclaration[]): Edit[] {
  const statesByStatement = new Map<ts.VariableStatement, Set<ts.VariableDeclaration>>()
  for (const state of states) {
    const declarations = statesByStatement.get(state.statement) ?? new Set<ts.VariableDeclaration>()
    declarations.add(state.declaration)
    statesByStatement.set(state.statement, declarations)
  }

  const printer = ts.createPrinter({ newLine: ts.NewLineKind.LineFeed })
  const edits: Edit[] = []
  for (const [statement, stateDeclarations] of statesByStatement) {
    const kept = statement.declarationList.declarations.filter(declaration => !stateDeclarations.has(declaration))
    if (kept.length === 0) {
      edits.push({ start: statement.getStart(sourceFile), end: statement.end, replacement: '' })
      continue
    }

    const declarationList = ts.factory.updateVariableDeclarationList(statement.declarationList, kept)
    const updated = ts.factory.updateVariableStatement(statement, statement.modifiers, declarationList)
    edits.push({
      start: statement.getStart(sourceFile),
      end: statement.end,
      replacement: printer.printNode(ts.EmitHint.Unspecified, updated, sourceFile),
    })
  }
  return edits
}

function applyEdits(source: string, edits: Edit[]): string {
  let output = source
  for (const edit of [...edits].sort((left, right) => right.start - left.start)) {
    output = output.slice(0, edit.start) + edit.replacement + output.slice(edit.end)
  }
  return output
}

function lineStarts(source: string): number[] {
  const starts = [0]
  for (let index = 0; index < source.length; index += 1) {
    if (source[index] === '\n') starts.push(index + 1)
  }
  return starts
}

function sourceLocation(source: string, offset: number): { line: number; column: number } {
  const starts = lineStarts(source)
  let low = 0
  let high = starts.length
  while (low + 1 < high) {
    const middle = Math.floor((low + high) / 2)
    if (starts[middle] <= offset) low = middle
    else high = middle
  }
  return { line: low, column: Math.max(0, offset - starts[low]) }
}

const base64Digits = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function encodeVLQ(value: number): string {
  let encoded = value < 0 ? ((-value << 1) | 1) : value << 1
  let result = ''
  do {
    let digit = encoded & 31
    encoded >>>= 5
    if (encoded > 0) digit |= 32
    result += base64Digits[digit]
  } while (encoded > 0)
  return result
}

interface SourceMapAnchor {
  generatedLine: number
  generatedColumn: number
  originalOffset: number
}

function buildSourceMap(source: string, anchors: SourceMapAnchor[], id: string): MunSourceMap {
  let previousOriginalLine = 0
  let previousOriginalColumn = 0
  let previousGeneratedLine = 0
  let previousGeneratedColumn = 0
  const lines: string[] = []

  for (const anchor of anchors) {
    const location = sourceLocation(source, anchor.originalOffset)
    while (lines.length <= anchor.generatedLine) lines.push('')
    const generatedLineDelta = anchor.generatedLine - previousGeneratedLine
    const generatedColumnDelta = generatedLineDelta === 0
      ? anchor.generatedColumn - previousGeneratedColumn
      : anchor.generatedColumn
    const segment = `${encodeVLQ(generatedColumnDelta)}${encodeVLQ(0)}${encodeVLQ(location.line - previousOriginalLine)}${encodeVLQ(location.column - previousOriginalColumn)}`
    lines[anchor.generatedLine] += `${lines[anchor.generatedLine] ? ',' : ''}${segment}`
    previousGeneratedLine = anchor.generatedLine
    previousGeneratedColumn = anchor.generatedColumn
    previousOriginalLine = location.line
    previousOriginalColumn = location.column
  }

  return {
    version: 3,
    file: id.split('?', 1)[0] || undefined,
    sources: [id.split('?', 1)[0] || 'mun-macro.ts'],
    sourcesContent: [source],
    names: [],
    mappings: lines.join(';'),
  }
}

function applyEditsWithMap(source: string, edits: Edit[], id: string): { code: string; map: MunSourceMap } {
  const sorted = [...edits].sort((left, right) => left.start - right.start)
  let cursor = 0
  let code = ''
  let generatedLine = 0
  let generatedColumn = 0
  const anchors: SourceMapAnchor[] = []

  const append = (value: string, anchor: (index: number) => number, explicitOrigins: EditOrigin[] = []) => {
    if (value.length === 0) return
    const explicit = new Map(explicitOrigins.map(origin => [origin.generatedOffset, origin.originalOffset]))
    const addAnchor = (index: number, originalOffset = anchor(index)) => {
      anchors.push({ generatedLine, generatedColumn, originalOffset })
    }
    addAnchor(0)
    for (let index = 0; index < value.length; index += 1) {
      if (index > 0 && value[index - 1] === '\n') {
        addAnchor(index)
      }
      if (index > 0 && explicit.has(index)) {
        addAnchor(index, explicit.get(index))
      }
      const character = value[index]
      code += character
      if (character === '\n') {
        generatedLine += 1
        generatedColumn = 0
      } else {
        generatedColumn += 1
      }
    }
  }

  append('/* @mun-macro-transformed */\n', () => 0)
  for (const edit of sorted) {
    if (edit.start < cursor) continue
    append(source.slice(cursor, edit.start), index => cursor + index)
    const origins = [...(edit.origins ?? [])].sort((left, right) => left.generatedOffset - right.generatedOffset)
    append(edit.replacement, index => {
      let originalOffset = edit.start
      for (const origin of origins) {
        if (origin.generatedOffset > index) break
        originalOffset = origin.originalOffset
      }
      return originalOffset
    }, origins)
    cursor = edit.end
  }
  append(source.slice(cursor), index => cursor + index)

  return { code, map: buildSourceMap(source, anchors, id) }
}

function viewArgumentText(sourceFile: ts.SourceFile, view: ts.CallExpression): string {
  const argument = view.arguments[0]
  if (!argument) return 'undefined'
  const argumentStart = argument.pos
  const edits = collectActionEdits(sourceFile, argument)
    .map(edit => ({ ...edit, start: edit.start - argumentStart, end: edit.end - argumentStart }))
  return applyEdits(sourceFile.text.slice(argumentStart, argument.end), edits).trim()
}

function viewArgumentIsFunction(view: ts.CallExpression): boolean {
  const argument = view.arguments[0]
  return !!argument && isFunctionArgument(argument)
}

function viewArgumentHasParameters(view: ts.CallExpression): boolean {
  const argument = view.arguments[0]
  if (!argument) return false
  const unwrapped = unwrapParentheses(argument)
  return (ts.isArrowFunction(unwrapped) || ts.isFunctionExpression(unwrapped)) && unwrapped.parameters.length > 0
}

function replacementOrigins(
  sourceFile: ts.SourceFile,
  view: ts.CallExpression,
  states: StateDeclaration[],
  replacement: string,
  body: string,
): EditOrigin[] {
  const origins: EditOrigin[] = []
  let searchStart = 0
  for (const state of states) {
    const callText = sourceFile.text.slice(state.call.getStart(sourceFile), state.call.end)
    const generatedOffset = replacement.indexOf(callText, searchStart)
    if (generatedOffset >= 0) {
      origins.push({ generatedOffset, originalOffset: state.call.getStart(sourceFile) })
      searchStart = generatedOffset + callText.length
    }
  }

  const argument = view.arguments[0]
  if (argument) {
    const generatedOffset = replacement.indexOf(body, searchStart)
    if (generatedOffset >= 0) {
      origins.push({ generatedOffset, originalOffset: argument.getStart(sourceFile) })
    }
  }
  return origins
}

interface MacroTransformResult {
  code: string
  map: MunSourceMap
  diagnostics: MacroDiagnostic[]
}

function hasMunSyntax(source: string): boolean {
  const hasStruct = /\bstruct\s+[A-Z][A-Za-z0-9_$]*(?:\s*<[^>{}]*>)?\s*:\s*View\b/.test(source)
  // Do not treat renderer.view(...) or another member call as the Mun view()
  // entry point. The macro runs before Vite resolves workspace packages, so a
  // false positive here can rewrite ordinary dependency JavaScript.
  const hasView = /(?:^|[^\w.$])view\s*\(/m.test(source)
  if (!hasStruct && !hasView) return false
  return hasStruct
    || /\b(?:@State|@Binding|@ViewBuilder|@Action)\b/.test(source)
    || /\b[A-Z][A-Za-z0-9_$]*\s*\([^\n]*\)\s*\{/.test(source)
    || /\b[A-Za-z_$][A-Za-z0-9_$]*\s*:\s*(?:\.|\$|\{)/.test(source)
    || /\.font\s*\(\s*\./.test(source)
}

function lowerMunSyntax(source: string): string {
  if (!hasMunSyntax(source)) return source
  const lowered = transformMunBuilderSyntax(transformMunStructSyntax(source))
  const required = [
    ...( /\bBinding\s*\(/.test(lowered) ? ['Binding'] : []),
    ...( /\bnamedArguments\s*\(/.test(lowered) ? ['namedArguments'] : []),
    ...( /\boverloadClosure\s*\(/.test(lowered) ? ['overloadClosure'] : []),
  ]
  if (required.length === 0) return lowered

  const existing = /import\s*\{([\s\S]*?)\}\s*from\s*(['"])@mun\/ui\/legacy\2[\t ]*;?/.exec(lowered)
  if (!existing) return `import { ${required.join(', ')} } from '@mun/ui/legacy'\n${lowered}`
  const imported = existing[1].split(',').map(name => name.trim()).filter(Boolean)
  const merged = [...imported]
  for (const name of required) if (!merged.includes(name)) merged.push(name)
  if (merged.length === imported.length) return lowered
  const replacement = `import { ${merged.join(', ')} } from '@mun/ui/legacy'`
  return lowered.slice(0, existing.index) + replacement + lowered.slice(existing.index + existing[0].length)
}

function transformMunMacrosWithMap(source: string, id = ''): MacroTransformResult | null {
  if (source.includes('/* @mun-macro-transformed */')) return null
  if (id) {
    const pathname = id.split('?', 1)[0]
    if (!/\.mun(?:\.tsx?)?$/i.test(pathname) && !/\.[cm]?[jt]sx?$/.test(pathname)) return null
  }

  const sourceFile = ts.createSourceFile(
    id.split('?', 1)[0] || 'mun-macro.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKindFor(id),
  )
  const views = collectViewCalls(sourceFile)
  if (views.length === 0) return null

  const allStates = collectTopLevelStates(sourceFile)
  const diagnostics = collectMacroDiagnostics(sourceFile)
  const plans = views.map(view => ({ view, states: statesForView(view, allStates, sourceFile) }))
  const hoistedStates = allStates.filter(state => plans.some(plan => plan.states.includes(state)))
  const edits: Edit[] = removeTopLevelStateDeclarations(sourceFile, hoistedStates)

  for (const { view, states } of plans) {
    const body = viewArgumentText(sourceFile, view)
    const functionBody = viewArgumentIsFunction(view)
    let replacement: string
    if (states.length > 0) {
      const declarations = states
        .map(state => `    const ${state.name} = ${sourceFile.text.slice(state.initializer.getStart(sourceFile), state.initializer.end)}`)
        .join('\n')
      const names = states.map(state => state.name).join(', ')
      const hasProps = viewArgumentHasParameters(view)
      const bodyParameters = hasProps ? `({ ${names} }, props)` : `({ ${names} })`
      const renderedBody = functionBody
        ? `((${body})(${hasProps ? 'props' : ''}))`
        : `(${body})`
      replacement = `view({\n  state: () => {\n${declarations}\n    return { ${names} }\n  },\n  body: ${bodyParameters} => ${renderedBody},\n})`
    } else {
      replacement = functionBody ? `view(${body})` : `view(() => (${body}))`
    }

    edits.push({
      start: view.getStart(sourceFile),
      end: view.end,
      replacement,
      origins: replacementOrigins(sourceFile, view, states, replacement, body),
    })
  }

  return { ...applyEditsWithMap(source, edits, id), diagnostics }
}

export function munMacro(): MunMacroPlugin {
  return {
    name: 'mun-macro',
    enforce: 'pre',
    transform(code, id) {
      const lowered = lowerMunSyntax(code)
      const result = transformMunMacrosWithMap(lowered, id)
      if (result) {
        for (const diagnostic of result.diagnostics) {
          const location = sourceLocation(code, diagnostic.start)
          this?.warn(`[mun-macro] ${id}:${location.line + 1}:${location.column + 1}: ${diagnostic.message}`)
        }
        return {
          code: result.code,
          map: lowered === code ? result.map : createLegacyMunSourceMap(code, result.code, id) as MunSourceMap,
        }
      }
      return lowered === code
        ? null
        : { code: lowered, map: createLegacyMunSourceMap(code, lowered, id) as MunSourceMap }
    },
  }
}

/**
 * Transform helper kept as a string API for callers that do not need Vite's
 * source-map object. The Vite plugin uses the richer internal result above.
 */
export function transformMunMacros(source: string, id = ''): string | null {
  const lowered = lowerMunSyntax(source)
  return transformMunMacrosWithMap(lowered, id)?.code ?? (lowered === source ? null : lowered)
}

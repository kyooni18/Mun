import { munSyntaxError } from './errors.js'

/** A half-open source range in the original Mun document. */
export interface MunSourceRange {
  readonly start: number
  readonly end: number
}

export interface MunRawExpression {
  readonly kind: 'raw'
  readonly source: string
  readonly range: MunSourceRange
}

export interface MunClosureExpression {
  readonly kind: 'closure'
  readonly parameter?: string
  /** The source between the closure braces, retained for action lowering. */
  readonly bodySource: string
  readonly body: MunBuilderProgram
  readonly range: MunSourceRange
}

export interface MunArgument {
  readonly label?: string
  readonly value: MunRawExpression | MunClosureExpression
  readonly range: MunSourceRange
}

export interface MunCallExpression {
  readonly kind: 'call'
  readonly callee: string
  readonly arguments: readonly MunArgument[]
  readonly trailing?: MunClosureExpression
  readonly range: MunSourceRange
}

export interface MunConditionalExpression {
  readonly kind: 'conditional'
  readonly condition: MunRawExpression
  readonly then: MunBuilderProgram
  readonly otherwise?: MunBuilderProgram | MunConditionalExpression
  readonly range: MunSourceRange
}

export type MunBuilderNode = MunRawExpression | MunCallExpression | MunConditionalExpression

export interface MunBuilderProgram {
  readonly kind: 'program'
  readonly source: string
  readonly range: MunSourceRange
  readonly statements: readonly MunBuilderNode[]
}

type Delimiter = '(' | '{' | '['

const closeFor: Record<Delimiter, ')' | '}' | ']'> = {
  '(': ')',
  '{': '}',
  '[': ']',
}

function isIdentifierStart(char: string | undefined): boolean {
  return !!char && /[A-Za-z_$]/.test(char)
}

function isIdentifierPart(char: string | undefined): boolean {
  return !!char && /[A-Za-z0-9_$]/.test(char)
}

function skipQuoted(source: string, index: number, quote: "'" | '"'): number {
  for (let i = index + 1; i < source.length; i += 1) {
    if (source[i] === '\\') { i += 1; continue }
    if (source[i] === quote) return i + 1
  }
  throw munSyntaxError(`Unclosed ${quote} string in Mun AST`, index)
}

function skipTemplate(source: string, index: number): number {
  for (let i = index + 1; i < source.length; i += 1) {
    if (source[i] === '\\') { i += 1; continue }
    if (source[i] === '`') return i + 1
    if (source[i] === '$' && source[i + 1] === '{') {
      i = findMatching(source, i + 1, '{')
    }
  }
  throw munSyntaxError('Unclosed template literal in Mun AST', index)
}

function previousSignificant(source: string, index: number): string | undefined {
  for (let i = index - 1; i >= 0; i -= 1) {
    if (!/\s/.test(source[i])) return source[i]
  }
  return undefined
}

function regexCanStartAfter(source: string, index: number): boolean {
  const previous = previousSignificant(source, index)
  if (previous === undefined || '([{=,:;!?&|+-*%^~<>'.includes(previous)) return true
  let end = index
  while (end > 0 && /\s/.test(source[end - 1])) end -= 1
  let start = end
  while (start > 0 && isIdentifierPart(source[start - 1])) start -= 1
  return ['case', 'delete', 'do', 'else', 'in', 'instanceof', 'of', 'return', 'throw', 'typeof', 'void', 'yield']
    .includes(source.slice(start, end))
}

function skipRegex(source: string, index: number): number {
  let inClass = false
  for (let i = index + 1; i < source.length; i += 1) {
    const char = source[i]
    if (char === '\\') { i += 1; continue }
    if (char === '[') inClass = true
    if (char === ']') inClass = false
    if (char === '/' && !inClass) {
      i += 1
      while (/[A-Za-z]/.test(source[i] ?? '')) i += 1
      return i
    }
    if (char === '\n' || char === '\r') break
  }
  return index + 1
}

function skipTrivia(source: string, index: number): number {
  let i = index
  while (i < source.length && /\s/.test(source[i])) i += 1
  return i
}

function findMatching(source: string, openIndex: number, open: Delimiter): number {
  const close = closeFor[open]
  let depth = 0
  for (let i = openIndex; i < source.length; i += 1) {
    const char = source[i]
    const next = source[i + 1]
    if (char === "'" || char === '"') { i = skipQuoted(source, i, char) - 1; continue }
    if (char === '`') { i = skipTemplate(source, i) - 1; continue }
    if (char === '/' && next === '/') {
      const end = source.indexOf('\n', i + 2)
      i = (end < 0 ? source.length : end) - 1
      continue
    }
    if (char === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2)
      if (end < 0) throw munSyntaxError('Unclosed block comment in Mun AST', i)
      i = end + 1
      continue
    }
    if (char === '/' && regexCanStartAfter(source, i)) { i = skipRegex(source, i) - 1; continue }
    if (char === open) depth += 1
    if (char === close && --depth === 0) return i
  }
  throw munSyntaxError(`Unclosed ${open} block in Mun AST`, openIndex)
}

function nextWord(source: string, index: number): string | undefined {
  const start = skipTrivia(source, index)
  const match = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(source.slice(start))
  return match?.[0]
}

function lineBreakIsBoundary(source: string, index: number): boolean {
  const previous = previousSignificant(source, index)
  const nextIndex = skipTrivia(source, index + 1)
  const next = source[nextIndex]
  if (previous === undefined || next === undefined) return true
  if (nextWord(source, index + 1) === 'else') return false
  if (',([{.=:+-*/%!&|?<>'.includes(previous)) return false
  if ('.),]}:;'.includes(next)) return false
  return true
}

interface Slice {
  readonly source: string
  readonly start: number
  readonly end: number
}

function splitTopLevel(source: string, separators: string, baseOffset: number): Slice[] {
  const parts: Slice[] = []
  let start = 0
  let parens = 0
  let brackets = 0
  let braces = 0
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]
    const next = source[i + 1]
    if (char === "'" || char === '"') { i = skipQuoted(source, i, char) - 1; continue }
    if (char === '`') { i = skipTemplate(source, i) - 1; continue }
    if (char === '/' && next === '/') {
      const end = source.indexOf('\n', i + 2)
      i = (end < 0 ? source.length : end) - 1
      continue
    }
    if (char === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2)
      if (end < 0) throw munSyntaxError('Unclosed block comment in Mun AST', i)
      i = end + 1
      continue
    }
    if (char === '/' && regexCanStartAfter(source, i)) { i = skipRegex(source, i) - 1; continue }
    if (char === '(') parens += 1
    else if (char === ')') parens -= 1
    else if (char === '[') brackets += 1
    else if (char === ']') brackets -= 1
    else if (char === '{') braces += 1
    else if (char === '}') braces -= 1
    const topLevel = parens === 0 && brackets === 0 && braces === 0
    if (topLevel && separators.includes(char)) {
      parts.push({ source: source.slice(start, i), start: baseOffset + start, end: baseOffset + i })
      start = i + 1
      continue
    }
    if (topLevel && char === '\n' && lineBreakIsBoundary(source, i)) {
      parts.push({ source: source.slice(start, i), start: baseOffset + start, end: baseOffset + i })
      start = i + 1
    }
  }
  parts.push({ source: source.slice(start), start: baseOffset + start, end: baseOffset + source.length })
  return parts.filter(part => part.source.trim().length > 0)
}

function trimSlice(slice: Slice): Slice {
  const leading = slice.source.search(/\S|$/)
  const trimmed = slice.source.trimEnd()
  return {
    source: trimmed.slice(leading),
    start: slice.start + leading,
    end: slice.start + leading + trimmed.slice(leading).length,
  }
}

function raw(slice: Slice): MunRawExpression {
  const value = trimSlice(slice)
  return { kind: 'raw', source: value.source, range: { start: value.start, end: value.end } }
}

function parseClosure(slice: Slice): MunClosureExpression | undefined {
  const value = trimSlice(slice)
  if (value.source[0] !== '{') return undefined
  const close = findMatching(value.source, 0, '{')
  if (close !== value.source.length - 1) return undefined
  const inner = value.source.slice(1, close)
  const innerOffset = value.start + 1
  const parameterMatch = /^\s*([A-Za-z_$][A-Za-z0-9_$]*)\s+in\s+([\s\S]*)$/.exec(inner)
  const bodySource = parameterMatch?.[2] ?? inner
  const bodyOffset = parameterMatch ? innerOffset + (parameterMatch[0].length - parameterMatch[2].length) : innerOffset
  return {
    kind: 'closure',
    parameter: parameterMatch?.[1],
    bodySource,
    body: parseMunBuilder(bodySource, bodyOffset),
    range: { start: value.start, end: value.end },
  }
}

function topLevelColon(source: string): number {
  let parens = 0
  let brackets = 0
  let braces = 0
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]
    const next = source[i + 1]
    if (char === "'" || char === '"') { i = skipQuoted(source, i, char) - 1; continue }
    if (char === '`') { i = skipTemplate(source, i) - 1; continue }
    if (char === '/' && next === '/') { const end = source.indexOf('\n', i + 2); i = (end < 0 ? source.length : end) - 1; continue }
    if (char === '/' && next === '*') { const end = source.indexOf('*/', i + 2); if (end < 0) return -1; i = end + 1; continue }
    if (char === '(') parens += 1
    else if (char === ')') parens -= 1
    else if (char === '[') brackets += 1
    else if (char === ']') brackets -= 1
    else if (char === '{') braces += 1
    else if (char === '}') braces -= 1
    else if (char === ':' && parens === 0 && brackets === 0 && braces === 0) return i
  }
  return -1
}

function parseArgument(slice: Slice): MunArgument {
  const value = trimSlice(slice)
  const colon = topLevelColon(value.source)
  const label = colon < 0 ? undefined : value.source.slice(0, colon).trim()
  if (label && !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(label)) return { value: raw(value), range: { start: value.start, end: value.end } }
  const valueStart = colon < 0 ? value.start : value.start + colon + 1
  const valueSlice: Slice = { source: colon < 0 ? value.source : value.source.slice(colon + 1), start: valueStart, end: value.end }
  const closure = label ? parseClosure(valueSlice) : undefined
  return {
    label,
    value: closure ?? raw(valueSlice),
    range: { start: value.start, end: value.end },
  }
}

function parseCall(slice: Slice): MunCallExpression | undefined {
  const value = trimSlice(slice)
  const identifier = /^([A-Za-z_$][A-Za-z0-9_$]*)/.exec(value.source)
  if (!identifier) return undefined
  const open = skipTrivia(value.source, identifier[0].length)
  if (value.source[open] !== '(') return undefined
  const close = findMatching(value.source, open, '(')
  const afterClose = skipTrivia(value.source, close + 1)
  let trailing: MunClosureExpression | undefined
  let end = close + 1
  if (value.source[afterClose] === '{') {
    const blockClose = findMatching(value.source, afterClose, '{')
    if (skipTrivia(value.source, blockClose + 1) !== value.source.length) return undefined
    trailing = parseClosure({ source: value.source.slice(afterClose, blockClose + 1), start: value.start + afterClose, end: value.start + blockClose + 1 })
    end = blockClose + 1
  }
  if (skipTrivia(value.source, end) !== value.source.length) return undefined
  const argsSource = value.source.slice(open + 1, close)
  const argsOffset = value.start + open + 1
  return {
    kind: 'call',
    callee: identifier[1],
    arguments: splitTopLevel(argsSource, ',', argsOffset).map(parseArgument),
    trailing,
    range: { start: value.start, end: value.end },
  }
}

function parseConditional(slice: Slice): MunConditionalExpression | undefined {
  const value = trimSlice(slice)
  if (!/^if\b/.test(value.source)) return undefined
  const open = value.source.indexOf('(')
  if (open < 0) return undefined
  const close = findMatching(value.source, open, '(')
  const thenOpen = skipTrivia(value.source, close + 1)
  if (value.source[thenOpen] !== '{') return undefined
  const thenClose = findMatching(value.source, thenOpen, '{')
  const afterThen = skipTrivia(value.source, thenClose + 1)
  const conditionSlice: Slice = { source: value.source.slice(open + 1, close), start: value.start + open + 1, end: value.start + close }
  const thenSource = value.source.slice(thenOpen + 1, thenClose)
  const thenOffset = value.start + thenOpen + 1
  let otherwise: MunBuilderProgram | MunConditionalExpression | undefined
  let end = thenClose + 1
  if (value.source.slice(afterThen, afterThen + 4) === 'else') {
    const elseStart = skipTrivia(value.source, afterThen + 4)
    const rest: Slice = { source: value.source.slice(elseStart), start: value.start + elseStart, end: value.end }
    otherwise = /^if\b/.test(rest.source) ? parseConditional(rest) : undefined
    if (!otherwise && rest.source[0] === '{') {
      const elseClose = findMatching(rest.source, 0, '{')
      if (skipTrivia(rest.source, elseClose + 1) !== rest.source.length) return undefined
      otherwise = parseMunBuilder(rest.source.slice(1, elseClose), rest.start + 1)
      end = elseStart + elseClose + 1
    } else if (otherwise) {
      end = otherwise.range.end - value.start
    }
  }
  if (skipTrivia(value.source, end) !== value.source.length) return undefined
  return {
    kind: 'conditional',
    condition: raw(conditionSlice),
    then: parseMunBuilder(thenSource, thenOffset),
    otherwise,
    range: { start: value.start, end: value.end },
  }
}

function parseNode(slice: Slice): MunBuilderNode {
  return parseConditional(slice) ?? parseCall(slice) ?? raw(slice)
}

/** Keep a top-level line comment from swallowing the comma synthesized by lowering. */
function protectLineComment(source: string): string {
  let parens = 0
  let brackets = 0
  let braces = 0
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]
    const next = source[i + 1]
    if (char === "'" || char === '"') { i = skipQuoted(source, i, char) - 1; continue }
    if (char === '`') { i = skipTemplate(source, i) - 1; continue }
    if (char === '/' && next === '/' && parens === 0 && brackets === 0 && braces === 0) {
      if (!source.slice(0, i).trim()) return ''
      return `${source.slice(0, i)}/*${source.slice(i + 2)}*/`
    }
    if (char === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2)
      if (end < 0) throw munSyntaxError('Unclosed block comment in Mun AST', i)
      i = end + 1
      continue
    }
    if (char === '/' && regexCanStartAfter(source, i)) { i = skipRegex(source, i) - 1; continue }
    if (char === '(') parens += 1
    else if (char === ')') parens -= 1
    else if (char === '[') brackets += 1
    else if (char === ']') brackets -= 1
    else if (char === '{') braces += 1
    else if (char === '}') braces -= 1
  }
  return source
}

/** Parse the Mun builder subset while retaining opaque TypeScript expressions verbatim. */
export function parseMunBuilder(source: string, baseOffset = 0): MunBuilderProgram {
  return {
    kind: 'program',
    source,
    range: { start: baseOffset, end: baseOffset + source.length },
    statements: splitTopLevel(source, ',;', baseOffset).map(parseNode),
  }
}

export interface MunStructDeclaration {
  readonly kind: 'struct'
  readonly name: string
  readonly genericParameters?: string
  readonly source: string
  readonly bodySource: string
  readonly bodyExpressionSource: string
  readonly range: MunSourceRange
  readonly bodyRange: MunSourceRange
  readonly bodyExpressionRange: MunSourceRange
  readonly fields: readonly MunStructField[]
  readonly initializers: readonly MunStructInitializer[]
}

export interface MunStructField {
  readonly name: string
  readonly kind: 'stored' | 'state' | 'binding'
  readonly type?: string
  readonly initializer?: string
  readonly range: MunSourceRange
}

export interface MunStructInitializer {
  readonly parametersSource: string
  readonly bodySource: string
  readonly range: MunSourceRange
  readonly parametersRange: MunSourceRange
  readonly bodyRange: MunSourceRange
}

function findStructKeyword(source: string, start: number): number {
  for (let index = start; index < source.length; index += 1) {
    const char = source[index]
    if (char === "'" || char === '"') { index = skipQuoted(source, index, char) - 1; continue }
    if (char === '`') { index = skipTemplate(source, index) - 1; continue }
    if (char === '/' && source[index + 1] === '/') {
      const newline = source.indexOf('\n', index + 2)
      index = (newline < 0 ? source.length : newline) - 1
      continue
    }
    if (char === '/' && source[index + 1] === '*') {
      const end = source.indexOf('*/', index + 2)
      if (end < 0) throw munSyntaxError('Unclosed block comment in Mun AST', index)
      index = end + 1
      continue
    }
    if (source.startsWith('struct', index)) {
      const before = source[index - 1]
      const after = source[index + 6]
      if (!(before && isIdentifierPart(before)) && !(after && isIdentifierPart(after))) return index
    }
  }
  return -1
}

function identifierAt(source: string, index: number): { name: string; end: number } | undefined {
  const match = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(source.slice(index))
  return match ? { name: match[0], end: index + match[0].length } : undefined
}

function findGenericEnd(source: string, openIndex: number): number {
  let depth = 0
  for (let i = openIndex; i < source.length; i += 1) {
    const char = source[i]
    if (char === "'" || char === '"') { i = skipQuoted(source, i, char) - 1; continue }
    if (char === '`') { i = skipTemplate(source, i) - 1; continue }
    if (char === '<') depth += 1
    if (char === '>' && --depth === 0) return i
  }
  throw munSyntaxError('Unclosed generic parameter list in Mun AST', openIndex)
}

function findMemberEnd(source: string, start: number): number {
  let parens = 0
  let brackets = 0
  let braces = 0
  for (let i = start; i < source.length; i += 1) {
    const char = source[i]
    const next = source[i + 1]
    if (char === "'" || char === '"') { i = skipQuoted(source, i, char) - 1; continue }
    if (char === '`') { i = skipTemplate(source, i) - 1; continue }
    if (char === '/' && next === '/') {
      const end = source.indexOf('\n', i + 2)
      if (parens === 0 && brackets === 0 && braces === 0) return end < 0 ? source.length : end
      i = (end < 0 ? source.length : end) - 1
      continue
    }
    if (char === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2)
      if (end < 0) throw munSyntaxError('Unclosed block comment in Mun AST', i)
      i = end + 1
      continue
    }
    if (char === '(') parens += 1
    else if (char === ')') parens -= 1
    else if (char === '[') brackets += 1
    else if (char === ']') brackets -= 1
    else if (char === '{') braces += 1
    else if (char === '}') {
      if (braces > 0) braces -= 1
      else if (parens === 0 && brackets === 0) return i
    }
    if (parens === 0 && brackets === 0 && braces === 0 && (char === ';' || char === '\n')) return i
  }
  return source.length
}

function parseStructMembers(source: string, baseOffset: number): {
  fields: MunStructField[]
  initializers: MunStructInitializer[]
} {
  const fields: MunStructField[] = []
  const initializers: MunStructInitializer[] = []
  let index = 0
  while (index < source.length) {
    index = skipTrivia(source, index)
    if (index >= source.length) break
    const init = /^init\b/.exec(source.slice(index))
    if (init) {
      const open = skipTrivia(source, index + init[0].length)
      if (source[open] === '(') {
        const close = findMatching(source, open, '(')
        const blockOpen = skipTrivia(source, close + 1)
        if (source[blockOpen] === '{') {
          const blockClose = findMatching(source, blockOpen, '{')
          initializers.push({
            parametersSource: source.slice(open + 1, close),
            bodySource: source.slice(blockOpen + 1, blockClose),
            range: { start: baseOffset + index, end: baseOffset + blockClose + 1 },
            parametersRange: { start: baseOffset + open + 1, end: baseOffset + close },
            bodyRange: { start: baseOffset + blockOpen + 1, end: baseOffset + blockClose },
          })
          index = blockClose + 1
          continue
        }
      }
    }
    const field = /^(?:(@State|@Binding)\s+)?(?:let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)\s*(?::\s*([\s\S]*?))?(?:\s*=\s*([\s\S]*))?$/.exec(
      source.slice(index, findMemberEnd(source, index)).trim(),
    )
    const end = findMemberEnd(source, index)
    if (field && field[2] !== 'body') {
      const declaration = source.slice(index, end).trim()
      const leading = source.slice(index, end).search(/\S|$/)
      const fieldStart = baseOffset + index + Math.max(0, leading)
      fields.push({
        name: field[2],
        kind: field[1] === '@State' ? 'state' : field[1] === '@Binding' ? 'binding' : 'stored',
        type: field[3]?.trim(),
        initializer: field[4]?.trim(),
        range: { start: fieldStart, end: fieldStart + declaration.length },
      })
      index = end + (source[end] === ';' || source[end] === '\n' ? 1 : 0)
      continue
    }
    // `var body: some View { ... }` is a member too, but its block is the
    // separately recorded body expression and must not become a stored field.
    if (/^var\s+body\b/.test(source.slice(index, end).trim())) {
      const bodyOpen = source.indexOf('{', index)
      if (bodyOpen >= 0 && bodyOpen < end) {
        index = end + (source[end] === ';' || source[end] === '\n' ? 1 : 0)
        continue
      }
    }
    index = Math.max(index + 1, end + 1)
  }
  return { fields, initializers }
}

/** Parse struct View declarations without interpreting TypeScript expressions inside them. */
export function parseMunStructs(source: string, baseOffset = 0): readonly MunStructDeclaration[] {
  const declarations: MunStructDeclaration[] = []
  let cursor = 0
  while (cursor < source.length) {
    const index = findStructKeyword(source, cursor)
    if (index < 0) break
    const nameStart = skipTrivia(source, index + 6)
    const identifier = identifierAt(source, nameStart)
    if (!identifier) {
      cursor = index + 6
      continue
    }
    let headerEnd = skipTrivia(source, identifier.end)
    let genericParameters: string | undefined
    if (source[headerEnd] === '<') {
      const genericEnd = findGenericEnd(source, headerEnd)
      genericParameters = source.slice(headerEnd + 1, genericEnd).trim()
      headerEnd = skipTrivia(source, genericEnd + 1)
    }
    const brace = source.indexOf('{', headerEnd)
    if (brace < 0) throw munSyntaxError(`Missing body for struct ${identifier.name}`, headerEnd + baseOffset)
    const close = findMatching(source, brace, '{')
    const bodySource = source.slice(brace + 1, close)
    const bodyMatch = /\bvar\s+body\s*:[^{]+\{/.exec(bodySource)
    if (!bodyMatch) throw munSyntaxError(`struct ${identifier.name} must declare var body`, index + baseOffset)
    const bodyOpen = bodySource.indexOf('{', bodyMatch.index! + bodyMatch[0].length - 1)
    const bodyClose = findMatching(bodySource, bodyOpen, '{')
    const bodyExpressionSource = bodySource.slice(bodyOpen + 1, bodyClose)
    const members = parseStructMembers(bodySource, baseOffset + brace + 1)
    declarations.push({
      kind: 'struct',
      name: identifier.name,
      genericParameters,
      source: source.slice(index, close + 1),
      bodySource,
      bodyExpressionSource,
      range: { start: baseOffset + index, end: baseOffset + close + 1 },
      bodyRange: { start: baseOffset + brace + 1, end: baseOffset + close },
      bodyExpressionRange: {
        start: baseOffset + brace + 1 + bodyOpen + 1,
        end: baseOffset + brace + 1 + bodyClose,
      },
      fields: members.fields,
      initializers: members.initializers,
    })
    cursor = close + 1
  }
  return declarations
}

export interface MunAstLowering {
  /** Lower an expression that is not itself a Mun builder node. */
  readonly transformRaw: (source: string) => string
  /** Lower a closure after its declaration kind has been inferred by the runtime. */
  readonly closure: (bodySource: string, parameter?: string) => string
}

function lowerClosure(value: MunClosureExpression, lowering: MunAstLowering): string {
  return lowering.closure(value.bodySource, value.parameter)
}

function lowerArgument(argument: MunArgument, lowering: MunAstLowering): string {
  const value = argument.value.kind === 'closure'
    ? lowerClosure(argument.value, lowering)
    : lowering.transformRaw(argument.value.source)
  return argument.label ? `${argument.label}: ${value}` : value
}

function lowerCall(node: MunCallExpression, lowering: MunAstLowering): string {
  const values = node.arguments.map(argument => lowerArgument(argument, lowering))
  const labeled = node.arguments.some(argument => argument.label)
  let argumentsSource = values.join(', ')
  if (labeled) {
    const positional = node.arguments.flatMap((argument, index) => argument.label ? [] : [values[index]])
    const named = node.arguments.flatMap((argument, index) => argument.label ? [values[index]] : [])
    const object = `namedArguments({ ${named.join(', ')} })`
    argumentsSource = positional.length > 0 ? `${positional.join(', ')}, ${object}` : object
  }
  if (node.trailing) {
    const trailing = lowerClosure(node.trailing, lowering)
    argumentsSource = argumentsSource ? `${argumentsSource}, ${trailing}` : trailing
  }
  return `${node.callee}(${argumentsSource})`
}

function lowerProgram(program: MunBuilderProgram, lowering: MunAstLowering): string[] {
  return program.statements.map(node => {
    if (node.kind === 'raw') return lowering.transformRaw(protectLineComment(node.source))
    if (node.kind === 'call') return lowerCall(node, lowering)
    const thenBranch = lowerProgram(node.then, lowering).join(', ')
    let elseBranch = '[]'
    if (node.otherwise) {
      elseBranch = 'kind' in node.otherwise && node.otherwise.kind === 'conditional'
        ? lowerConditional(node.otherwise, lowering)
        : `[${lowerProgram(node.otherwise, lowering).join(', ')}]`
    }
    return `(${lowering.transformRaw(node.condition.source)} ? [${thenBranch}] : ${elseBranch})`
  })
}

function lowerConditional(node: MunConditionalExpression, lowering: MunAstLowering): string {
  const thenBranch = lowerProgram(node.then, lowering).join(', ')
  let elseBranch = '[]'
  if (node.otherwise) {
    elseBranch = 'kind' in node.otherwise && node.otherwise.kind === 'conditional'
      ? lowerConditional(node.otherwise, lowering)
      : `[${lowerProgram(node.otherwise, lowering).join(', ')}]`
  }
  return `(${lowering.transformRaw(node.condition.source)} ? [${thenBranch}] : ${elseBranch})`
}

/** Lower a parsed builder program to normalized child expressions. */
export function lowerMunBuilderAst(program: MunBuilderProgram, lowering: MunAstLowering): string[] {
  return lowerProgram(program, lowering)
}

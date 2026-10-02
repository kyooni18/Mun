/** Half-open offsets in the original Mün source. */
export interface MunSourceRange {
  readonly start: number
  readonly end: number
}

export interface MunRawExpression {
  readonly kind: "raw"
  readonly source: string
  readonly range: MunSourceRange
}

export interface MunClosureExpression {
  readonly kind: "closure"
  readonly parameter?: string
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
  readonly kind: "call"
  readonly callee: string
  readonly arguments: readonly MunArgument[]
  readonly trailing?: MunClosureExpression
  readonly range: MunSourceRange
}

export interface MunConditionalExpression {
  readonly kind: "conditional"
  readonly condition: MunRawExpression
  readonly then: MunBuilderProgram
  readonly otherwise?: MunBuilderProgram | MunConditionalExpression
  readonly range: MunSourceRange
}

export type MunBuilderNode = MunRawExpression | MunCallExpression | MunConditionalExpression

export interface MunBuilderProgram {
  readonly kind: "program"
  readonly source: string
  readonly range: MunSourceRange
  readonly statements: readonly MunBuilderNode[]
}

interface Slice { readonly source: string; readonly start: number; readonly end: number }
type Delimiter = "(" | "{" | "["
const closing: Record<Delimiter, string> = { "(": ")", "{": "}", "[": "]" }
const regexAfterKeywords = new Set([
  "case", "delete", "do", "else", "in", "instanceof", "of", "return", "throw",
  "typeof", "void", "yield", "await",
])

function isRawHtmlClosingTag(source: string, index: number): boolean {
  if (source[index - 1] !== "<" || !/[A-Za-z]/.test(source[index + 1] ?? "")) return false
  let cursor = index + 2
  while (/[A-Za-z0-9:._-]/.test(source[cursor] ?? "")) cursor += 1
  while (/\s/.test(source[cursor] ?? "")) cursor += 1
  return source[cursor] === ">"
}

function syntaxError(message: string, offset: number): SyntaxError & { readonly offset: number } {
  const error = new SyntaxError(message) as SyntaxError & { offset: number }
  error.offset = offset
  return error
}

function identifierPart(value: string | undefined): boolean {
  return !!value && /[A-Za-z0-9_$]/.test(value)
}

function skipQuoted(source: string, index: number): number {
  const quote = source[index]
  for (let cursor = index + 1; cursor < source.length; cursor += 1) {
    if (source[cursor] === "\\") { cursor += 1; continue }
    if (source[cursor] === quote) return cursor + 1
  }
  throw syntaxError(`Unclosed ${quote} string in Mün source`, index)
}

function skipTemplate(source: string, index: number): number {
  for (let cursor = index + 1; cursor < source.length; cursor += 1) {
    if (source[cursor] === "\\") { cursor += 1; continue }
    if (source[cursor] === "`") return cursor + 1
    if (source[cursor] !== "$" || source[cursor + 1] !== "{") continue
    const close = findMatching(source, cursor + 1, "{")
    cursor = close
  }
  throw syntaxError("Unclosed template literal in Mün source", index)
}

function skipTrivia(source: string, index: number): number {
  let cursor = index
  while (cursor < source.length) {
    if (/\s/.test(source[cursor])) { cursor += 1; continue }
    if (source.startsWith("//", cursor) || source.startsWith("/*", cursor)) {
      cursor = skipComment(source, cursor)
      continue
    }
    break
  }
  return cursor
}

function skipComment(source: string, index: number): number {
  if (source.startsWith("//", index)) {
    const end = source.indexOf("\n", index + 2)
    return end < 0 ? source.length : end
  }
  const end = source.indexOf("*/", index + 2)
  if (end < 0) throw syntaxError("Unclosed block comment in Mün source", index)
  return end + 2
}

function regexCanStart(source: string, index: number): boolean {
  if (isRawHtmlClosingTag(source, index)) return false
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (/\s/.test(source[cursor])) continue
    if ("([{=,:;!?&|+-*%^~<>".includes(source[cursor])) return true
    if (/[A-Za-z_$]/.test(source[cursor])) {
      const end = cursor + 1
      while (cursor >= 0 && /[A-Za-z0-9_$]/.test(source[cursor])) cursor -= 1
      const word = source.slice(cursor + 1, end)
      // Same keyword set as the scanner: a regex literal may follow an
      // expression keyword, but not an identifier or property access.
      return regexAfterKeywords.has(word)
    }
    return false
  }
  return true
}

function skipRegex(source: string, index: number): number {
  let inClass = false
  for (let cursor = index + 1; cursor < source.length; cursor += 1) {
    if (source[cursor] === "\\") { cursor += 1; continue }
    if (source[cursor] === "[") inClass = true
    if (source[cursor] === "]") inClass = false
    if (source[cursor] === "/" && !inClass) {
      cursor += 1
      while (/[A-Za-z]/.test(source[cursor] ?? "")) cursor += 1
      return cursor
    }
    if (source[cursor] === "\n" || source[cursor] === "\r") throw syntaxError("Unclosed regular expression in Mün source", index)
  }
  throw syntaxError("Unclosed regular expression in Mün source", index)
}

function findMatching(source: string, openIndex: number, open: Delimiter): number {
  const stack: string[] = [open]
  for (let cursor = openIndex + 1; cursor < source.length; cursor += 1) {
    const character = source[cursor]
    const next = source[cursor + 1]
    if (character === "\"" || character === "'") { cursor = skipQuoted(source, cursor) - 1; continue }
    if (character === "`") { cursor = skipTemplate(source, cursor) - 1; continue }
    if (character === "/" && (next === "/" || next === "*")) { cursor = skipComment(source, cursor) - 1; continue }
    if (character === "/" && regexCanStart(source, cursor)) { cursor = skipRegex(source, cursor) - 1; continue }
    if (character === "(" || character === "{" || character === "[") { stack.push(character); continue }
    if (character === ")" || character === "}" || character === "]") {
      const expected = closing[stack[stack.length - 1] as Delimiter]
      if (character !== expected) throw syntaxError(`Unexpected ${character} in Mün source`, cursor)
      stack.pop()
      if (stack.length === 0) return cursor
    }
  }
  throw syntaxError(`Unclosed ${open} block in Mün source`, openIndex)
}

function lineBreakBoundary(source: string, index: number): boolean {
  let previousIndex = index - 1
  while (previousIndex >= 0 && /\s/.test(source[previousIndex])) previousIndex -= 1
  const previous = previousIndex >= 0 ? source[previousIndex] : undefined
  const nextIndex = skipTrivia(source, index + 1)
  const next = source[nextIndex]
  if (!previous || !next) return true
  if (source.slice(nextIndex, nextIndex + 4) === "else") return false
  if (",([{.=:+-*/%!&|?<>".includes(previous)) return false
  if (".),]}:;".includes(next)) return false
  return true
}

function splitTopLevel(source: string, separators: string, baseOffset: number): Slice[] {
  const parts: Slice[] = []
  let start = 0
  const stack: string[] = []
  for (let cursor = 0; cursor < source.length; cursor += 1) {
    const character = source[cursor]
    const next = source[cursor + 1]
    if (character === "\"" || character === "'") { cursor = skipQuoted(source, cursor) - 1; continue }
    if (character === "`") { cursor = skipTemplate(source, cursor) - 1; continue }
    if (character === "/" && (next === "/" || next === "*")) { cursor = skipComment(source, cursor) - 1; continue }
    if (character === "/" && regexCanStart(source, cursor)) { cursor = skipRegex(source, cursor) - 1; continue }
    if (character === "(" || character === "{" || character === "[") stack.push(character)
    else if (character === ")" || character === "}" || character === "]") {
      if (stack.length > 0) stack.pop()
    }
    const boundary = stack.length === 0 && (separators.includes(character) || (character === "\n" && lineBreakBoundary(source, cursor)))
    if (boundary) {
      parts.push({ source: source.slice(start, cursor), start: baseOffset + start, end: baseOffset + cursor })
      start = cursor + 1
    }
  }
  parts.push({ source: source.slice(start), start: baseOffset + start, end: baseOffset + source.length })
  return parts.filter(part => part.source.trim().length > 0)
}

function trimSlice(slice: Slice): Slice {
  const leading = slice.source.search(/\S|$/)
  const trimmed = slice.source.trimEnd()
  return { source: trimmed.slice(leading), start: slice.start + leading, end: slice.start + trimmed.length }
}

function raw(slice: Slice): MunRawExpression {
  const value = trimSlice(slice)
  return { kind: "raw", source: value.source, range: { start: value.start, end: value.end } }
}

function parseClosure(slice: Slice): MunClosureExpression | undefined {
  const value = trimSlice(slice)
  if (value.source[0] !== "{") return undefined
  const close = findMatching(value.source, 0, "{")
  if (close !== value.source.length - 1) return undefined
  const inner = value.source.slice(1, close)
  const parameter = /^\s*([A-Za-z_$][A-Za-z0-9_$]*)\s+in\s+/.exec(inner)
  // A direct object argument is not a Mun closure. Check the first member
  // rather than any colon: closure bodies legitimately contain ternaries.
  if (!parameter && /^(?:\s*(?:[A-Za-z_$][A-Za-z0-9_$]*|["'][^"']*["']|-?\d+(?:\.\d+)?)\s*:)/.test(inner)) return undefined
  const bodySource = parameter ? inner.slice(parameter[0].length) : inner
  const bodyOffset = value.start + 1 + (parameter ? parameter[0].length : 0)
  return {
    kind: "closure",
    parameter: parameter?.[1],
    bodySource,
    body: parseMunBuilder(bodySource, bodyOffset),
    range: { start: value.start, end: value.end },
  }
}

function topLevelColon(source: string): number {
  const slices = splitTopLevel(source, ":", 0)
  return slices.length > 1 ? slices[0].source.length : -1
}

function parseArgument(slice: Slice): MunArgument {
  const value = trimSlice(slice)
  const colon = topLevelColon(value.source)
  const labelStart = skipTrivia(value.source, 0)
  const label = colon < 0 ? undefined : value.source.slice(labelStart, colon).trim()
  if (label && !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(label)) return { value: raw(value), range: { start: value.start, end: value.end } }
  const valueSlice: Slice = colon < 0
    ? value
    : { source: value.source.slice(colon + 1), start: value.start + colon + 1, end: value.end }
  return { label, value: parseClosure(valueSlice) ?? raw(valueSlice), range: { start: value.start, end: value.end } }
}

function parseCall(slice: Slice): MunCallExpression | undefined {
  const value = trimSlice(slice)
  const identifier = /^([A-Za-z_$][A-Za-z0-9_$]*)/.exec(value.source)
  if (!identifier) return undefined
  const open = skipTrivia(value.source, identifier[0].length)
  // Swift allows a call with only a trailing closure: `ZStack { … }`.
  if (value.source[open] === "{" && /^[A-Z]/.test(identifier[1])) {
    const trailingClose = findMatching(value.source, open, "{")
    if (skipTrivia(value.source, trailingClose + 1) !== value.source.length) return undefined
    const trailing = parseClosure({ source: value.source.slice(open, trailingClose + 1), start: value.start + open, end: value.start + trailingClose + 1 })
    if (!trailing) return undefined
    return { kind: "call", callee: identifier[1], arguments: [], trailing, range: { start: value.start, end: value.end } }
  }
  if (value.source[open] !== "(") return undefined
  const close = findMatching(value.source, open, "(")
  const afterClose = skipTrivia(value.source, close + 1)
  let trailing: MunClosureExpression | undefined
  let end = close + 1
  if (value.source[afterClose] === "{") {
    const trailingClose = findMatching(value.source, afterClose, "{")
    if (skipTrivia(value.source, trailingClose + 1) !== value.source.length) return undefined
    trailing = parseClosure({ source: value.source.slice(afterClose, trailingClose + 1), start: value.start + afterClose, end: value.start + trailingClose + 1 })
    // A block after a call is only Mun syntax when it is a closure. Do not
    // consume an object-like block and silently drop it from the generated
    // TypeScript when the source is ordinary or malformed JavaScript.
    if (!trailing) return undefined
    end = trailingClose + 1
  }
  if (skipTrivia(value.source, end) !== value.source.length) return undefined
  return {
    kind: "call",
    callee: identifier[1],
    arguments: splitTopLevel(value.source.slice(open + 1, close), ",", value.start + open + 1).map(parseArgument),
    trailing,
    range: { start: value.start, end: value.end },
  }
}

function parseConditional(slice: Slice): MunConditionalExpression | undefined {
  const value = trimSlice(slice)
  if (!/^if\b/.test(value.source)) return undefined

  const conditionStart = skipTrivia(value.source, 2)
  let conditionSourceStart = conditionStart
  let conditionEnd: number
  let thenOpen: number

  if (value.source[conditionStart] === "(") {
    const close = findMatching(value.source, conditionStart, "(")
    conditionSourceStart = conditionStart + 1
    conditionEnd = close
    thenOpen = skipTrivia(value.source, close + 1)
  } else {
    let parenDepth = 0
    let bracketDepth = 0
    let cursor = conditionStart
    for (; cursor < value.source.length; cursor += 1) {
      const character = value.source[cursor]
      if (character === "\"" || character === "'" || character === "`") {
        cursor = skipQuoted(value.source, cursor) - 1
        continue
      }
      if (character === "(") parenDepth += 1
      else if (character === ")") parenDepth -= 1
      else if (character === "[") bracketDepth += 1
      else if (character === "]") bracketDepth -= 1
      else if (character === "{" && parenDepth === 0 && bracketDepth === 0) break
    }
    if (cursor >= value.source.length) return undefined
    thenOpen = cursor
    conditionEnd = cursor
  }

  if (value.source[thenOpen] !== "{") return undefined
  const thenClose = findMatching(value.source, thenOpen, "{")
  const afterThen = skipTrivia(value.source, thenClose + 1)
  const condition = raw({
    source: value.source.slice(conditionSourceStart, conditionEnd),
    start: value.start + conditionSourceStart,
    end: value.start + conditionEnd,
  })
  let otherwise: MunBuilderProgram | MunConditionalExpression | undefined
  if (value.source.slice(afterThen, afterThen + 4) === "else" && !/[A-Za-z0-9_$]/.test(value.source[afterThen + 4] ?? "")) {
    const elseStart = skipTrivia(value.source, afterThen + 4)
    const rest = { source: value.source.slice(elseStart), start: value.start + elseStart, end: value.end }
    if (/^if\b/.test(rest.source)) {
      otherwise = parseConditional(rest)
      if (!otherwise) return undefined
    }
    else if (rest.source[0] === "{") {
      const elseClose = findMatching(rest.source, 0, "{")
      if (skipTrivia(rest.source, elseClose + 1) !== rest.source.length) return undefined
      otherwise = parseMunBuilder(rest.source.slice(1, elseClose), rest.start + 1)
    } else return undefined
  } else if (afterThen !== value.source.length) {
    // Keep parser ownership of the entire slice. Without this guard, a
    // conditional followed by another expression is accepted and the suffix
    // disappears during AST lowering.
    return undefined
  }
  return {
    kind: "conditional",
    condition,
    then: parseMunBuilder(value.source.slice(thenOpen + 1, thenClose), value.start + thenOpen + 1),
    otherwise,
    range: { start: value.start, end: value.end },
  }
}

/**
 * Swift `switch` over a scalar subject, desugared to an `if`/`else if` chain:
 * `case 1, 2:` becomes `subject == 1 || subject == 2`. Patterns are literals;
 * other Swift patterns are diagnosed. Like Swift, the switch must be
 * exhaustive (a `default:` unless the cases are `true` and `false`).
 */
function parseSwitch(slice: Slice): MunConditionalExpression | MunBuilderProgram | undefined {
  const value = trimSlice(slice)
  if (!/^switch\b/.test(value.source)) return undefined
  let open = -1
  for (let cursor = 6, depth = 0; cursor < value.source.length; cursor += 1) {
    const character = value.source[cursor]
    if (character === "\"" || character === "'") { cursor = skipQuoted(value.source, cursor) - 1; continue }
    if (character === "(" || character === "[") depth += 1
    else if (character === ")" || character === "]") depth -= 1
    else if (character === "{" && depth === 0) { open = cursor; break }
  }
  if (open < 0) throw new SyntaxError("switch requires a { case … } body")
  const close = findMatching(value.source, open, "{")
  if (skipTrivia(value.source, close + 1) !== value.source.length) return undefined
  const subject = value.source.slice(6, open).trim().replace(/^\(([\s\S]*)\)$/, "$1").trim()
  if (!subject) throw new SyntaxError("switch requires a subject expression")
  const body = value.source.slice(open + 1, close)
  const bodyStart = value.start + open + 1

  // Labels (`case …:` / `default:`) at statement starts of the switch body.
  const labels: { start: number; colon: number; pattern?: string }[] = []
  let lineStart = true
  for (let cursor = 0, depth = 0; cursor < body.length; cursor += 1) {
    const character = body[cursor]
    if (character === "\"" || character === "'") { cursor = skipQuoted(body, cursor) - 1; lineStart = false; continue }
    if (character === "\n" || character === ";") { lineStart = true; continue }
    if (/\s/.test(character)) continue
    if ("([{".includes(character)) depth += 1
    else if (")]}".includes(character)) depth -= 1
    if (depth === 0 && lineStart && /^(?:case\b|default\s*:)/.test(body.slice(cursor))) {
      const isDefault = body.startsWith("default", cursor)
      let colon = -1
      for (let scan = cursor + (isDefault ? 7 : 4), inner = 0; scan < body.length; scan += 1) {
        const next = body[scan]
        if (next === "\"" || next === "'") { scan = skipQuoted(body, scan) - 1; continue }
        if ("([{".includes(next)) inner += 1
        else if (")]}".includes(next)) inner -= 1
        else if (next === ":" && inner === 0) { colon = scan; break }
      }
      if (colon < 0) throw new SyntaxError("switch case label requires ':'")
      labels.push({ start: cursor, colon, ...(isDefault ? {} : { pattern: body.slice(cursor + 4, colon).trim() }) })
      cursor = colon
    }
    lineStart = false
  }
  if (labels.length === 0) throw new SyntaxError("switch requires at least one case")
  if (body.slice(0, labels[0].start).trim()) throw new SyntaxError("switch body must start with a case label")

  const seen = new Set<string>()
  const cases = labels.map((label, index) => {
    const end = labels[index + 1]?.start ?? body.length
    const caseSource = body.slice(label.colon + 1, end)
    if (!caseSource.trim()) {
      throw new SyntaxError(`switch ${label.pattern === undefined ? "default" : `case ${label.pattern}`} has no Views; every case needs at least one`)
    }
    const program = parseMunBuilder(caseSource, bodyStart + label.colon + 1)
    if (label.pattern === undefined) {
      if (index !== labels.length - 1) throw new SyntaxError("switch default must be the last case")
      return { program }
    }
    const patterns = splitTopLevel(label.pattern, ",", 0).map(item => item.source.trim())
    for (const pattern of patterns) {
      if (/\bwhere\b/.test(pattern)) throw new SyntaxError(`switch case 'where' clauses are not supported in Mün: case ${label.pattern}`)
      if (/\.\.[.<]/.test(pattern)) throw new SyntaxError(`switch range patterns are not supported in Mün; use if with comparisons: case ${pattern}`)
      if (!/^(?:-?\d+(?:\.\d+)?|"(?:[^"\\]|\\.)*"|true|false)$/.test(pattern)) {
        throw new SyntaxError(`switch case patterns must be String, number or Bool literals in Mün: case ${pattern}`)
      }
      if (seen.has(pattern)) throw new SyntaxError(`switch case ${pattern} is repeated`)
      seen.add(pattern)
    }
    if (/^\s*fallthrough\b/m.test(caseSource)) throw new SyntaxError("fallthrough is not supported in Mün switch")
    return { patterns, program }
  })
  const exhaustive = cases.at(-1)?.patterns === undefined || (seen.has("true") && seen.has("false") && seen.size === 2)
  if (!exhaustive) throw new SyntaxError(`switch over '${subject}' must be exhaustive: add a default case`)

  const range = { start: value.start, end: value.end }
  const chain = (index: number): MunConditionalExpression | MunBuilderProgram => {
    const item = cases[index]
    if (!item.patterns) return item.program
    if (index === cases.length - 1) return item.program
    const condition = item.patterns.map(pattern => `(${subject}) == ${pattern}`).join(" || ")
    return {
      kind: "conditional",
      condition: { kind: "raw", source: condition, range },
      then: item.program,
      otherwise: chain(index + 1),
      range,
    }
  }
  return chain(0)
}

function parseNode(slice: Slice): MunBuilderNode {
  const switched = parseSwitch(slice)
  if (switched) {
    // A switch whose only case is `default` is just its Views.
    return switched.kind === "program"
      ? { kind: "conditional", condition: { kind: "raw", source: "true", range: switched.range }, then: switched, range: switched.range }
      : switched
  }
  return parseConditional(slice) ?? parseCall(slice) ?? raw(slice)
}

export function parseMunBuilder(source: string, baseOffset = 0): MunBuilderProgram {
  return { kind: "program", source, range: { start: baseOffset, end: baseOffset + source.length }, statements: splitTopLevel(source, ",;", baseOffset).map(parseNode) }
}

export interface MunStructDeclaration {
  readonly kind: "struct"
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
  readonly nested?: readonly MunStructDeclaration[]
}

export interface MunStructField {
  readonly name: string
  readonly kind: "stored" | "state" | "binding"
  /** Swift access level as written; `private`/`fileprivate` members are not memberwise-initializable. */
  readonly access?: "private" | "fileprivate" | "internal" | "public"
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

function findStructs(source: string, start: number): number {
  for (let cursor = start; cursor < source.length; cursor += 1) {
    const character = source[cursor]
    const next = source[cursor + 1]
    if (character === "\"" || character === "'") { cursor = skipQuoted(source, cursor) - 1; continue }
    if (character === "`") { cursor = skipTemplate(source, cursor) - 1; continue }
    if (character === "/" && (next === "/" || next === "*")) { cursor = skipComment(source, cursor) - 1; continue }
    if (character === "/" && regexCanStart(source, cursor)) { cursor = skipRegex(source, cursor) - 1; continue }
    if (!source.startsWith("struct", cursor)) continue
    if (identifierPart(source[cursor - 1]) || identifierPart(source[cursor + 6])) continue
    return cursor
  }
  return -1
}

interface StructBodyExpression {
  readonly declarationStart: number
  readonly open: number
  readonly close: number
}

function findTopLevelBodyExpression(source: string): StructBodyExpression | undefined {
  let braces = 0
  for (let cursor = 0; cursor < source.length; cursor += 1) {
    const character = source[cursor]
    const next = source[cursor + 1]
    if (character === "\"" || character === "'") { cursor = skipQuoted(source, cursor) - 1; continue }
    if (character === "`") { cursor = skipTemplate(source, cursor) - 1; continue }
    if (character === "/" && (next === "/" || next === "*")) { cursor = skipComment(source, cursor) - 1; continue }
    if (character === "/" && regexCanStart(source, cursor)) { cursor = skipRegex(source, cursor) - 1; continue }
    if (braces === 0 && source.startsWith("var", cursor) && !identifierPart(source[cursor - 1]) && !identifierPart(source[cursor + 3])) {
      const match = /^var\s+body\s*:[^{]*\{/.exec(source.slice(cursor))
      if (match) {
        const open = cursor + match[0].lastIndexOf("{")
        return { declarationStart: cursor, open, close: findMatching(source, open, "{") }
      }
    }
    if (character === "{") braces += 1
    else if (character === "}") braces -= 1
  }
  return undefined
}

function maskNestedStructs(source: string): string {
  const characters = [...source]
  let cursor = 0
  while (cursor < source.length) {
    const index = findStructs(source, cursor)
    if (index < 0) break
    const header = /^struct\s+([A-Za-z_$][A-Za-z0-9_$]*)(?:\s*<([^>{}]*)>)?\s*:\s*View\b/.exec(source.slice(index))
    if (!header) { cursor = index + 6; continue }
    const brace = source.indexOf("{", index + header[0].length)
    if (brace < 0) break
    const close = findMatching(source, brace, "{")
    for (let position = index; position <= close; position += 1) {
      if (characters[position] !== "\n" && characters[position] !== "\r") characters[position] = " "
    }
    cursor = close + 1
  }
  return characters.join("")
}

function maskInitializerBodies(source: string): string {
  const masked = [...source]
  let cursor = 0
  while (true) {
    const initializer = findInitializer(source, cursor)
    if (initializer < 0) break
    const open = skipTrivia(source, initializer + 4)
    const close = findMatching(source, open, "(")
    const blockOpen = skipTrivia(source, close + 1)
    if (source[blockOpen] !== "{") { cursor = initializer + 4; continue }
    const blockClose = findMatching(source, blockOpen, "{")
    for (let index = initializer; index <= blockClose; index += 1) {
      if (masked[index] !== "\n" && masked[index] !== "\r") masked[index] = " "
    }
    cursor = blockClose + 1
  }
  return masked.join("")
}

function findInitializer(source: string, start: number): number {
  for (let cursor = start; cursor < source.length; cursor += 1) {
    const character = source[cursor]
    const next = source[cursor + 1]
    if (character === "\"" || character === "'") { cursor = skipQuoted(source, cursor) - 1; continue }
    if (character === "`") { cursor = skipTemplate(source, cursor) - 1; continue }
    if (character === "/" && (next === "/" || next === "*")) { cursor = skipComment(source, cursor) - 1; continue }
    if (character === "/" && regexCanStart(source, cursor)) { cursor = skipRegex(source, cursor) - 1; continue }
    if (!source.startsWith("init", cursor) || identifierPart(source[cursor - 1]) || identifierPart(source[cursor + 4])) continue
    if (source[skipTrivia(source, cursor + 4)] === "(") return cursor
  }
  return -1
}

/** End of a stored-property initializer: the first top-level newline or `;`. */
function initializerEnd(source: string, start: number): number {
  let depth = 0
  for (let cursor = start; cursor < source.length; cursor += 1) {
    const character = source[cursor]
    const next = source[cursor + 1]
    if (character === "\"" || character === "'") { cursor = skipQuoted(source, cursor) - 1; continue }
    if (character === "`") { cursor = skipTemplate(source, cursor) - 1; continue }
    if (character === "/" && (next === "/" || next === "*")) { cursor = skipComment(source, cursor) - 1; continue }
    if (character === "(" || character === "[" || character === "{") depth += 1
    else if (character === ")" || character === "]" || character === "}") {
      if (depth === 0) return cursor
      depth -= 1
    } else if (depth === 0 && (character === "\n" || character === ";")) return cursor
  }
  return source.length
}

function parseStructMembers(body: string, baseOffset: number): { fields: MunStructField[]; initializers: MunStructInitializer[] } {
  const fields: MunStructField[] = []
  const initializers: MunStructInitializer[] = []
  const nestedMaskedBody = maskNestedStructs(body)
  const maskedBody = maskInitializerBodies(nestedMaskedBody)
  // `=` starts a stored-property initializer, but the same character is also
  // part of a TypeScript function type (`(value: string) => void`). Keep `=>`
  // inside the type span instead of truncating the type and inventing a
  // default value such as `> void`.
  // `@State private var`, `private @State var`, `private let` …
  const fieldPattern = /(?:^|[;\n])\s*(?:(private|fileprivate|internal|public)\s+)?(?:(@State|@Binding)\s+)?(?:(private|fileprivate|internal|public)\s+)?(?:let|var)\s+([A-Za-z_$][A-Za-z0-9_$]*)(?:\s*:\s*((?:(?:=>)|[^=\n;])+))?(?:\s*=(?!>)\s*([^\n;]+))?/g
  for (const match of maskedBody.matchAll(fieldPattern)) {
    const [, accessBefore, wrapper, accessAfter, name, type, initializerSource] = match
    if (name === "body") continue
    if (accessBefore && accessAfter) throw new SyntaxError(`Member '${name}' declares its access level twice`)
    const access = (accessBefore ?? accessAfter) as MunStructField["access"]
    const start = baseOffset + (match.index ?? 0) + match[0].indexOf(name, match[0].search(/\b(?:let|var)\s/) + 4)
    // An initializer may span lines inside brackets (`[\n { ... },\n]`); the
    // regex only sees its first line, so read the balanced extent.
    const initializerStart = initializerSource === undefined ? undefined : (match.index ?? 0) + match[0].length - initializerSource.length
    const initializer = initializerStart === undefined
      ? undefined
      : body.slice(initializerStart, initializerEnd(maskedBody, initializerStart)).trim()
    fields.push({ name, kind: wrapper === "@State" ? "state" : wrapper === "@Binding" ? "binding" : "stored", ...(access ? { access } : {}), type: type?.trim(), initializer, range: { start, end: start + name.length } })
  }
  let cursor = 0
  while (true) {
    const initializer = findInitializer(nestedMaskedBody, cursor)
    if (initializer < 0) break
    const open = skipTrivia(nestedMaskedBody, initializer + 4)
    const close = findMatching(nestedMaskedBody, open, "(")
    const blockOpen = skipTrivia(nestedMaskedBody, close + 1)
    if (nestedMaskedBody[blockOpen] !== "{") { cursor = initializer + 4; continue }
    const blockClose = findMatching(nestedMaskedBody, blockOpen, "{")
    initializers.push({
      parametersSource: body.slice(open + 1, close),
      bodySource: body.slice(blockOpen + 1, blockClose),
      range: { start: baseOffset + initializer, end: baseOffset + blockClose + 1 },
      parametersRange: { start: baseOffset + open + 1, end: baseOffset + close },
      bodyRange: { start: baseOffset + blockOpen + 1, end: baseOffset + blockClose },
    })
    cursor = blockClose + 1
  }
  return { fields, initializers }
}

export function parseMunStructs(source: string, baseOffset = 0): readonly MunStructDeclaration[] {
  const declarations: MunStructDeclaration[] = []
  let cursor = 0
  while (cursor < source.length) {
    const index = findStructs(source, cursor)
    if (index < 0) break
    const header = /^struct\s+([A-Za-z_$][A-Za-z0-9_$]*)(?:\s*<([^>{}]*)>)?\s*:\s*View\b/.exec(source.slice(index))
    if (!header) { cursor = index + 6; continue }
    const brace = source.indexOf("{", index + header[0].length)
    if (brace < 0) throw syntaxError(`Missing body for struct ${header[1]}`, baseOffset + index)
    const close = findMatching(source, brace, "{")
    const bodySource = source.slice(brace + 1, close)
    const bodyExpression = findTopLevelBodyExpression(bodySource)
    if (!bodyExpression) throw syntaxError(`struct ${header[1]} must declare var body`, baseOffset + index)
    const members = parseStructMembers(bodySource.slice(0, bodyExpression.declarationStart), baseOffset + brace + 1)
    const nested = parseMunStructs(bodySource, baseOffset + brace + 1)
    declarations.push({
      kind: "struct",
      name: header[1],
      genericParameters: header[2]?.trim(),
      source: source.slice(index, close + 1),
      bodySource,
      bodyExpressionSource: bodySource.slice(bodyExpression.open + 1, bodyExpression.close),
      range: { start: baseOffset + index, end: baseOffset + close + 1 },
      bodyRange: { start: baseOffset + brace + 1, end: baseOffset + close },
      bodyExpressionRange: { start: baseOffset + brace + 1 + bodyExpression.open + 1, end: baseOffset + brace + 1 + bodyExpression.close },
      fields: members.fields,
      initializers: members.initializers,
      nested,
    })
    cursor = close + 1
  }
  return declarations
}

export interface MunAstLowering {
  readonly transformRaw: (source: string) => string
  readonly transformArgument?: (source: string, call: MunCallExpression, argumentIndex: number, label?: string) => string
  readonly closure: (bodySource: string, parameter?: string, role?: "value" | "viewBuilder" | "action") => string
  readonly closureRole?: (
    call: MunCallExpression,
    context: { readonly position: "argument" | "trailing"; readonly argumentIndex?: number; readonly label?: string },
  ) => "value" | "viewBuilder" | "action" | undefined
}

function lowerProgram(program: MunBuilderProgram, lowering: MunAstLowering): string[] {
  return program.statements.map(node => {
    if (node.kind === "raw") return lowering.transformRaw(node.source)
    if (node.kind === "call") {
      const positional = node.arguments.filter(argument => !argument.label).map((argument, argumentIndex) => argument.value.kind === "closure"
        ? lowering.closure(
            argument.value.bodySource,
            argument.value.parameter,
            lowering.closureRole?.(node, { position: "argument", argumentIndex, label: argument.label }),
          )
        : lowering.transformArgument?.(argument.value.source, node, argumentIndex, argument.label) ?? lowering.transformRaw(argument.value.source))
      const named = node.arguments.filter(argument => argument.label).map((argument, argumentIndex) => `${argument.label}: ${argument.value.kind === "closure"
        ? lowering.closure(
            argument.value.bodySource,
            argument.value.parameter,
            lowering.closureRole?.(node, { position: "argument", argumentIndex, label: argument.label }),
          )
        : lowering.transformArgument?.(argument.value.source, node, argumentIndex, argument.label) ?? lowering.transformRaw(argument.value.source)}`)
      const args = [...positional, ...(named.length ? [`namedArguments({ ${named.join(", ")} })`] : []), ...(node.trailing ? [lowering.closure(
        node.trailing.bodySource,
        node.trailing.parameter,
        lowering.closureRole?.(node, { position: "trailing" }),
      )] : [])]
      return `${node.callee}(${args.join(", ")})`
    }
    const thenBranch = lowerProgram(node.then, lowering).join(", ")
    const otherwise = !node.otherwise ? "[]" : node.otherwise.kind === "conditional" ? lowerProgram({ ...node.otherwise.then, statements: [node.otherwise] }, lowering)[0] : `[${lowerProgram(node.otherwise, lowering).join(", ")}]`
    return `(${lowering.transformRaw(node.condition.source)} ? [${thenBranch}] : ${otherwise})`
  })
}

export function lowerMunBuilderAst(program: MunBuilderProgram, lowering: MunAstLowering): string[] {
  return lowerProgram(program, lowering)
}

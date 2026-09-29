export interface BuilderCall {
  readonly start: number
  readonly open: number
  readonly close: number
  readonly brace: number
  readonly end: number
  readonly name: string
  readonly argumentSource: string
  readonly bodySource: string
}

export interface RawHtmlCall {
  readonly start: number
  readonly end: number
  readonly code: string
}

// These scanners run over the same source repeatedly during a transform. Keep
// the small lexical lookup tables module-scoped so hot paths do not allocate a
// Set for every slash or builder candidate.
const regexAfterKeywords = new Set([
  "case", "delete", "do", "else", "in", "instanceof", "of", "return", "throw",
  "typeof", "void", "yield", "await",
])
const rawHtmlAfterExpressionCharacters = ")]}"
const excludedBuilderNames = new Set(["if", "for", "while", "switch", "catch", "function"])
const rawHtmlExpressionKeywords = new Set(["await", "case", "else", "return", "throw", "yield"])

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
    cursor = matching(source, cursor + 1, "{", "}")
  }
  throw syntaxError("Unclosed template literal in Mün source", index)
}

function skipString(source: string, index: number): number {
  return source[index] === "`" ? skipTemplate(source, index) : skipQuoted(source, index)
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
  // A raw HTML closing tag (`</span>`) is encountered by several lightweight
  // scanners that do not run the full HTML parser first. It looks like a
  // regular expression after `<`, so exclude the exact closing-tag shape
  // before applying JavaScript's slash heuristic.
  if (isRawHtmlClosingTag(source, index)) return false
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (/\s/.test(source[cursor])) continue
    if ("([{=,:;!?&|+-*%^~<>".includes(source[cursor])) return true
    if (/[A-Za-z_$]/.test(source[cursor])) {
      const end = cursor + 1
      while (cursor >= 0 && /[A-Za-z0-9_$]/.test(source[cursor])) cursor -= 1
      const word = source.slice(cursor + 1, end)
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
    if (source[cursor] === "\n" || source[cursor] === "\r") {
      throw syntaxError("Unclosed regular expression in Mün source", index)
    }
  }
  throw syntaxError("Unclosed regular expression in Mün source", index)
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

function matching(source: string, open: number, left: string, right: string): number {
  let depth = 0
  let steps = 0
  for (let cursor = open; cursor < source.length; cursor += 1) {
    if (++steps > source.length + 1) throw syntaxError(`Unable to scan ${left} block in Mün source`, open)
    const character = source[cursor]
    if (character === "\"" || character === "'" || character === "`") { cursor = skipString(source, cursor) - 1; continue }
    if (character === "/" && (source[cursor + 1] === "/" || source[cursor + 1] === "*")) { cursor = skipComment(source, cursor) - 1; continue }
    if (character === "/" && regexCanStart(source, cursor)) { cursor = skipRegex(source, cursor) - 1; continue }
    if (character === left) depth += 1
    if (character === right) {
      depth -= 1
      if (depth === 0) return cursor
    }
  }
  throw syntaxError(`Unclosed ${left} block in Mün source`, open)
}

function identifierAt(source: string, start: number): { name: string; end: number } | undefined {
  const match = /^[A-Za-z_$][A-Za-z0-9_$]*/.exec(source.slice(start))
  return match ? { name: match[0], end: start + match[0].length } : undefined
}

/**
 * A less-than token is only a raw HTML opener in an expression-start
 * position. Keeping this decision here prevents generic calls and ordinary
 * comparisons from leaking into the HTML parser.
 */
function isRawHtmlCandidate(source: string, start: number): boolean {
  if (source[start] !== "<" || source[start + 1] === "/" || source[start + 1] === "!") return false
  if (!/^[A-Za-z]/.test(source[start + 1] ?? "")) return false
  // `<T>(value)` and `<T extends U>(value)` are TypeScript generic calls or
  // assertions. A real opening element continues with attributes/text or a
  // closing tag, not an immediately following call parenthesis.
  const possibleGenericClose = source.indexOf(">", start + 1)
  if (possibleGenericClose >= 0) {
    let afterClose = possibleGenericClose + 1
    while (afterClose < source.length && /\s/.test(source[afterClose])) afterClose += 1
    if (source[afterClose] === "(") return false
    const tagName = /^[A-Za-z][A-Za-z0-9:._-]*/.exec(source.slice(start + 1))?.[0]
    const hasMatchingClosingTag = tagName ? source.slice(possibleGenericClose + 1).includes(`</${tagName}`) : false
    // TypeScript's angle-bracket assertion `<Foo>value` is still valid in
    // `.ts` files. Prefer that interpretation for an uppercase type name
    // when no matching closing tag exists. Actual `<Foo>...</Foo>` raw HTML
    // remains unambiguous.
    if (tagName && /^[A-Z]/.test(tagName)
      && !hasMatchingClosingTag
      && /[A-Za-z_$0-9('"`[!+~-]/.test(source[afterClose] ?? "")) return false
  }
  let cursor = start - 1
  while (cursor >= 0 && /\s/.test(source[cursor])) cursor -= 1
  if (cursor < 0) return true
  const startsNewLine = source.lastIndexOf("\n", start - 1) > cursor
  const openingName = /^[A-Za-z][A-Za-z0-9:._-]*/.exec(source.slice(start + 1))?.[0]
  const openingClose = source.indexOf(">", start + 1)
  if (startsNewLine && openingName && openingClose >= 0
    && source.slice(openingClose + 1).includes(`</${openingName}`)) return true
  // A tag at the beginning of a new statement may follow a completed call,
  // array, or object expression on the previous line.
  if (startsNewLine && rawHtmlAfterExpressionCharacters.includes(source[cursor])) return true
  if ("([{=,:;!?&|+-*%^~;".includes(source[cursor])) return true
  if (!/[A-Za-z0-9_$.)\]]/.test(source[cursor])) return true
  const end = cursor + 1
  while (cursor >= 0 && /[A-Za-z0-9_$]/.test(source[cursor])) cursor -= 1
  const word = source.slice(cursor + 1, end)
  return rawHtmlExpressionKeywords.has(word)
}


export function previousSignificantCharacter(source: string, index: number): string | undefined {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (!/\s/.test(source[cursor])) return source[cursor]
  }
  return undefined
}

/**
 * Read only the immediately preceding identifier. Callers use this instead
 * of materializing `source.slice(0, index).trimEnd()` for every candidate in
 * a source-wide scan. The result is intentionally lexical and does not skip
 * comments; it matches the old prefix check while keeping the work bounded
 * by the size of one token.
 */
export function previousWord(source: string, index: number): string | undefined {
  let cursor = index - 1
  while (cursor >= 0 && /\s/.test(source[cursor])) cursor -= 1
  const end = cursor + 1
  while (cursor >= 0 && /[A-Za-z0-9_$]/.test(source[cursor])) cursor -= 1
  return end > cursor + 1 ? source.slice(cursor + 1, end) : undefined
}

type BraceContext = "class" | "object" | "block"

interface BraceFrame {
  readonly context: BraceContext
  readonly parenDepth: number
  readonly bracketDepth: number
}

function braceContext(source: string, index: number): BraceContext {
  const prefix = source.slice(Math.max(0, index - 160), index).trimEnd()
  if (/\b(?:class|interface|enum|namespace)\s+[A-Za-z_$][A-Za-z0-9_$]*(?:\s+extends[^{]+)?$/.test(prefix)) return "class"
  const previous = previousSignificantCharacter(source, index)
  if (previous && "=(:,[".includes(previous)) return "object"
  if (/\b(?:return|yield)\s*$/.test(prefix)) return "object"
  if (/\btype\s+[A-Za-z_$][A-Za-z0-9_$]*(?:<[^>]*>)?\s*=\s*$/.test(prefix)) return "object"
  return "block"
}

function findBuilder(source: string, from = 0, uppercaseOnly = false): BuilderCall | undefined {
  // Keep scanning all identifiers so lowercase user-defined builder helpers
  // remain supported. lowerBuilder preserves a call-shaped block that the AST
  // does not recognize as a closure instead of recursively lowering it.
  const braces: BraceFrame[] = []
  let parenDepth = 0
  let bracketDepth = 0
  let steps = 0
  for (let cursor = 0; cursor < source.length; cursor += 1) {
    if (++steps > source.length + 1) throw syntaxError("Unable to scan builder expressions in Mün source", from)
    const character = source[cursor]
    if (character === "\"" || character === "'" || character === "`") { cursor = skipString(source, cursor) - 1; continue }
    if (character === "/" && (source[cursor + 1] === "/" || source[cursor + 1] === "*")) { cursor = skipComment(source, cursor) - 1; continue }
    if (character === "/" && regexCanStart(source, cursor)) { cursor = skipRegex(source, cursor) - 1; continue }
    if (character === "(") { parenDepth += 1; continue }
    if (character === ")") { parenDepth = Math.max(0, parenDepth - 1); continue }
    if (character === "[") { bracketDepth += 1; continue }
    if (character === "]") { bracketDepth = Math.max(0, bracketDepth - 1); continue }
    if (character === "{") { braces.push({ context: braceContext(source, cursor), parenDepth, bracketDepth }); continue }
    if (character === "}") { braces.pop(); continue }
    if (cursor < from) continue
    const identifier = identifierAt(source, cursor)
    if (!identifier) continue
    const start = cursor
    cursor = identifier.end - 1
    if (excludedBuilderNames.has(identifier.name)) continue
    if (uppercaseOnly && !/^[A-Z]/.test(identifier.name)) continue
    const previous = previousSignificantCharacter(source, start)
    const previousWordValue = previousWord(source, start)
    const wordBeforeStar = previous === "*" ? previousWord(source, start - 2) : undefined
    if (previousWordValue === "function" || wordBeforeStar === "function") continue
    const open = skipTrivia(source, identifier.end)
    if (source[open] !== "(") continue
    const close = matching(source, open, "(", ")")
    const brace = skipTrivia(source, close + 1)
    if (source[brace] !== "{") continue

    // A call-shaped token at member position inside a class/object is a
    // JavaScript/TypeScript method declaration, not Mun trailing-closure
    // syntax. Property initializers (`field = Card() { ... }`) remain valid
    // Mun expressions because their preceding token is `=`/`:`.
    const frame = braces.at(-1)
    const container = frame?.context
    const atMemberLevel = frame !== undefined
      && parenDepth === frame.parenDepth
      && bracketDepth === frame.bracketDepth
    const before = previousSignificantCharacter(source, start)
    const memberPrefix = source.slice(Math.max(0, start - 120), start)
    const followsMemberModifier = /\b(?:public|private|protected|static|abstract|override|async|get|set|readonly|declare|accessor)\s+$/.test(memberPrefix)
    if (atMemberLevel && (container === "class" || container === "object")
      && (before === undefined || "{,;}*".includes(before) || followsMemberModifier)) continue

    const braceClose = matching(source, brace, "{", "}")
    return {
      start,
      open,
      close,
      brace,
      end: braceClose + 1,
      name: identifier.name,
      argumentSource: source.slice(open + 1, close),
      bodySource: source.slice(brace + 1, braceClose),
    }
  }
  return undefined
}

function skipHtmlTrivia(source: string, index: number): number {
  let cursor = index
  while (cursor < source.length && /\s/.test(source[cursor])) cursor += 1
  return cursor
}

function htmlNameAt(source: string, start: number): { name: string; end: number } | undefined {
  const match = /^[A-Za-z][A-Za-z0-9:._-]*/.exec(source.slice(start))
  return match ? { name: match[0], end: start + match[0].length } : undefined
}

function htmlAttributeNameAt(source: string, start: number): { name: string; end: number } | undefined {
  const match = /^[^\s=/>]+/.exec(source.slice(start))
  return match ? { name: match[0], end: start + match[0].length } : undefined
}

type ExpressionLowerer = (source: string) => string
const identityExpression: ExpressionLowerer = source => source


function decodeHtmlEntities(value: string): string {
  const named: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    quot: '"',
  }
  return value.replace(/&(#(?:x[0-9A-Fa-f]+|[0-9]+)|[A-Za-z][A-Za-z0-9]+);/g, (match, entity: string) => {
    if (entity[0] === "#") {
      const hexadecimal = entity[1]?.toLowerCase() === "x"
      const digits = entity.slice(hexadecimal ? 2 : 1)
      const codePoint = Number.parseInt(digits, hexadecimal ? 16 : 10)
      if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return match
      try { return String.fromCodePoint(codePoint) } catch { return match }
    }
    return named[entity] ?? match
  })
}

function htmlAttributes(source: string, baseOffset = 0, lower: ExpressionLowerer = identityExpression): string {
  const attributes: string[] = []
  let cursor = 0
  while (cursor < source.length) {
    cursor = skipHtmlTrivia(source, cursor)
    if (cursor >= source.length) break
    if (source[cursor] === "{") {
      const end = matching(source, cursor, "{", "}")
      const expression = source.slice(cursor + 1, end).trim()
      if (!expression.startsWith("...") || expression.slice(3).trim().length === 0) {
        throw syntaxError("Raw HTML attribute expressions must use {...value}", baseOffset + cursor)
      }
      attributes.push(`...(${lower(expression.slice(3).trim())})`)
      cursor = end + 1
      continue
    }
    const name = htmlAttributeNameAt(source, cursor)
    if (!name) throw syntaxError("Invalid raw HTML attribute", baseOffset + cursor)
    cursor = skipHtmlTrivia(source, name.end)
    let value = "true"
    if (source[cursor] === "=") {
      cursor = skipHtmlTrivia(source, cursor + 1)
      if (source[cursor] === "\"" || source[cursor] === "'") {
        const end = skipQuoted(source, cursor)
        value = JSON.stringify(decodeHtmlEntities(source.slice(cursor + 1, end - 1)))
        cursor = end
      } else if (source[cursor] === "{") {
        const end = matching(source, cursor, "{", "}")
        value = lower(source.slice(cursor + 1, end))
        cursor = end + 1
      } else {
        const match = /^[^\s/>]+/.exec(source.slice(cursor))
        if (!match) throw syntaxError(`Invalid value for raw HTML attribute ${name.name}`, baseOffset + cursor)
        value = JSON.stringify(decodeHtmlEntities(match[0]))
        cursor += match[0].length
      }
    }
    attributes.push(`${JSON.stringify(name.name)}: ${value}`)
  }
  return attributes.length === 0 ? "null" : `{ ${attributes.join(", ")} }`
}

const voidHtmlElements = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "param", "source", "track", "wbr"])

function rawHtmlAt(source: string, start: number, lower: ExpressionLowerer = identityExpression, nested = false): RawHtmlCall | undefined {
  if (!nested && !isRawHtmlCandidate(source, start)) return undefined
  const openingName = htmlNameAt(source, start + 1)
  if (!openingName) return undefined
  let cursor = openingName.end
  let braceDepth = 0
  let quote: string | undefined
  let close = -1
  for (; cursor < source.length; cursor += 1) {
    const character = source[cursor]
    if (quote) {
      if (character === "\\") { cursor += 1; continue }
      if (character === quote) quote = undefined
      continue
    }
    if (character === "\"" || character === "'") { quote = character; continue }
    if (character === "{") { braceDepth += 1; continue }
    if (character === "}") { braceDepth -= 1; continue }
    if (character === ">" && braceDepth === 0) { close = cursor; break }
  }
  if (close < 0 || quote || braceDepth !== 0) return undefined
  const opening = source.slice(openingName.end, close)
  const trimmedOpening = opening.trimEnd()
  const selfClosing = trimmedOpening.endsWith("/")
  const attributeSource = selfClosing ? trimmedOpening.slice(0, -1) : opening
  const attributes = htmlAttributes(attributeSource, openingName.end, lower)
  if (selfClosing || voidHtmlElements.has(openingName.name.toLowerCase())) return { start, end: close + 1, code: `Element(${JSON.stringify(openingName.name)}, ${attributes})` }

  const children: string[] = []
  cursor = close + 1
  while (cursor < source.length) {
    if (source.startsWith("<!--", cursor)) {
      const commentEnd = source.indexOf("-->", cursor + 4)
      if (commentEnd < 0) throw syntaxError("Unclosed raw HTML comment in Mün source", cursor)
      cursor = commentEnd + 3
      continue
    }
    if (source[cursor] === "<" && source[cursor + 1] === "/") {
      const closing = /^<\/([A-Za-z][A-Za-z0-9:._-]*)([^>]*)>/.exec(source.slice(cursor))
      if (!closing) throw syntaxError("Unclosed raw HTML closing tag in Mün source", cursor)
      if (closing[1] !== openingName.name) throw syntaxError(`Mismatched raw HTML closing tag </${closing[1]}>; expected </${openingName.name}>`, cursor)
      if (closing[2].trim().length > 0) throw syntaxError("Raw HTML closing tags cannot have attributes", cursor)
      const end = cursor + closing[0].length - 1
      return {
        start,
        end: end + 1,
        code: `Element(${JSON.stringify(openingName.name)}, ${attributes}${children.length ? `, ${children.join(", ")}` : ""})`,
      }
    }
    if (source[cursor] === "<") {
      const nestedHtml = rawHtmlAt(source, cursor, lower, true)
      if (!nestedHtml) return undefined
      children.push(nestedHtml.code)
      cursor = nestedHtml.end
      continue
    }
    if (source[cursor] === "{") {
      const end = matching(source, cursor, "{", "}")
      const expression = source.slice(cursor + 1, end).trim()
      if (expression) children.push(lower(expression))
      cursor = end + 1
      continue
    }
    const nextTag = source.indexOf("<", cursor)
    const nextExpression = source.indexOf("{", cursor)
    const end = [nextTag, nextExpression].filter(value => value >= 0).sort((left, right) => left - right)[0] ?? source.length
    const text = source.slice(cursor, end)
    if (text.length > 0) children.push(JSON.stringify(decodeHtmlEntities(text)))
    cursor = end
  }
  return undefined
}

function findRawHtml(source: string, from = 0, lower: ExpressionLowerer = identityExpression): RawHtmlCall | undefined {
  for (let cursor = from; cursor < source.length; cursor += 1) {
    if (source[cursor] === "\"" || source[cursor] === "'" || source[cursor] === "`") { cursor = skipString(source, cursor) - 1; continue }
    if (source[cursor] === "/" && (source[cursor + 1] === "/" || source[cursor + 1] === "*")) { cursor = skipComment(source, cursor) - 1; continue }
    if (source[cursor] === "/" && regexCanStart(source, cursor)) { cursor = skipRegex(source, cursor) - 1; continue }
    if (source[cursor] !== "<") continue
    const call = rawHtmlAt(source, cursor, lower)
    if (call) return call
  }
  return undefined
}

function validateRawHtmlSyntax(source: string): void {
  for (let cursor = 0; cursor < source.length; cursor += 1) {
    if (source[cursor] === "\"" || source[cursor] === "'" || source[cursor] === "`") {
      cursor = skipString(source, cursor) - 1
      continue
    }
    if (source[cursor] === "/" && (source[cursor + 1] === "/" || source[cursor + 1] === "*")) { cursor = skipComment(source, cursor) - 1; continue }
    if (source[cursor] === "/" && regexCanStart(source, cursor)) { cursor = skipRegex(source, cursor) - 1; continue }
    if (!isRawHtmlCandidate(source, cursor)) continue
    const html = rawHtmlAt(source, cursor)
    if (html) {
      cursor = html.end - 1
      continue
    }
    throw syntaxError("Unclosed raw HTML element in Mün source", cursor)
  }
}

function splitTopLevel(source: string, separator = ","): string[] {
  const parts: string[] = []
  let start = 0
  let parens = 0
  let brackets = 0
  let braces = 0
  for (let cursor = 0; cursor < source.length; cursor += 1) {
    const character = source[cursor]
    if (character === "\"" || character === "'" || character === "`") { cursor = skipString(source, cursor) - 1; continue }
    if (character === "/" && (source[cursor + 1] === "/" || source[cursor + 1] === "*")) { cursor = skipComment(source, cursor) - 1; continue }
    if (character === "/" && regexCanStart(source, cursor)) { cursor = skipRegex(source, cursor) - 1; continue }
    if (character === "<") {
      const html = rawHtmlAt(source, cursor)
      if (html) { cursor = html.end - 1; continue }
    }
    if (character === "(") parens += 1
    else if (character === ")") parens -= 1
    else if (character === "[") brackets += 1
    else if (character === "]") brackets -= 1
    else if (character === "{") braces += 1
    else if (character === "}") braces -= 1
    else if (character === separator && parens === 0 && brackets === 0 && braces === 0) {
      parts.push(source.slice(start, cursor).trim())
      start = cursor + 1
    }
  }
  const tail = source.slice(start).trim()
  if (tail) parts.push(tail)
  return parts
}

function splitStatements(source: string): string[] {
  const parts: string[] = []
  let start = 0
  let parens = 0
  let brackets = 0
  let braces = 0
  for (let cursor = 0; cursor < source.length; cursor += 1) {
    const character = source[cursor]
    if (character === "\"" || character === "'" || character === "`") { cursor = skipString(source, cursor) - 1; continue }
    if (character === "/" && (source[cursor + 1] === "/" || source[cursor + 1] === "*")) { cursor = skipComment(source, cursor) - 1; continue }
    if (character === "/" && regexCanStart(source, cursor)) { cursor = skipRegex(source, cursor) - 1; continue }
    if (character === "<") {
      const html = rawHtmlAt(source, cursor)
      if (html) { cursor = html.end - 1; continue }
    }
    if (character === "(") parens += 1
    else if (character === ")") parens -= 1
    else if (character === "[") brackets += 1
    else if (character === "]") brackets -= 1
    else if (character === "{") braces += 1
    else if (character === "}") braces -= 1
    const boundary = character === ";" || (character === "\n" && parens === 0 && brackets === 0 && braces === 0)
    if (boundary && parens === 0 && brackets === 0 && braces === 0) {
      const part = source.slice(start, cursor).trim()
      if (part) parts.push(part)
      start = cursor + 1
    }
  }
  const tail = source.slice(start).trim()
  if (tail) parts.push(tail)
  return parts
}

function topLevelColon(source: string): number {
  let parens = 0
  let brackets = 0
  let braces = 0
  let ternary = 0
  for (let cursor = 0; cursor < source.length; cursor += 1) {
    const character = source[cursor]
    if (character === "\"" || character === "'" || character === "`") { cursor = skipString(source, cursor) - 1; continue }
    if (character === "/" && (source[cursor + 1] === "/" || source[cursor + 1] === "*")) { cursor = skipComment(source, cursor) - 1; continue }
    if (character === "/" && regexCanStart(source, cursor)) { cursor = skipRegex(source, cursor) - 1; continue }
    if (character === "(") parens += 1
    else if (character === ")") parens -= 1
    else if (character === "[") brackets += 1
    else if (character === "]") brackets -= 1
    else if (character === "{") braces += 1
    else if (character === "}") braces -= 1
    else if (parens === 0 && brackets === 0 && braces === 0 && character === "?" && source[cursor + 1] !== ".") ternary += 1
    else if (character === ":" && parens === 0 && brackets === 0 && braces === 0) {
      if (ternary > 0) ternary -= 1
      else return cursor
    }
  }
  return -1
}


export {
  syntaxError,
  skipString,
  skipComment,
  regexCanStart,
  skipRegex,
  skipTrivia,
  matching,
  identifierAt,
  isRawHtmlCandidate,
  findBuilder,
  skipHtmlTrivia,
  htmlNameAt,
  htmlAttributeNameAt,
  htmlAttributes,
  rawHtmlAt,
  findRawHtml,
  validateRawHtmlSyntax,
  splitTopLevel,
  splitStatements,
  topLevelColon,
}

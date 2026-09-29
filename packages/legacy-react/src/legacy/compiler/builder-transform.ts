import { munSyntaxError } from './errors.js'
import { lowerMunBuilderAst, parseMunBuilder } from './ast.js'

/**
 * Transforms Mun's optional block-builder syntax into ordinary JavaScript.
 *
 *     VStack() {
 *       Text('A')
 *       Text('B')
 *     }
 *
 * becomes:
 *
 *     VStack(() => [Text('A'), Text('B')])
 *
 * This is a small lexical parser rather than a regular-expression replacement:
 * strings, comments, templates, regular expressions, nested calls and nested
 * builder blocks are all kept out of the syntax scan. The parser deliberately
 * does not keep a component-name allow-list. A trailing block is syntax sugar
 * for an overload; the runtime initializer resolver decides whether the call
 * is valid for that type.
 */

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
  let i = index + 1
  while (i < source.length) {
    if (source[i] === '\\') {
      i += 2
      continue
    }
    if (source[i] === quote) return i + 1
    i += 1
  }
  throw munSyntaxError(`Unclosed ${quote} string in Mun builder source`, index)
}

function skipLineComment(source: string, index: number): number {
  const newline = source.indexOf('\n', index + 2)
  return newline === -1 ? source.length : newline
}

function skipBlockComment(source: string, index: number): number {
  const close = source.indexOf('*/', index + 2)
  if (close === -1) throw munSyntaxError('Unclosed block comment in Mun builder source', index)
  return close + 2
}

function skipTemplate(source: string, index: number): number {
  let i = index + 1
  while (i < source.length) {
    if (source[i] === '\\') {
      i += 2
      continue
    }
    if (source[i] === '`') return i + 1
    if (source[i] === '$' && source[i + 1] === '{') {
      i = findMatching(source, i + 1, '{') + 1
      continue
    }
    i += 1
  }
  throw munSyntaxError('Unclosed template literal in Mun builder source', index)
}

function skipRegex(source: string, index: number): number {
  let i = index + 1
  let inClass = false
  while (i < source.length) {
    const char = source[i]
    if (char === '\\') {
      i += 2
      continue
    }
    if (char === '[') inClass = true
    if (char === ']') inClass = false
    if (char === '/' && !inClass) {
      i += 1
      while (/[A-Za-z]/.test(source[i] ?? '')) i += 1
      return i
    }
    if (char === '\n' || char === '\r') break
    i += 1
  }
  return index + 1
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
    if (char === "'" || char === '"') {
      i = skipQuoted(source, i, char) - 1
      continue
    }
    if (char === '`') {
      i = skipTemplate(source, i) - 1
      continue
    }
    if (char === '/' && next === '/') {
      i = skipLineComment(source, i) - 1
      continue
    }
    if (char === '/' && next === '*') {
      i = skipBlockComment(source, i) - 1
      continue
    }
    if (char === '/' && regexCanStartAfter(source, i)) {
      i = skipRegex(source, i) - 1
      continue
    }
    if (char === open) depth += 1
    if (char === close) {
      depth -= 1
      if (depth === 0) return i
    }
  }

  throw munSyntaxError(`Unclosed ${open} block in Mun builder source`, openIndex)
}

const controlKeywords = new Set([
  'if', 'else', 'for', 'while', 'switch', 'catch', 'with', 'function', 'class',
  'try', 'do', 'finally', 'return', 'throw', 'new', 'typeof', 'void', 'delete',
])

function isDeclarationLikeCall(source: string, start: number, body: string): boolean {
  const prefix = source.slice(Math.max(0, start - 80), start)
  if (/\bfunction\s*\*?\s*$/.test(prefix)) return true
  // JavaScript class/object methods have no `function` token. A return/yield
  // at the start of their block is a reliable boundary for this lexical
  // transform, while ordinary Mun builder blocks contain child expressions.
  return /^(?:return|yield)\b/.test(body.trim())
}

function isDeclarationLikeSignature(source: string, start: number, close: number, next: number): boolean {
  const prefix = source.slice(Math.max(0, start - 80), start)
  if (/\bfunction\s*\*?\s*$/.test(prefix)) return true
  return /^\s*:\s*/.test(source.slice(close + 1, next))
}

function splitTopLevelArguments(source: string): string[] {
  const parts: string[] = []
  let start = 0
  let parens = 0
  let brackets = 0
  let braces = 0

  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]
    const next = source[i + 1]
    if (char === "'" || char === '"') {
      i = skipQuoted(source, i, char) - 1
      continue
    }
    if (char === '`') {
      i = skipTemplate(source, i) - 1
      continue
    }
    if (char === '/' && next === '/') {
      i = skipLineComment(source, i) - 1
      continue
    }
    if (char === '/' && next === '*') {
      i = skipBlockComment(source, i) - 1
      continue
    }
    if (char === '/' && regexCanStartAfter(source, i)) {
      i = skipRegex(source, i) - 1
      continue
    }
    if (char === '(') parens += 1
    else if (char === ')') parens -= 1
    else if (char === '[') brackets += 1
    else if (char === ']') brackets -= 1
    else if (char === '{') braces += 1
    else if (char === '}') braces -= 1
    else if (char === ',' && parens === 0 && brackets === 0 && braces === 0) {
      parts.push(source.slice(start, i).trim())
      start = i + 1
    }
  }

  const final = source.slice(start).trim()
  if (final) parts.push(final)
  return parts
}

function lowerMunShorthand(value: string): string {
  // Swift-style enum cases are unqualified in argument position. Keep this
  // deliberately lexical: a normal member expression such as `item.value`
  // must remain untouched.
  return value.replace(/(^|[(:,=]\s*)\.([A-Za-z_$][A-Za-z0-9_$]*)/g, "$1'$2'")
}

function namedClosure(value: string): string {
  const trimmed = value.trim()
  if (trimmed[0] !== '{') return lowerMunShorthand(value)
  const close = findMatching(trimmed, 0, '{')
  if (close !== trimmed.length - 1) return lowerMunShorthand(value)
  const body = trimmed.slice(1, close)
  return closureSource(body)
}

function actionOnlyClosureBody(source: string): boolean {
  return /(?:^|[;\n])\s*(?:const|let|var|return|throw|function|class|if|for|while|switch|try|do|break|continue|debugger)\b/.test(source)
}

function builderClosureBody(source: string): string {
  const program = parseMunBuilder(source)
  const containsStatement = program.statements.some(node => node.kind === 'raw'
    && /^(?:const|let|var|return|throw|function|class|for|while|switch|try|do|break|continue|debugger)\b/.test(node.source.trim()))
  return containsStatement ? '[]' : `[${transformBuilderBody(source).join(', ')}]`
}

function closureSource(body: string, parameter?: string): string {
  const prefix = parameter ? `(${parameter})` : '()'
  if (actionOnlyClosureBody(body)) {
    return `overloadClosure(${prefix} => ${builderClosureBody(body)}, ${prefix} => { ${transformRange(body)} })`
  }
  return `${prefix} => [${transformBuilderBody(body).join(', ')}]`
}

function namedCallArguments(source: string): string {
  const parts = splitTopLevelArguments(source)
  if (parts.length === 0) return source.trim()

  const labeled = parts.map(part => {
    const match = /^([A-Za-z_$][A-Za-z0-9_$]*)\s*:\s*([\s\S]*)$/.exec(part)
    return match ? { label: match[1], value: match[2] } : null
  })
  if (!labeled.some(Boolean)) return lowerMunShorthand(source.trim())

  const named = labeled.flatMap((part, index) => {
    if (!part) return []
    return [`${part.label}: ${namedClosure(part.value)}`]
  })
  const positional = labeled.flatMap((part, index) => part ? [] : [lowerMunShorthand(parts[index])])
  const object = `namedArguments({ ${named.join(', ')} })`
  // Mun's labeled arguments are lowered to one compatibility object. Keeping
  // positional arguments in front lets APIs such as Toggle("Wi-Fi", isOn: ...)
  // use the same resolver as fully labeled calls.
  return positional.length > 0 ? `${positional.join(', ')}, ${object}` : object
}

function transformBuilderBody(source: string): string[] {
  return lowerMunBuilderAst(parseMunBuilder(source), {
    transformRaw: transformRange,
    closure: closureSource,
  })
}

function transformRange(source: string): string {
  let output = ''

  for (let i = 0; i < source.length;) {
    const char = source[i]
    const next = source[i + 1]
    if (char === "'" || char === '"') {
      const end = skipQuoted(source, i, char)
      output += source.slice(i, end)
      i = end
      continue
    }
    if (char === '`') {
      const end = skipTemplate(source, i)
      output += source.slice(i, end)
      i = end
      continue
    }
    if (char === '/' && next === '/') {
      const end = skipLineComment(source, i)
      output += source.slice(i, end)
      i = end
      continue
    }
    if (char === '/' && next === '*') {
      const end = skipBlockComment(source, i)
      output += source.slice(i, end)
      i = end
      continue
    }
    if (char === '/' && regexCanStartAfter(source, i)) {
      const end = skipRegex(source, i)
      output += source.slice(i, end)
      i = end
      continue
    }

    if (isIdentifierStart(char)) {
      const start = i
      i += 1
      while (isIdentifierPart(source[i])) i += 1
      const name = source.slice(start, i)
      const previous = source[start - 1]
      if (controlKeywords.has(name) || isIdentifierPart(previous)) {
        output += source.slice(start, i)
        continue
      }

      const open = skipTrivia(source, i)
      if (source[open] !== '(') {
        output += source.slice(start, i)
        continue
      }
      const close = findMatching(source, open, '(')
      const blockOpen = skipTrivia(source, close + 1)
      if (source[blockOpen] !== '{') {
        const originalArgs = source.slice(open + 1, close)
        if (isDeclarationLikeSignature(source, start, close, blockOpen)) {
          output += source.slice(start, close + 1)
          i = close + 1
          continue
        }
        const transformedArgs = transformRange(originalArgs)
        const args = namedCallArguments(transformedArgs)
        output += args === transformedArgs.trim() && transformedArgs === originalArgs
          ? source.slice(start, close + 1)
          : `${name}(${args})`
        i = close + 1
        continue
      }

      const blockClose = findMatching(source, blockOpen, '{')
      const args = namedCallArguments(transformRange(source.slice(open + 1, close)))
      const rawBody = source.slice(blockOpen + 1, blockClose)
      if (isDeclarationLikeCall(source, start, rawBody)) {
        output += source.slice(start, blockClose + 1)
        i = blockClose + 1
        continue
      }
      const parameterMatch = /^\s*([A-Za-z_$][A-Za-z0-9_$]*)\s+in\s+([\s\S]*)$/.exec(rawBody)
      const bodySource = parameterMatch?.[2] ?? rawBody
      const callback = closureSource(bodySource, parameterMatch?.[1])
      output += `${name}(${args ? `${args}, ` : ''}${callback})`
      i = blockClose + 1
      continue
    }

    output += char
    i += 1
  }

  return output
}

function bindingShorthandContext(source: string, index: number): boolean {
  const previous = previousSignificant(source, index)
  if (previous !== undefined && '([{=,:'.includes(previous)) return true
  const prefix = source.slice(0, index).match(/([A-Za-z_$][A-Za-z0-9_$]*)\s*$/)?.[1]
  return prefix === 'return' || prefix === 'yield' || prefix === 'case'
}

const nonBindingDollarNames = new Set([
  'attrs', 'data', 'emit', 'el', 'forceUpdate', 'nextTick', 'options', 'parent', 'props', 'refs', 'root', 'slots', 'watch',
])

/** Lower Swift-style `$state` projections without touching JS identifiers. */
function lowerBindingShorthand(source: string): string {
  let output = ''
  for (let index = 0; index < source.length;) {
    const char = source[index]
    if (char === "'" || char === '"') {
      const end = skipQuoted(source, index, char)
      output += source.slice(index, end)
      index = end
      continue
    }
    if (char === '`') {
      const end = skipTemplate(source, index)
      output += source.slice(index, end)
      index = end
      continue
    }
    if (char === '/' && source[index + 1] === '/') {
      const end = skipLineComment(source, index)
      output += source.slice(index, end)
      index = end
      continue
    }
    if (char === '/' && source[index + 1] === '*') {
      const end = skipBlockComment(source, index)
      output += source.slice(index, end)
      index = end
      continue
    }
    if (char === '/' && regexCanStartAfter(source, index)) {
      const end = skipRegex(source, index)
      if (end !== index + 1) {
        output += source.slice(index, end)
        index = end
        continue
      }
    }
    if (char === '$' && bindingShorthandContext(source, index)) {
      const match = /^\$([A-Za-z_$][A-Za-z0-9_$]*)/.exec(source.slice(index))
      if (match && !nonBindingDollarNames.has(match[1])) {
        output += `Binding(${match[1]})`
        index += match[0].length
        continue
      }
    }
    output += char
    index += 1
  }
  return output
}

export function transformMunBuilderSyntax(
  source: string,
): string {
  return lowerBindingShorthand(transformRange(source))
}

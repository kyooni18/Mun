import * as ts from "typescript"
import { swiftUIAnimationFactoryArgumentLabels } from "@mun/core"
import { identifierAt, matching, skipComment, skipString, skipTrivia, splitTopLevel, syntaxError, topLevelColon } from "./scanner.js"

function isIdentifierDeclaration(node: ts.Identifier): boolean {
  const parent = node.parent
  if (ts.isVariableDeclaration(parent) && parent.name === node) return true
  if (ts.isParameter(parent) && parent.name === node) return true
  if (ts.isBindingElement(parent) && parent.name === node) return true
  if (ts.isFunctionDeclaration(parent) && parent.name === node) return true
  if (ts.isClassDeclaration(parent) && parent.name === node) return true
  if (ts.isImportClause(parent) && parent.name === node) return true
  // Both sides of `import { $remote as local }` are declaration syntax. The
  // imported property name is not a Mun Binding projection and must survive
  // shorthand lowering verbatim.
  if (ts.isImportSpecifier(parent) && (parent.name === node || parent.propertyName === node)) return true
  if (ts.isNamespaceImport(parent) && parent.name === node) return true
  if (ts.isExportSpecifier(parent) && (parent.name === node || parent.propertyName === node)) return true
  return false
}

function isBindingShorthandIdentifier(node: ts.Identifier): boolean {
  if (!node.text.startsWith("$") || node.text.length === 1) return false
  if (nonBindingDollarNames.has(node.text.slice(1)) || isIdentifierDeclaration(node)) return false
  const parent = node.parent
  if (ts.isPropertyAccessExpression(parent) && (parent.expression === node || parent.name === node)) return false
  if (ts.isElementAccessExpression(parent) && parent.expression === node) return false
  if (ts.isPropertyAssignment(parent) && parent.name === node) return false
  if (ts.isMethodDeclaration(parent) && parent.name === node) return false
  if (ts.isPropertyDeclaration(parent) && parent.name === node) return false
  if (ts.isMethodSignature(parent) && parent.name === node) return false
  if (ts.isPropertySignature(parent) && parent.name === node) return false
  if (ts.isShorthandPropertyAssignment(parent)) return false
  return true
}

const nonBindingDollarNames = new Set([
  "attrs", "data", "emit", "el", "forceUpdate", "nextTick", "options", "parent", "props", "refs", "root", "slots", "watch",
])

/**
 * Lower only actual identifier nodes. The source is intentionally edited by
 * span so the rest of Mun's syntax lowering keeps its original formatting.
 * This prevents member properties, declarations, strings, comments, regexes,
 * and identifiers containing `$` from being mistaken for projections.
 */
export function lowerShorthand(source: string): string {
  const file = ts.createSourceFile("mun-shorthand.ts", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)
  const edits: Array<{ start: number; end: number; replacement: string }> = []
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && isBindingShorthandIdentifier(node)) {
      edits.push({ start: node.getStart(file), end: node.end, replacement: `Binding(${node.text.slice(1)})` })
    }
    ts.forEachChild(node, visit)
  }
  visit(file)
  let result = source
  for (const edit of edits.sort((left, right) => right.start - left.start)) {
    result = result.slice(0, edit.start) + edit.replacement + result.slice(edit.end)
  }
  return result
}

/**
 * Ranges of strings, template literals, and comments. Implicit-member
 * lowering must never rewrite prose like `"Press return .red to confirm"`,
 * so replacements are suppressed inside these spans. Template-literal
 * interpolation contents are conservatively left untouched.
 */
function opaqueSpans(source: string): ReadonlyArray<readonly [number, number]> {
  const spans: Array<readonly [number, number]> = []
  let cursor = 0
  while (cursor < source.length) {
    const character = source[cursor]
    if (character === '"' || character === "'" || character === "`") {
      let end: number
      try { end = skipString(source, cursor) } catch { return spans }
      spans.push([cursor, end])
      cursor = end
      continue
    }
    if (character === "/" && (source[cursor + 1] === "/" || source[cursor + 1] === "*")) {
      let end: number
      try { end = skipComment(source, cursor) } catch { return spans }
      spans.push([cursor, end])
      cursor = end
      continue
    }
    cursor += 1
  }
  return spans
}

function replaceOutsideOpaqueSpans(
  source: string,
  pattern: RegExp,
  replacer: (match: RegExpExecArray) => string,
): string {
  // Always drive the pass from matchAll so the replacer consistently receives
  // one match-array argument (String.replace would splat groups separately).
  const spans = opaqueSpans(source)
  let result = ""
  let lastIndex = 0
  const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : pattern.flags + "g")
  for (const match of source.matchAll(global)) {
    const start = match.index ?? 0
    const end = start + match[0].length
    const overlapped = spans.some(([from, to]) => start < to && from < end)
    result += source.slice(lastIndex, start) + (overlapped ? match[0] : replacer(match as unknown as RegExpExecArray))
    lastIndex = end
  }
  return result + source.slice(lastIndex)
}

/**
 * Lower Swift-style implicit member expressions used by the Mun authoring
 * language. Bare enum-like cases become inert string values, matching the
 * existing Alignment/Edge-style runtime representation. Animation factories
 * keep their value semantics and are qualified with Animation instead.
 */
export function lowerImplicitMemberShorthand(source: string): string {
  const animationFactories = new Set(["linear", "easeIn", "easeOut", "easeInOut", "spring", "interactiveSpring", "smooth", "snappy", "bouncy"])
  const animationProperties = new Set(["default"])
  // Implicit members appear in expression-start positions: after opening
  // punctuation (`(`, `,`, `:`, `=`), after a ternary `?` followed by
  // whitespace, and after expression keywords such as `return .red`. A `?`
  // immediately followed by the dot stays optional chaining (`a?.b`).
  const prefixPattern = "(^|[(:,=]\\s*|\\?\\s+|\\b(?:return|case|throw|await|yield)\\s+)"
  let result = replaceOutsideOpaqueSpans(
    source,
    new RegExp(prefixPattern + "\\.([A-Za-z_$][A-Za-z0-9_$]*)\\s*(?=\\()", "g"),
    match => {
      const [matchText, prefix, name] = match as unknown as [string, string, string]
      return animationFactories.has(name) ? `${prefix}Animation.${name}` : matchText
    },
  )
  result = lowerNamedAnimationFactoryCalls(result)
  result = replaceOutsideOpaqueSpans(
    result,
    new RegExp(prefixPattern + "\\.([A-Za-z_$][A-Za-z0-9_$]*)(?!\\s*\\()", "g"),
    match => {
      const [matchText, prefix, name] = match as unknown as [string, string, string]
      if (animationProperties.has(name)) return `${prefix}Animation.${name}`
      // SwiftUI exposes common timing curves as static Animation values as
      // well as duration-taking factories. The JavaScript runtime keeps only
      // the factory form, so an implicit member value lowers to its zero-arg
      // equivalent without changing Mun authoring syntax.
      if (animationFactories.has(name)) return `${prefix}Animation.${name}()`
      return `${prefix}${JSON.stringify(name)}`
    },
  )
  return result
}

export function lowerNamedAnimationFactoryCalls(source: string): string {
  let output = source
  let iterations = 0
  while (true) {
    if (++iterations > output.length + 1) throw syntaxError("Animation argument lowering did not advance", 0)
    let candidate: { readonly name: string; readonly open: number; readonly close: number; readonly labels: readonly string[] } | undefined
    for (let cursor = 0; cursor < output.length; cursor += 1) {
      const index = output.indexOf("Animation.", cursor)
      if (index < 0) break
      const name = identifierAt(output, index + "Animation.".length)
      if (!name) { cursor = index + 9; continue }
      const labels = swiftUIAnimationFactoryArgumentLabels(name.name)
      const open = skipTrivia(output, name.end)
      if (!labels || output[open] !== "(") { cursor = name.end; continue }
      const close = matching(output, open, "(", ")")
      const argumentsSource = output.slice(open + 1, close)
      if (splitTopLevel(argumentsSource).some(argument => topLevelColon(argument) >= 0)) candidate = { name: name.name, open, close, labels }
      cursor = close
    }
    if (!candidate) return output

    const entries = splitTopLevel(output.slice(candidate.open + 1, candidate.close)).map(value => {
      const colon = topLevelColon(value)
      const possibleLabel = colon < 0 ? undefined : value.slice(skipTrivia(value, 0), colon).trim()
      const label = possibleLabel && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(possibleLabel) ? possibleLabel : undefined
      return { label, value: (label ? value.slice(colon + 1) : value).trim() }
    })
    const slots: Array<string | undefined> = []
    let positionalIndex = 0
    for (const entry of entries) {
      if (!entry.label) {
        if (positionalIndex >= candidate.labels.length) throw syntaxError(`Too many arguments for Animation.${candidate.name}(...)`, candidate.open)
        slots[positionalIndex++] = entry.value
        continue
      }
      const index = candidate.labels.indexOf(entry.label)
      if (index < 0) throw syntaxError(`Unknown labeled argument ${entry.label}: in Animation.${candidate.name}(...)`, candidate.open)
      if (slots[index] !== undefined) throw syntaxError(`Duplicate argument ${entry.label}: in Animation.${candidate.name}(...)`, candidate.open)
      slots[index] = entry.value
    }
    let end = slots.length
    while (end > 0 && slots[end - 1] === undefined) end -= 1
    const lowered = Array.from({ length: end }, (_value, index) => slots[index] ?? "undefined").join(", ")
    output = output.slice(0, candidate.open + 1) + lowered + output.slice(candidate.close)
  }
}

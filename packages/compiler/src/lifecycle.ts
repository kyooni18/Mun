import { matching, skipComment, skipString, skipTrivia, splitTopLevel } from "./scanner.js"

const lifecycleModifier = /\.(onAppear|onDisappear|task|onChange)\b/y

function labeled(argument: string): { readonly label?: string; readonly value: string } {
  const match = /^\s*([A-Za-z_$][A-Za-z0-9_$]*)\s*:(?!:)\s*([\s\S]*)$/.exec(argument)
  return match ? { label: match[1], value: match[2].trim() } : { value: argument.trim() }
}

/** `{ old, new in ... }` → `(old, newValue) => { ... }`; `new` is reserved in JavaScript. */
function closure(body: string): string {
  const header = /^\s*([A-Za-z_$][A-Za-z0-9_$]*(?:\s*,\s*[A-Za-z_$][A-Za-z0-9_$]*)*)\s+in\b/.exec(body)
  let parameters = header ? header[1].split(",").map(name => name.trim()) : []
  let statements = header ? body.slice(header[0].length) : body
  if (parameters.includes("new")) {
    parameters = parameters.map(name => name === "new" ? "newValue" : name)
    statements = statements.replace(/\bnew\b(?!\s*[A-Za-z_$(])/g, "newValue")
  }
  return `${/\bawait\b/.test(statements) ? "async " : ""}(${parameters.join(", ")}) => {${statements}}`
}

/**
 * SwiftUI lifecycle modifiers with trailing closures and labels become plain
 * positional calls the runtime understands:
 * `.onAppear { }` → `.onAppear(() => {})`, `.task(id: x) { }` → `.task(async () => {}, x)`,
 * `.onChange(of: x) { old, new in }` → `.onChange(x, (old, newValue) => {})`.
 */
export function lowerLifecycleModifiers(source: string): string {
  if (!/\.(?:onAppear|onDisappear|task|onChange)\b/.test(source)) return source
  let output = ""
  let cursor = 0
  while (cursor < source.length) {
    const character = source[cursor]
    if (character === "/" && (source[cursor + 1] === "/" || source[cursor + 1] === "*")) {
      const end = skipComment(source, cursor)
      output += source.slice(cursor, end)
      cursor = end
      continue
    }
    if (character === "\"" || character === "'" || character === "`") {
      const end = skipString(source, cursor)
      output += source.slice(cursor, end)
      cursor = end
      continue
    }
    lifecycleModifier.lastIndex = cursor
    const match = lifecycleModifier.exec(source)
    if (!match) { output += character; cursor += 1; continue }
    const name = match[1]
    let next = skipTrivia(source, cursor + match[0].length)
    let args: { readonly label?: string; readonly value: string }[] = []
    if (source[next] === "(") {
      const close = matching(source, next, "(", ")")
      args = splitTopLevel(source.slice(next + 1, close)).filter(argument => argument.trim()).map(labeled)
      next = skipTrivia(source, close + 1)
    }
    let action = args.find(argument => argument.label === "perform" || argument.label === "action")?.value
    let end = next
    if (source[next] === "{") {
      const close = matching(source, next, "{", "}")
      action = closure(source.slice(next + 1, close))
      end = close + 1
    }
    if (action === undefined) { output += match[0]; cursor += match[0].length; continue }
    const value = (label: string): string | undefined => args.find(argument => argument.label === label)?.value
    const positional = args.find(argument => argument.label === undefined)?.value
    const call = name === "task"
      ? [action, value("id")]
      : name === "onChange"
        ? [value("of") ?? positional, action, value("initial")]
        : [action]
    while (call.length > 0 && call.at(-1) === undefined) call.pop()
    output += `.${name}(${call.map(item => item ?? "undefined").join(", ")})`
    cursor = end
  }
  return output
}

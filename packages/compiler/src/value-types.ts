import type { MunUiValue } from "@mun/core"

/**
 * Mün value types. Canonical `.mun` spells them like Swift (`String`, `Int`,
 * `Double`, `Bool`, `[T]`, `[K: V]`, `T?`); TypeScript spellings (`string`,
 * `number`, `T[]`, `Record<K, V>`, `T | null`) are compatibility-only and are
 * accepted only by the legacy `.mun.ts` pipeline. Both normalize to this form.
 */
export type MunType =
  | { readonly kind: "string" }
  | { readonly kind: "int" }
  | { readonly kind: "double" }
  | { readonly kind: "bool" }
  | { readonly kind: "array"; readonly element: MunType }
  | { readonly kind: "dictionary"; readonly key: MunType; readonly value: MunType }
  | { readonly kind: "optional"; readonly wrapped: MunType }
  | { readonly kind: "function" }
  | { readonly kind: "named"; readonly name: string }

const swiftScalars: Readonly<Record<string, MunType>> = {
  String: { kind: "string" },
  Character: { kind: "string" },
  Int: { kind: "int" },
  Double: { kind: "double" },
  CGFloat: { kind: "double" },
  Float: { kind: "double" },
  Bool: { kind: "bool" },
}

const compatScalars: Readonly<Record<string, { readonly type: MunType; readonly canonical: string }>> = {
  string: { type: { kind: "string" }, canonical: "String" },
  number: { type: { kind: "double" }, canonical: "Double (or Int)" },
  boolean: { type: { kind: "bool" }, canonical: "Bool" },
}

/** Split at top-level `separator` (outside brackets, parentheses and generics). */
function splitTop(source: string, separator: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if ("([{<".includes(character)) depth += 1
    else if (")]}>".includes(character) && !(character === ">" && source[index - 1] === "-" || character === ">" && source[index - 1] === "=")) depth -= 1
    else if (depth === 0 && source.startsWith(separator, index)) {
      parts.push(source.slice(start, index))
      start = index + separator.length
      index += separator.length - 1
    }
  }
  parts.push(source.slice(start))
  return parts.map(part => part.trim())
}

function enclosed(source: string, open: string, close: string): boolean {
  if (!source.startsWith(open) || !source.endsWith(close)) return false
  let depth = 0
  for (let index = 0; index < source.length; index += 1) {
    if ("([{<".includes(source[index])) depth += 1
    else if (")]}>".includes(source[index])) depth -= 1
    if (depth === 0 && index < source.length - 1) return false
  }
  return true
}

export interface MunTypeOptions {
  /** Canonical `.mun`: TypeScript spellings are rejected with their Swift replacement. */
  readonly canonical: boolean
  /** Where the type is written, for diagnostics. */
  readonly what: string
}

export function parseMunType(source: string, options: MunTypeOptions): MunType {
  const text = source.trim()
  const compat = (spelling: string, canonical: string, type: MunType): MunType => {
    if (options.canonical) {
      throw new SyntaxError(`${options.what}: '${spelling}' is a compatibility-only TypeScript type spelling; canonical .mun writes ${canonical}`)
    }
    return type
  }
  if (!text) throw new SyntaxError(`${options.what}: missing type`)
  if (/->|=>/.test(text) && enclosed(text.slice(0, text.search(/->|=>/)).trim(), "(", ")")) {
    return text.includes("=>") ? compat(text, "a Swift function type such as () -> Void", { kind: "function" }) : { kind: "function" }
  }
  if (text.endsWith("?")) return { kind: "optional", wrapped: parseMunType(text.slice(0, -1), options) }
  if (enclosed(text, "[", "]")) {
    const inner = text.slice(1, -1)
    const pair = splitTop(inner, ":")
    if (pair.length === 2) return { kind: "dictionary", key: parseMunType(pair[0], options), value: parseMunType(pair[1], options) }
    return { kind: "array", element: parseMunType(inner, options) }
  }
  if (enclosed(text, "(", ")")) return parseMunType(text.slice(1, -1), options)
  const union = splitTop(text, "|")
  const lenient = { ...options, canonical: false }
  if (union.length > 1) {
    const rest = union.filter(part => part !== "null" && part !== "undefined")
    if (rest.length === 1) {
      const wrapped = parseMunType(rest[0], lenient)
      return compat(text, `${displayMunType(wrapped)}?`, { kind: "optional", wrapped })
    }
    throw new SyntaxError(`${options.what}: union types are not Mün types: ${text}`)
  }
  if (text.endsWith("[]")) {
    const element = parseMunType(text.slice(0, -2), lenient)
    return compat(text, `[${displayMunType(element)}]`, { kind: "array", element })
  }
  const generic = /^([A-Za-z_][\w.]*)\s*<([\s\S]+)>$/.exec(text)
  if (generic) {
    const [name, argumentsSource] = [generic[1], generic[2]]
    const parts = splitTop(argumentsSource, ",")
    if ((name === "Array" || name === "ReadonlyArray") && parts.length === 1) {
      const element = parseMunType(parts[0], name === "Array" ? options : lenient)
      return name === "Array" ? { kind: "array", element } : compat(text, `[${displayMunType(element)}]`, { kind: "array", element })
    }
    if (name === "Dictionary" && parts.length === 2) {
      return { kind: "dictionary", key: parseMunType(parts[0], options), value: parseMunType(parts[1], options) }
    }
    if (name === "Optional" && parts.length === 1) return { kind: "optional", wrapped: parseMunType(parts[0], options) }
    if (name === "Record" && parts.length === 2) {
      const key = parseMunType(parts[0], lenient)
      const value = parseMunType(parts[1], lenient)
      return compat(text, `[${displayMunType(key)}: ${displayMunType(value)}]`, { kind: "dictionary", key, value })
    }
    return { kind: "named", name: text }
  }
  if (swiftScalars[text]) return swiftScalars[text]
  if (compatScalars[text]) return compat(text, compatScalars[text].canonical, compatScalars[text].type)
  if (text === "any" || text === "unknown" || text === "Any") {
    throw new SyntaxError(`${options.what}: '${text}' is not a Mün type; declare a concrete type`)
  }
  if (/^[A-Za-z_][\w.]*$/.test(text)) return { kind: "named", name: text }
  throw new SyntaxError(`${options.what}: unsupported type spelling '${text}'`)
}

/** The Swift spelling of a type, for diagnostics. */
export function displayMunType(type: MunType): string {
  switch (type.kind) {
    case "string": return "String"
    case "int": return "Int"
    case "double": return "Double"
    case "bool": return "Bool"
    case "array": return `[${displayMunType(type.element)}]`
    case "dictionary": return `[${displayMunType(type.key)}: ${displayMunType(type.value)}]`
    case "optional": return `${displayMunType(type.wrapped)}?`
    case "function": return "a function"
    case "named": return type.name
  }
}

/** The runtime value family of a type (the Semantic UI IR value model). */
export function runtimeTypeName(type: MunType): string {
  switch (type.kind) {
    case "string": return "string"
    case "int": case "double": return "number"
    case "bool": return "boolean"
    case "array": return "array"
    case "dictionary": case "named": return "object"
    case "optional": return runtimeTypeName(type.wrapped)
    case "function": return "function"
  }
}

/** Whether a static value inhabits `type`. Named record types are checked structurally at runtime. */
export function valueMatchesType(value: MunUiValue, type: MunType): boolean {
  switch (type.kind) {
    case "optional": return value === null || valueMatchesType(value, type.wrapped)
    case "string": return typeof value === "string"
    case "int": return typeof value === "number" && Number.isInteger(value)
    case "double": return typeof value === "number"
    case "bool": return typeof value === "boolean"
    case "array": return Array.isArray(value) && value.every(item => valueMatchesType(item, type.element))
    case "dictionary": return typeof value === "object" && value !== null && !Array.isArray(value)
      && Object.values(value).every(item => valueMatchesType(item as MunUiValue, type.value))
    case "named": return typeof value === "object" && value !== null && !Array.isArray(value)
    case "function": return false
  }
}

/** Describe a static value's type in Swift terms. */
export function describeValueType(value: MunUiValue): string {
  if (value === null) return "nil"
  if (Array.isArray(value)) return "an array"
  if (typeof value === "number") return Number.isInteger(value) ? "Int" : "Double"
  if (typeof value === "string") return "String"
  if (typeof value === "boolean") return "Bool"
  return "a record"
}

interface DeclaredMember {
  readonly name: string
  readonly kind: "stored" | "state" | "binding"
  readonly access?: string
  readonly type?: string
  readonly initializer?: string
}

interface DeclaredView {
  readonly name: string
  readonly fields: readonly DeclaredMember[]
  readonly initializers: readonly { readonly parametersSource: string }[]
  readonly nested?: readonly DeclaredView[]
}

/** Top-level comma split that respects brackets, generics and strings. */
function splitParameters(source: string): string[] {
  const parts: string[] = []
  let depth = 0
  let start = 0
  for (let index = 0; index < source.length; index += 1) {
    const character = source[index]
    if (character === "\"") {
      for (index += 1; index < source.length && source[index] !== "\""; index += 1) if (source[index] === "\\") index += 1
      continue
    }
    if ("([{<".includes(character)) depth += 1
    else if (")]}>".includes(character) && source[index - 1] !== "-") depth -= 1
    else if (character === "," && depth === 0) {
      parts.push(source.slice(start, index))
      start = index + 1
    }
  }
  parts.push(source.slice(start))
  return parts.map(part => part.trim()).filter(Boolean)
}

/**
 * Canonical `.mun` declaration rules: Swift type spellings, and access levels
 * with a defined meaning. `private`/`fileprivate` members are internal to
 * their View — never memberwise parameters — so they need a default value and
 * cannot be a @Binding (which only a caller can supply).
 */
export function validateCanonicalDeclarations(views: readonly DeclaredView[]): void {
  for (const view of views) {
    for (const member of view.fields) {
      const what = `${view.name}.${member.name}`
      if (member.type) parseMunType(member.type, { canonical: true, what })
      const hidden = member.access === "private" || member.access === "fileprivate"
      if (hidden && member.kind === "binding") {
        throw new SyntaxError(`${what}: a @Binding cannot be ${member.access}; its caller must supply it`)
      }
      if (hidden && member.kind === "stored" && member.initializer === undefined) {
        throw new SyntaxError(`${what}: a ${member.access} member needs a default value (${member.access} members are not memberwise-initializer parameters)`)
      }
      if (member.kind === "state" && member.initializer === undefined) {
        throw new SyntaxError(`${what}: @State requires an initial value`)
      }
      if (!member.type && member.initializer === undefined) {
        throw new SyntaxError(`${what}: declare a type or an initial value to infer it from`)
      }
    }
    for (const initializer of view.initializers) {
      for (const parameter of splitParameters(initializer.parametersSource)) {
        const colon = parameter.indexOf(":")
        if (colon < 0) continue
        const type = parameter.slice(colon + 1).split(/\s=\s/)[0].replace(/^\s*@\w+\s*/, "")
        parseMunType(type, { canonical: true, what: `${view.name}.init parameter '${parameter.slice(0, colon).trim()}'` })
      }
    }
    validateCanonicalDeclarations(view.nested ?? [])
  }
}

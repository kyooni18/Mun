/**
 * Renderer-neutral semantic symbols shared by the compiler, IDE, and runtime.
 *
 * This module deliberately contains no renderer or TypeScript AST dependency.
 * The compiler adapts Vune/TypeScript syntax to these symbols, while ViewType
 * exposes the same symbols for runtime resolution and tooling.
 */

import { arrayCheck } from "./graph/arrays.js"

export type SemanticInitializerParameterKind = "value" | "binding" | "viewBuilder" | "action"

export interface SemanticInitializerParameter {
  readonly name?: string
  readonly label?: string
  /** The source call must provide this parameter with its declaration label. */
  readonly labelRequired?: boolean
  readonly kind: SemanticInitializerParameterKind
  readonly required?: boolean
  readonly variadic?: boolean
  /** The source call may provide this closure as the trailing closure. */
  readonly trailing?: boolean
  readonly type?: string
  readonly properties?: readonly string[]
}

export interface SemanticInitializerSymbol {
  readonly kind: "initializer"
  readonly index: number
  readonly signature: string
  readonly parameters: readonly SemanticInitializerParameter[]
}

export interface SemanticFieldSymbol {
  readonly name: string
  readonly kind: "stored" | "state" | "binding"
  readonly type?: string
  readonly defaultValue?: string
}

export interface SemanticStructSymbol {
  readonly kind: "struct" | "view"
  readonly name: string
  readonly qualifiedName: string
  readonly genericParameters?: string
  readonly fields: readonly SemanticFieldSymbol[]
  readonly initializers: readonly SemanticInitializerSymbol[]
}

export interface SemanticViewTypeSymbol extends SemanticStructSymbol {
  readonly kind: "view"
}

export interface SemanticStateSymbol {
  readonly kind: "state"
  readonly name?: string
  readonly type?: string
}

export interface SemanticBindingSymbol {
  readonly kind: "binding"
  readonly name?: string
  readonly type?: string
}

export interface SemanticBuilderTypeSymbol {
  readonly kind: "builder"
  readonly name: string
  readonly contentType?: string
  readonly operations?: readonly ("buildBlock" | "buildOptional" | "buildEither" | "buildArray")[]
}

export interface SemanticForeignComponentTypeSymbol {
  readonly kind: "foreign-component"
  readonly localName: string
  readonly module?: string
  readonly props?: string
  readonly events?: string
  readonly slots?: string
  readonly ref?: string
  readonly rendererAdapter?: string
}

export type SemanticHtmlAttributeCategory = "global" | "tag" | "event" | "aria" | "data" | "custom"

export type SemanticHtmlAttributeValueType =
  | "string"
  | "number"
  | "boolean"
  | "event"
  | "unknown"
  | "string | number"
  | "string | number | boolean"

export interface SemanticHtmlAttributeSpec {
  readonly name: string
  readonly category: SemanticHtmlAttributeCategory
  readonly type: SemanticHtmlAttributeValueType
  readonly values?: readonly string[]
}

export interface SemanticHtmlTagSpec {
  readonly tag: string
  readonly custom: boolean
  readonly attributes: readonly SemanticHtmlAttributeSpec[]
}

export interface SemanticHtmlAttributeSymbol {
  readonly name: string
  readonly category: SemanticHtmlAttributeCategory
  readonly type: SemanticHtmlAttributeValueType
  readonly valueType?: string
}

export interface SemanticHtmlElementSymbol {
  readonly kind: "html-element"
  /** Stable per-file semantic identity, for example `Element#42`. */
  readonly name: string
  readonly tag: string
  readonly custom: boolean
  readonly attributes: readonly SemanticHtmlAttributeSymbol[]
}

export type SemanticSymbol =
  | SemanticStructSymbol
  | SemanticViewTypeSymbol
  | SemanticInitializerSymbol
  | SemanticStateSymbol
  | SemanticBindingSymbol
  | SemanticBuilderTypeSymbol
  | SemanticForeignComponentTypeSymbol
  | SemanticHtmlElementSymbol

const globalHtmlAttributes: readonly SemanticHtmlAttributeSpec[] = [
  { name: "id", category: "global", type: "string" },
  { name: "class", category: "global", type: "string" },
  { name: "className", category: "global", type: "string" },
  { name: "style", category: "global", type: "unknown" },
  { name: "title", category: "global", type: "string" },
  { name: "role", category: "global", type: "string" },
  { name: "hidden", category: "global", type: "boolean" },
  { name: "lang", category: "global", type: "string" },
  { name: "dir", category: "global", type: "string", values: ["ltr", "rtl", "auto"] },
  { name: "tabindex", category: "global", type: "number" },
  { name: "tabIndex", category: "global", type: "number" },
  { name: "draggable", category: "global", type: "boolean" },
  { name: "spellcheck", category: "global", type: "boolean" },
  { name: "contenteditable", category: "global", type: "string", values: ["true", "false", "plaintext-only"] },
  { name: "slot", category: "global", type: "string" },
  { name: "part", category: "global", type: "string" },
  { name: "ref", category: "global", type: "unknown" },
]

const htmlEventNames = [
  "onclick", "onClick", "onchange", "onChange", "oninput", "onInput", "onsubmit", "onSubmit",
  "onkeydown", "onKeyDown", "onkeyup", "onKeyUp", "onfocus", "onFocus", "onblur", "onBlur",
  "onpointerdown", "onPointerDown", "onpointermove", "onPointerMove", "onpointerup", "onPointerUp",
  "onpointerenter", "onPointerEnter", "onpointerleave", "onPointerLeave", "onmouseenter", "onMouseEnter",
  "onmouseleave", "onMouseLeave", "onmousemove", "onMouseMove", "onmouseover", "onMouseOver",
  "oncontextmenu", "onContextMenu", "ondblclick", "onDoubleClick", "onwheel", "onWheel",
  "onscroll", "onScroll", "onfocusin", "onFocusIn", "onfocusout", "onFocusOut",
  "oncompositionstart", "onCompositionStart", "oncompositionend", "onCompositionEnd",
  "ondragstart", "onDragStart", "ondragover", "onDragOver", "ondrop", "onDrop",
  "oncopy", "onCopy", "oncut", "onCut", "onpaste", "onPaste", "ontouchstart", "onTouchStart",
  "ontouchmove", "onTouchMove", "ontouchend", "onTouchEnd", "onload", "onLoad", "onerror", "onError",
] as const

const eventHtmlAttributes: readonly SemanticHtmlAttributeSpec[] = htmlEventNames.map(name => ({
  name,
  category: "event" as const,
  type: "event" as const,
}))

const tagHtmlAttributes: Readonly<Record<string, readonly SemanticHtmlAttributeSpec[]>> = {
  a: [
    { name: "href", category: "tag", type: "string" }, { name: "target", category: "tag", type: "string" },
    { name: "rel", category: "tag", type: "string" }, { name: "download", category: "tag", type: "string" },
    { name: "hreflang", category: "tag", type: "string" },
  ],
  button: [
    { name: "type", category: "tag", type: "string", values: ["button", "submit", "reset"] },
    { name: "disabled", category: "tag", type: "boolean" }, { name: "name", category: "tag", type: "string" },
    { name: "value", category: "tag", type: "string | number" }, { name: "autofocus", category: "tag", type: "boolean" },
    { name: "form", category: "tag", type: "string" },
  ],
  form: [
    { name: "action", category: "tag", type: "string" }, { name: "method", category: "tag", type: "string", values: ["get", "post", "dialog"] },
    { name: "enctype", category: "tag", type: "string" }, { name: "target", category: "tag", type: "string" },
    { name: "novalidate", category: "tag", type: "boolean" }, { name: "autocomplete", category: "tag", type: "string", values: ["on", "off"] },
  ],
  img: [
    { name: "src", category: "tag", type: "string" }, { name: "alt", category: "tag", type: "string" },
    { name: "width", category: "tag", type: "string | number" }, { name: "height", category: "tag", type: "string | number" },
    { name: "loading", category: "tag", type: "string", values: ["eager", "lazy"] },
    { name: "decoding", category: "tag", type: "string", values: ["sync", "async", "auto"] },
  ],
  input: [
    { name: "type", category: "tag", type: "string" }, { name: "value", category: "tag", type: "string | number" },
    { name: "checked", category: "tag", type: "boolean" }, { name: "disabled", category: "tag", type: "boolean" },
    { name: "readonly", category: "tag", type: "boolean" }, { name: "required", category: "tag", type: "boolean" },
    { name: "multiple", category: "tag", type: "boolean" }, { name: "name", category: "tag", type: "string" },
    { name: "placeholder", category: "tag", type: "string" }, { name: "min", category: "tag", type: "string | number" },
    { name: "max", category: "tag", type: "string | number" }, { name: "step", category: "tag", type: "string | number" },
    { name: "accept", category: "tag", type: "string" }, { name: "autocomplete", category: "tag", type: "string" },
  ],
  label: [{ name: "for", category: "tag", type: "string" }, { name: "htmlFor", category: "tag", type: "string" }],
  option: [
    { name: "value", category: "tag", type: "string | number" }, { name: "selected", category: "tag", type: "boolean" },
    { name: "disabled", category: "tag", type: "boolean" }, { name: "label", category: "tag", type: "string" },
  ],
  select: [
    { name: "value", category: "tag", type: "string | number" }, { name: "disabled", category: "tag", type: "boolean" },
    { name: "required", category: "tag", type: "boolean" }, { name: "multiple", category: "tag", type: "boolean" },
    { name: "name", category: "tag", type: "string" },
  ],
  textarea: [
    { name: "value", category: "tag", type: "string" }, { name: "disabled", category: "tag", type: "boolean" },
    { name: "readonly", category: "tag", type: "boolean" }, { name: "required", category: "tag", type: "boolean" },
    { name: "name", category: "tag", type: "string" }, { name: "placeholder", category: "tag", type: "string" },
    { name: "rows", category: "tag", type: "number" }, { name: "cols", category: "tag", type: "number" },
    { name: "maxlength", category: "tag", type: "number" },
  ],
  audio: [
    { name: "src", category: "tag", type: "string" }, { name: "controls", category: "tag", type: "boolean" },
    { name: "autoplay", category: "tag", type: "boolean" }, { name: "loop", category: "tag", type: "boolean" },
    { name: "muted", category: "tag", type: "boolean" }, { name: "preload", category: "tag", type: "string", values: ["none", "metadata", "auto"] },
  ],
  video: [
    { name: "src", category: "tag", type: "string" }, { name: "controls", category: "tag", type: "boolean" },
    { name: "autoplay", category: "tag", type: "boolean" }, { name: "loop", category: "tag", type: "boolean" },
    { name: "muted", category: "tag", type: "boolean" }, { name: "preload", category: "tag", type: "string", values: ["none", "metadata", "auto"] },
  ],
  progress: [{ name: "value", category: "tag", type: "number" }, { name: "max", category: "tag", type: "number" }],
  meter: [{ name: "value", category: "tag", type: "number" }, { name: "max", category: "tag", type: "number" }],
  td: [
    { name: "colspan", category: "tag", type: "number" }, { name: "rowspan", category: "tag", type: "number" },
    { name: "headers", category: "tag", type: "string" }, { name: "scope", category: "tag", type: "string", values: ["row", "col", "rowgroup", "colgroup"] },
  ],
  th: [
    { name: "colspan", category: "tag", type: "number" }, { name: "rowspan", category: "tag", type: "number" },
    { name: "headers", category: "tag", type: "string" }, { name: "scope", category: "tag", type: "string", values: ["row", "col", "rowgroup", "colgroup"] },
  ],
}

export const semanticHtmlTagNames = Object.freeze([
  "a", "abbr", "address", "area", "article", "aside", "audio", "b", "base", "bdi", "bdo", "blockquote", "body", "br",
  "button", "canvas", "caption", "cite", "code", "col", "colgroup", "data", "datalist", "dd", "del", "details", "dfn",
  "dialog", "div", "dl", "dt", "em", "embed", "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3",
  "h4", "h5", "h6", "head", "header", "hgroup", "hr", "html", "i", "iframe", "img", "input", "ins", "kbd", "label",
  "legend", "li", "link", "main", "map", "mark", "menu", "meta", "meter", "nav", "noscript", "object", "ol", "optgroup",
  "option", "output", "p", "picture", "pre", "progress", "q", "rp", "rt", "ruby", "s", "samp", "script", "search", "section",
  "select", "slot", "small", "source", "span", "strong", "style", "sub", "summary", "sup", "table", "tbody", "td", "template",
  "textarea", "tfoot", "th", "thead", "time", "title", "tr", "track", "u", "ul", "var", "video", "wbr",
] as const)

const ariaAttribute: SemanticHtmlAttributeSpec = { name: "aria-*", category: "aria", type: "string | number | boolean" }
const dataAttribute: SemanticHtmlAttributeSpec = { name: "data-*", category: "data", type: "string | number | boolean" }

export function semanticHtmlTagSpec(tag: string): SemanticHtmlTagSpec {
  const normalized = tag.toLowerCase()
  const custom = normalized.includes("-") && !semanticHtmlTagNames.includes(normalized as typeof semanticHtmlTagNames[number])
  return {
    tag,
    custom,
    attributes: [...globalHtmlAttributes, ...eventHtmlAttributes, ...(tagHtmlAttributes[normalized] ?? []), ariaAttribute, dataAttribute],
  }
}

export function semanticHtmlAttributeSpec(tag: string, name: string): SemanticHtmlAttributeSpec | undefined {
  const spec = semanticHtmlTagSpec(tag)
  const exact = spec.attributes.find(attribute => attribute.name === name)
  if (exact) return exact
  if (name.startsWith("aria-")) return ariaAttribute
  if (name.startsWith("data-")) return dataAttribute
  if (spec.custom) return { name, category: "custom", type: "unknown" }
  return undefined
}

export function semanticHtmlAttributeNames(tag: string): readonly string[] {
  return semanticHtmlTagSpec(tag).attributes.map(attribute => attribute.name)
}

export type SemanticArgumentKind = "value" | "binding" | "viewBuilder" | "action"

/** A syntax/type-checker description of a call argument. */
export interface SemanticArgument {
  readonly label?: string
  /** True only for the closure written after the closing parenthesis. */
  readonly trailing?: boolean
  /** Runtime value, when resolution is happening after compilation. */
  readonly value?: unknown
  /** TypeScript type text, when resolution is happening before runtime. */
  readonly type?: string
  /** The value type behind State<T>/Binding<T>, when available at runtime. */
  readonly underlyingType?: string
  readonly kind?: SemanticArgumentKind
  readonly closureRole?: "viewBuilder" | "action"
}

export interface SemanticInitializerResolution {
  readonly initializerIndex: number
  readonly initializer: SemanticInitializerSymbol
  /** Arguments normalized into declaration parameter order. */
  readonly arguments: readonly SemanticArgument[]
  readonly score: number
}

export type SemanticClosureRole = SemanticInitializerParameterKind

export interface SemanticResolutionDiagnostic {
  readonly code: "VUNE_INITIALIZER" | "VUNE_INITIALIZER_AMBIGUITY"
  readonly message: string
}

/**
 * The one semantic answer for a Vune call.
 *
 * Compiler, editor, and runtime adapters may have different inputs (source
 * types versus runtime values), but they consume this same result shape. An
 * absent view type means that the call is not statically known to Vune and is
 * therefore left to the host language's dynamic interop rules.
 */
export interface SemanticCallResolution {
  readonly resolvedViewType: SemanticViewTypeSymbol | undefined
  readonly resolvedInitializer: SemanticInitializerSymbol | undefined
  /** Types in source argument order, including the trailing closure. */
  readonly argumentTypes: readonly (string | undefined)[]
  /** Roles in source argument order, including the trailing closure. */
  readonly closureRoles: readonly (SemanticClosureRole | undefined)[]
  readonly inferredGenerics: Readonly<Record<string, string>>
  readonly diagnostics: readonly SemanticResolutionDiagnostic[]
  readonly score?: number
}

export interface SemanticInitializerResolutionFailure {
  readonly kind: "none" | "ambiguous"
  readonly candidates: readonly SemanticInitializerSymbol[]
}

export type SemanticInitializerResolutionResult =
  | { readonly ok: true; readonly resolution: SemanticInitializerResolution }
  | { readonly ok: false; readonly failure: SemanticInitializerResolutionFailure }

function runtimeType(value: unknown): string | undefined {
  if (value === undefined) return "undefined"
  if (value === null) return "null"
  if (arrayCheck(value) === true) return "array"
  if (typeof value === "function") return "function"
  if (typeof value === "object") return "object"
  return typeof value
}

function genericConstraint(genericParameters: string | undefined, type: string): string | undefined {
  if (!genericParameters || !/^[$A-Za-z_][A-Za-z0-9_]*$/.test(type.trim())) return undefined
  const escaped = type.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const match = new RegExp(`(?:^|,)\\s*${escaped}\\s*(?:=[^:,>]+)?\\s*(?::\\s*([^,>]+))?`).exec(genericParameters)
  return match?.[1]?.trim() ?? (match ? "unknown" : undefined)
}

function splitTypeAlternatives(type: string): readonly string[] {
  const result: string[] = []
  let start = 0
  let angle = 0
  let square = 0
  let parens = 0
  for (let index = 0; index < type.length; index += 1) {
    switch (type[index]) {
      case "<": angle += 1; break
      case ">": angle = Math.max(0, angle - 1); break
      case "[": square += 1; break
      case "]": square = Math.max(0, square - 1); break
      case "(": parens += 1; break
      case ")": parens = Math.max(0, parens - 1); break
      case "|":
        if (angle === 0 && square === 0 && parens === 0) {
          result.push(type.slice(start, index).trim())
          start = index + 1
        }
        break
    }
  }
  result.push(type.slice(start).trim())
  return result.filter(Boolean)
}

function normalizedType(type: string): string {
  return type.trim().replace(/\s+/g, " ").replace(/\?$/, "")
}

function stringLiteralTypeValue(type: string | undefined): string | undefined {
  if (!type || !/^['"].*['"]$/.test(type)) return undefined
  if (type.startsWith('"')) {
    try { return JSON.parse(type) as string } catch { return undefined }
  }
  return type.slice(1, -1)
}

function semanticArrayValues(value: unknown): readonly unknown[] | undefined {
  if (arrayCheck(value) !== true) return undefined
  const values = value as readonly unknown[]
  try {
    const length = Object.getOwnPropertyDescriptor(values, "length")
    if (!length || !("value" in length) || !Number.isSafeInteger(length.value) || length.value < 0) return undefined
    const items: unknown[] = []
    for (let index = 0; index < length.value; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(values, String(index))
      if (!descriptor || !("value" in descriptor)) return undefined
      items.push(descriptor.value)
    }
    return items
  } catch {
    return undefined
  }
}

/** Return true for an exact match, false for a contradiction, undefined for an unknown. */
function typeMatch(type: string | undefined, argument: SemanticArgument, genericParameters?: string): boolean | undefined {
  if (!type) return undefined
  const expected = normalizedType(type)
  if (!expected || expected === "unknown" || expected === "any") return undefined
  const alternatives = splitTypeAlternatives(expected)
  if (alternatives.length > 1) {
    const results = alternatives.map(alternative => typeMatch(alternative, argument, genericParameters))
    if (results.some(result => result === true)) return true
    return results.some(result => result === undefined) ? undefined : false
  }
  const actual = argument.type ?? runtimeType(argument.value)
  const valueType = argument.underlyingType ?? actual
  const comparableType = argument.kind === "binding" && !/^Binding(?:Ref)?\s*</.test(expected) ? valueType : actual
  const value = argument.value
  if (expected === "null") return value === null || actual === "null"
  if (expected === "undefined" || expected === "void") return value === undefined || actual === "undefined"

  const generic = genericConstraint(genericParameters, expected)
  if (generic) {
    if (/\bView\b/.test(generic)) {
      return actual === "View" || actual === "element" || actual === "view" || actual === "function" || (!!actual && !/^(?:string|number|boolean|unknown|any|null|undefined|void|array)$/.test(actual) && !/=>/.test(actual))
    }
    return undefined
  }

  if (/^(?:some\s+)?View$/.test(expected)) return actual === "View" || actual === "element" || actual === "view" || (!!actual && !/^(?:string|number|boolean|function|unknown|any|null|undefined|void|array)$/.test(actual) && !/=>/.test(actual))
  if (expected === "string") return comparableType === "string" || stringLiteralTypeValue(comparableType) !== undefined
  if (expected === "number") return comparableType === "number"
  if (expected === "boolean") return comparableType === "boolean"
  if (expected === "object" || expected.startsWith("Record<")) return comparableType === "object" || (!!comparableType && !/^(?:string|number|boolean|function|unknown|any|null|undefined|void|array)$/.test(comparableType) && !/=>/.test(comparableType) && !/\[\]$/.test(comparableType))
  if (expected === "Function" || expected === "function" || expected.includes("=>")) return comparableType === "function" || comparableType?.includes("=>") === true || comparableType === "Function"
  const arrayElement = /^(?:Array|ReadonlyArray)\s*<([\s\S]+)>$/.exec(expected) ?? /^([\s\S]+)\[\]$/.exec(expected)
  if (arrayElement) {
    const arrayType = valueType === "array" || /(?:Array|ReadonlyArray)\s*</.test(valueType ?? "") || /\[\]$/.test(valueType ?? "")
    if (!arrayType) return false
    if (value === undefined) return true
    const items = semanticArrayValues(value)
    if (items === undefined) return false
    const matches = items.map(item => typeMatch(arrayElement[1], { value: item }, genericParameters))
    if (matches.some(match => match === false)) return false
    return matches.some(match => match === undefined) ? undefined : true
  }
  if (expected.toLowerCase() === "array") return valueType === "array" || /(?:Array|ReadonlyArray)\s*</.test(valueType ?? "") || /\[\]$/.test(valueType ?? "")
  if (/^Binding(?:Ref)?\s*</.test(expected)) return argument.kind === "binding" || actual === "binding"
  if (/^State(?:Ref)?\s*</.test(expected)) return actual === "state"
  if (/^['"].*['"]$/.test(expected)) {
    const expectedValue = stringLiteralTypeValue(expected)
    if (typeof value === "string") return value === expectedValue
    const actualValue = stringLiteralTypeValue(actual)
    return actualValue === undefined ? actual === "string" : actualValue === expectedValue
  }
  if (actual && normalizedType(actual) === expected) return true
  if (actual === "literal") return undefined
  return undefined
}

function parameterIndexForArgument(parameter: SemanticInitializerParameter, argument: SemanticArgument): boolean {
  return argument.label === undefined
    || argument.label === parameter.label
    || argument.label === parameter.name
    || (argument.label !== undefined && parameter.properties?.includes(argument.label) === true)
}

function normalizeArguments(
  candidate: SemanticInitializerSymbol,
  input: readonly SemanticArgument[],
): readonly SemanticArgument[] | undefined {
  const parameters = candidate.parameters
  const normalized: SemanticArgument[] = []
  const used = new Set<number>()
  let nextPositional = 0
  let sawLabel = false
  let lastLabeledIndex = -1
  for (const argument of input) {
    let index = argument.label === undefined && argument.trailing
      ? parameters.findIndex((parameter, parameterIndex) => parameter.trailing && parameterIndex === parameters.length - 1 && !used.has(parameterIndex))
      : argument.label === undefined
        ? (() => {
          // A trailing closure is allowed after labeled arguments; an
          // ordinary positional argument is not.
          while (used.has(nextPositional)) nextPositional += 1
          if (sawLabel && !argument.trailing && !(parameterAt(parameters, nextPositional)?.trailing && argument.type === "function")) return -1
          return nextPositional
        })()
      : parameters.findIndex(parameter => parameterIndexForArgument(parameter, argument))
    if (index < 0 || index >= parameters.length) return undefined
    const parameter = parameters[index]
    const propertyArgument = argument.label !== undefined && parameter.properties?.includes(argument.label) === true
    if (used.has(index)) {
      const previous = normalized[index]
      const previousProperty = previous?.label !== undefined && parameter.properties?.includes(previous.label) === true
      if (!propertyArgument || !previousProperty || previous.label === argument.label) return undefined
    }
    // A JavaScript host represents an omitted optional middle argument with
    // an explicit `undefined` placeholder. Compiler-side source arguments may
    // also lack a runtime value, so only the normalized `undefined` type marks
    // that placeholder; real source arguments must still satisfy labels.
    const omittedPlaceholder = argument.value === undefined && argument.type === "undefined"
    if (argument.label === undefined && parameter.labelRequired && !omittedPlaceholder) return undefined
    if (argument.label !== undefined) {
      if (index < lastLabeledIndex) return undefined
      sawLabel = true
      lastLabeledIndex = index
    }
    if (argument.trailing && (!parameter.trailing || index !== parameters.length - 1)) return undefined
    if (argument.label === undefined) nextPositional = index + 1
    used.add(index)
    if (!normalized[index]) normalized[index] = argument
  }
  for (let index = 0; index < parameters.length; index += 1) {
    if (normalized[index]) continue
    const parameter = parameters[index]
    if (parameter.required !== false) return undefined
    normalized[index] = { value: undefined, type: "undefined" }
  }
  const variadicIndex = parameters.length - 1
  if (parameters[variadicIndex]?.variadic && input.length >= parameters.length) {
    return input.length === parameters.length ? normalized : input
  }
  return normalized
}

function parameterAt(parameters: readonly SemanticInitializerParameter[], index: number): SemanticInitializerParameter | undefined {
  return parameters[index]
}

function candidateScore(
  candidate: SemanticInitializerSymbol,
  original: readonly SemanticArgument[],
  normalized: readonly SemanticArgument[],
  genericParameters?: string,
): number | undefined {
  const parameters = candidate.parameters
  const required = parameters.filter(parameter => parameter.required !== false).length
  if (original.length < required) return undefined
  let score = 0
  // Labels are the first discriminator, including their source order.
  const labeled = original.filter(argument => argument.label !== undefined)
  for (let index = 0; index < labeled.length; index += 1) {
    const parameter = parameters.find(parameter => parameter.label === labeled[index].label || parameter.name === labeled[index].label || parameter.properties?.includes(labeled[index].label ?? ""))
    if (!parameter) return undefined
    score += parameter.label === labeled[index].label ? 1_000_000 : 900_000
    if (parameter.label === labeled[index].label && (parameters.indexOf(parameter) === index || parameters.indexOf(parameter) === 0)) score += 10_000
  }
  // Exact arity outranks a candidate reached through omitted defaults.
  score += original.length === parameters.length ? 10_000 : 1_000 + (parameters.length - original.length)
  for (let index = 0; index < parameters.length; index += 1) {
    const parameter = parameters[index]
    const argument = normalized[index]
    if (!argument) continue
    if (argument.value === undefined && argument.type === "undefined") {
      if (parameter.required !== false) return undefined
      score += 10
      continue
    }
    const role = argument.closureRole ?? argument.kind
    const typedBindingValue = parameter.kind === "value" && role === "binding" && /^Binding(?:Ref)?\s*</.test(parameter.type ?? "")
    if (role && role !== parameter.kind && !(parameter.kind === "value" && (role === "value" || typedBindingValue))) return undefined
    if (parameter.kind === "viewBuilder" || parameter.kind === "action") {
      if (argument.value !== undefined && typeof argument.value !== "function") return undefined
      if (argument.type && argument.type !== "function" && !argument.type.includes("=>")) return undefined
      score += 1_000
    } else if (parameter.kind === "binding") {
      if (argument.value !== undefined && argument.kind !== "binding") return undefined
      if (argument.kind && argument.kind !== "binding") return undefined
      score += 900
    }
    // A label listed in `properties` belongs to an options carrier. Its
    // scalar type is the property's type, not the carrier's object type.
    const propertyLabel = argument.label !== undefined && parameter.properties?.includes(argument.label) === true
    const match = propertyLabel ? undefined : typeMatch(parameter.type, argument, genericParameters)
    if (match === false) return undefined
    score += match === true ? 500 : 50
  }
  return score
}

/**
 * Resolve a call using only semantic symbols. Both compiler arguments and
 * runtime values can be supplied; the latter are used as a richer type hint.
 */
export function resolveSemanticInitializer(
  initializers: readonly SemanticInitializerSymbol[],
  arguments_: readonly SemanticArgument[],
  genericParameters?: string,
): SemanticInitializerResolutionResult {
  const matches = initializers.flatMap(initializer => {
    const normalized = normalizeArguments(initializer, arguments_)
    if (!normalized) return []
    const score = candidateScore(initializer, arguments_, normalized, genericParameters)
    return score === undefined ? [] : [{ initializer, normalized, score }]
  }).sort((left, right) => right.score - left.score)
  const match = matches[0]
  if (!match) return { ok: false, failure: { kind: "none", candidates: initializers } }
  const tied = matches.filter(candidate => candidate.score === match.score)
  if (tied.length > 1) return { ok: false, failure: { kind: "ambiguous", candidates: tied.map(candidate => candidate.initializer) } }
  return {
    ok: true,
    resolution: {
      initializerIndex: initializers.indexOf(match.initializer),
      initializer: match.initializer,
      arguments: match.normalized,
      score: match.score,
    },
  }
}

function genericNames(genericParameters: string | undefined): readonly string[] {
  if (!genericParameters) return []
  return [...genericParameters.matchAll(/(?:^|,)\s*([$A-Za-z_][A-Za-z0-9_]*)\s*(?::|=|,|$)/g)].map(match => match[1])
}

function inferGenericArguments(
  viewType: SemanticViewTypeSymbol,
  initializer: SemanticInitializerSymbol | undefined,
  normalized: readonly SemanticArgument[] | undefined,
): Readonly<Record<string, string>> {
  if (!initializer || !normalized) return {}
  const names = new Set(genericNames(viewType.genericParameters))
  const inferred: Record<string, string> = {}
  initializer.parameters.forEach((parameter, index) => {
    const declared = parameter.type?.trim()
    const argument = normalized[index]
    if (!declared || !argument) return
    const actual = argument.type ?? argument.underlyingType
    if (!actual) return
    for (const name of names) {
      const exact = new RegExp(`(?:^|[<,( ])${name}(?:$|[>,) ])`).test(declared)
      if (!exact || actual === "unknown") continue
      if (actual === "function") {
        if (declared === name && /\bView\b/.test(genericConstraint(viewType.genericParameters, name) ?? "")) inferred[name] = "View"
        continue
      }
      if (declared === name || declared.endsWith(`[]`) && name === declared.slice(0, -2)) inferred[name] = actual
    }
  })
  return inferred
}

function parameterIndexForSourceArgument(
  initializer: SemanticInitializerSymbol,
  argument: SemanticArgument,
  sourceIndex: number,
  input: readonly SemanticArgument[],
): number | undefined {
  const parameters = initializer.parameters
  if (argument.trailing) {
    const trailing = parameters.findIndex(parameter => parameter.trailing && parameter === parameters.at(-1))
    return trailing < 0 ? undefined : trailing
  }
  if (argument.label !== undefined) {
    const labeled = parameters.findIndex(parameter => parameter.label === argument.label || parameter.name === argument.label)
    return labeled < 0 ? undefined : labeled
  }
  const used = new Set<number>()
  let nextPositional = 0
  for (let index = 0; index < sourceIndex; index += 1) {
    const previous = input[index]
    let resolved = previous.label !== undefined
      ? parameters.findIndex(parameter => parameter.label === previous.label || parameter.name === previous.label)
      : previous.trailing
        ? parameters.findIndex(parameter => parameter.trailing && parameter === parameters.at(-1))
        : (() => {
          while (used.has(nextPositional)) nextPositional += 1
          return nextPositional++
        })()
    if (resolved >= 0) used.add(resolved)
  }
  const next = parameters.findIndex((parameter, index) => !used.has(index))
  return next < 0 ? undefined : next
}

/** Resolve a statically known or runtime Vune call through the shared engine. */
export function resolveSemanticCall(
  viewType: SemanticViewTypeSymbol | undefined,
  arguments_: readonly SemanticArgument[],
): SemanticCallResolution {
  const argumentTypes = arguments_.map(argument => argument.type ?? runtimeType(argument.value))
  const unresolved: SemanticCallResolution = {
    resolvedViewType: viewType,
    resolvedInitializer: undefined,
    argumentTypes,
    closureRoles: arguments_.map(() => undefined),
    inferredGenerics: {},
    diagnostics: [],
  }
  if (!viewType) return unresolved

  const result = resolveSemanticInitializer(viewType.initializers, arguments_, viewType.genericParameters)
  if (!result.ok) {
    const candidates = result.failure.candidates.map(candidate => candidate.signature).join("; ")
    const prefix = result.failure.kind === "ambiguous" ? "Ambiguous initializer" : "No matching initializer"
    return {
      ...unresolved,
      diagnostics: [{
        code: result.failure.kind === "ambiguous" ? "VUNE_INITIALIZER_AMBIGUITY" : "VUNE_INITIALIZER",
        message: `${prefix} for ${viewType.name}.${candidates ? ` Available initializers: ${candidates}.` : ""}`,
      }],
    }
  }

  const closureRoles = arguments_.map((argument, index) => {
    const parameterIndex = parameterIndexForSourceArgument(result.resolution.initializer, argument, index, arguments_)
    return parameterIndex === undefined ? undefined : result.resolution.initializer.parameters[parameterIndex]?.kind
  })
  return {
    resolvedViewType: viewType,
    resolvedInitializer: result.resolution.initializer,
    argumentTypes,
    closureRoles,
    inferredGenerics: inferGenericArguments(viewType, result.resolution.initializer, result.resolution.arguments),
    diagnostics: [],
    score: result.resolution.score,
  }
}

/** A small registry used by language-service consumers and runtime adapters. */
export class SemanticModel {
  private readonly symbols = new Map<string, SemanticSymbol>()

  register(symbol: SemanticSymbol): void {
    const name = "name" in symbol && symbol.name
      ? symbol.name
      : "signature" in symbol
        ? symbol.signature
        : "localName" in symbol
          ? symbol.localName
          : symbol.kind
    this.symbols.set(name, symbol)
  }

  get<T extends SemanticSymbol = SemanticSymbol>(name: string): T | undefined {
    return this.symbols.get(name) as T | undefined
  }

  values(): readonly SemanticSymbol[] {
    return [...this.symbols.values()]
  }
}

import {
  resolveSemanticInitializer,
  type SemanticArgument,
  type SemanticInitializerParameter,
  type SemanticInitializerSymbol,
} from "@mun/core"

/**
 * Resolution of canonical SwiftUI-shaped calls against the parity manifest,
 * with source-oriented diagnostics. Shared by Views, modifiers and values so a
 * wrong label, order, role or Binding reads the same everywhere.
 */

export interface ContractArgument extends SemanticArgument {
  readonly source?: string
}

export interface ContractResolution<A extends ContractArgument> {
  readonly signature: string
  /** Supplied arguments keyed by parameter name (absent when defaulted). */
  readonly arguments: ReadonlyMap<string, A>
}

function parameterName(parameter: SemanticInitializerParameter, index: number): string {
  return parameter.name ?? parameter.label ?? `#${index}`
}

/** `init(_:text:)` → `TextField(_:text:)`, `frame(width:height:alignment:)` → `.frame(width:height:alignment:)`. */
export function displaySignature(owner: string, signature: string, kind: "view" | "modifier" | "value"): string {
  if (kind === "modifier") return `.${signature}`
  if (signature.startsWith("init(")) return `${owner}${signature.slice(4)}`
  return `${owner}.${signature}`
}

function spelledCall(owner: string, supplied: readonly ContractArgument[], kind: "view" | "modifier" | "value", member?: string): string {
  const labels = supplied.filter(argument => !argument.trailing).map(argument => `${argument.label ?? "_"}:`).join("")
  const trailing = supplied.some(argument => argument.trailing) ? " { … }" : ""
  const name = kind === "modifier" ? `.${owner}` : member ? `${owner}.${member}` : owner
  return `${name}(${labels})${trailing}`
}

/** Why `supplied` does not fit `candidate`, or undefined when no specific reason is found. */
function mismatch(candidate: SemanticInitializerSymbol, supplied: readonly ContractArgument[]): string | undefined {
  const parameters = candidate.parameters
  const labels = parameters.map(parameter => parameter.label)
  const used = new Set<number>()
  let cursor = 0
  let lastLabeled = -1
  for (const argument of supplied) {
    if (argument.trailing) {
      const last = parameters.length - 1
      const parameter = parameters[last]
      if (!parameter?.trailing || used.has(last)) return "it does not take a trailing closure"
      if (parameter.kind !== "viewBuilder" && parameter.kind !== "action") return "it does not take a trailing closure"
      used.add(last)
      continue
    }
    if (argument.label !== undefined) {
      const index = parameters.findIndex(parameter => parameter.label === argument.label)
      if (index < 0) {
        const valid = labels.filter((label): label is string => label !== undefined).map(label => `${label}:`)
        return `it has no argument label '${argument.label}:'${valid.length ? ` (labels: ${valid.join(", ")})` : ""}`
      }
      if (index < lastLabeled) return `argument '${argument.label}:' must come before '${parameters[lastLabeled]?.label}:'`
      if (used.has(index)) return `argument '${argument.label}:' is repeated`
      const parameter = parameters[index]
      const problem = roleMismatch(parameter, argument)
      if (problem) return problem
      used.add(index)
      lastLabeled = index
      cursor = index + 1
      continue
    }
    while (used.has(cursor)) cursor += 1
    const parameter = parameters[cursor]
    const earlier = parameters.findIndex((candidate, index) => index < lastLabeled && !used.has(index) && !candidate.labelRequired)
    if (earlier >= 0 && (!parameter || parameter.labelRequired)) {
      return `the unlabeled argument must come before '${parameters[lastLabeled]?.label}:'`
    }
    if (!parameter) return "it has too many arguments"
    if (parameter.labelRequired) return `argument ${cursor + 1} needs the label '${parameter.label}:'`
    const problem = roleMismatch(parameter, argument)
    if (problem) return problem
    used.add(cursor)
    cursor += 1
  }
  const missing = parameters.find((parameter, index) => parameter.required !== false && !used.has(index))
  if (missing) {
    return missing.kind === "viewBuilder" || missing.kind === "action"
      ? `it requires the '${missing.label ?? parameterName(missing, 0)}' closure`
      : `it requires '${missing.label ? `${missing.label}:` : parameterName(missing, 0)}'`
  }
  return undefined
}

function roleMismatch(parameter: SemanticInitializerParameter, argument: ContractArgument): string | undefined {
  const name = parameter.label ? `'${parameter.label}:'` : `'${parameter.name ?? "value"}'`
  if (parameter.kind === "binding" && argument.kind !== "binding") {
    return `${name} requires a Binding — pass $state`
  }
  if (parameter.kind !== "binding" && argument.kind === "binding") {
    return `${name} takes a value, not a Binding — remove the $`
  }
  if ((parameter.kind === "viewBuilder" || parameter.kind === "action") && argument.type !== "function") {
    return `${name} requires a closure`
  }
  if (parameter.kind === "value" && argument.type === "function" && parameter.type !== "function") {
    return `${name} does not take a closure`
  }
  if (parameter.kind === "value" && parameter.type && argument.type && argument.type !== "dynamic") {
    const expected = parameter.type
    const actual = argument.type
    const scalar = ["string", "number", "boolean"]
    if (scalar.includes(expected) && scalar.includes(actual) && expected !== actual) {
      return `${name} expects ${swiftTypeName(expected)}, received ${swiftTypeName(actual)}`
    }
  }
  return undefined
}

export function swiftTypeName(type: string): string {
  switch (type) {
    case "string": return "String"
    case "number": return "Double"
    case "boolean": return "Bool"
    case "array": return "Array"
    case "object": return "a record"
    default: return type
  }
}

export interface ContractDiagnosticContext {
  readonly kind: "view" | "modifier" | "value"
  readonly owner: string
  readonly member?: string
  /** SDK titles of this owner that Mün deliberately does not implement. */
  readonly unsupported?: readonly string[]
}

/** Resolve `supplied` against `symbols` or throw a source-oriented diagnostic. */
export function resolveContractCall<A extends ContractArgument>(
  symbols: readonly SemanticInitializerSymbol[],
  supplied: readonly A[],
  context: ContractDiagnosticContext,
): ContractResolution<A> {
  const result = resolveSemanticInitializer(symbols, supplied)
  if (result.ok) {
    const initializer = result.resolution.initializer
    const byName = new Map<string, A>()
    initializer.parameters.forEach((parameter, index) => {
      const argument = result.resolution.arguments[index] as A | undefined
      if (argument && !(argument.type === "undefined" && argument.value === undefined)) {
        byName.set(parameterName(parameter, index), argument)
      }
    })
    return { signature: initializer.signature, arguments: byName }
  }
  throw new SyntaxError(contractDiagnostic(symbols, supplied, context, result.failure.kind === "ambiguous"))
}

function contractDiagnostic(
  symbols: readonly SemanticInitializerSymbol[],
  supplied: readonly ContractArgument[],
  context: ContractDiagnosticContext,
  ambiguous: boolean,
): string {
  const call = spelledCall(context.owner, supplied, context.kind, context.member)
  const supported = symbols.map(symbol => displaySignature(context.member ? `${context.owner}` : context.owner, symbol.signature, context.kind))
  const list = `Mün supports: ${supported.join("; ")}.`
  if (ambiguous) return `Ambiguous call ${call}. ${list}`
  const attempted = `${context.kind === "modifier" ? "" : context.member ? `${context.member}` : "init"}(${supplied.filter(argument => !argument.trailing).map(argument => `${argument.label ?? "_"}:`).join("")}${supplied.some(argument => argument.trailing) ? `${trailingLabel(symbols) ?? "content"}:` : ""})`
  const attemptedTitle = context.kind === "modifier" ? `${context.owner}${attempted}` : attempted
  if (context.unsupported?.includes(attemptedTitle)) {
    return `${displaySignature(context.owner, attemptedTitle, context.kind)} is a SwiftUI ${context.kind === "modifier" ? "modifier" : "initializer"} that Mün does not implement. ${list}`
  }
  // Report the candidate whose labels overlap the call the most.
  const suppliedLabels = new Set(supplied.flatMap(argument => argument.label ? [argument.label] : []))
  const ranked = [...symbols].sort((left, right) => overlap(right, suppliedLabels) - overlap(left, suppliedLabels))
  for (const candidate of ranked) {
    const reason = mismatch(candidate, supplied)
    if (reason) return `${call} does not match ${displaySignature(context.owner, candidate.signature, context.kind)}: ${reason}. ${list}`
  }
  return `${call} does not match a supported signature. ${list}`
}

function trailingLabel(symbols: readonly SemanticInitializerSymbol[]): string | undefined {
  for (const symbol of symbols) {
    const last = symbol.parameters.at(-1)
    if (last?.trailing) return last.label
  }
  return undefined
}

function overlap(symbol: SemanticInitializerSymbol, labels: ReadonlySet<string>): number {
  return symbol.parameters.filter(parameter => parameter.label && labels.has(parameter.label)).length
}

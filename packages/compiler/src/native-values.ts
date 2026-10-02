import {
  Animation,
  type MunUiOverlayAlignment,
  type MunUiPaint,
  type MunUiTransition,
  type TransitionEffect,
} from "@mun/core"
import {
  munExtension,
  nativeValueMemberSymbols,
  swiftUIApiManifest,
} from "@mun/core/swiftui-manifest"
import { parseMunBuilder, type MunArgument } from "./ast.js"
import { resolveContractCall, type ContractArgument } from "./native-contract.js"
import { splitTopLevel } from "./scanner.js"

/**
 * Lowering of SwiftUI value expressions (Color, LinearGradient, Animation,
 * AnyTransition) for native Semantic UI IR. Values are written with Swift
 * labels (`Color(red: 1, green: 0, blue: 0)`, `.linear(duration: 0.2)`), so
 * they are parsed as Mün member chains rather than TypeScript expressions.
 */

export interface MemberSegment {
  readonly name: string
  /** Absent for a property access (`Color.red`). */
  readonly arguments?: readonly MunArgument[]
}

export interface MemberChain {
  /** Explicit owner type (`Color` in `Color.red`), absent for `.red`. */
  readonly owner?: string
  /** True when the chain begins with a call on the owner (`Color(…)`). */
  readonly ownerCall?: readonly MunArgument[]
  readonly members: readonly MemberSegment[]
}

function parseArguments(source: string): readonly MunArgument[] {
  if (!source.trim()) return []
  const statement = parseMunBuilder(`M(${source})`).statements[0]
  if (!statement || statement.kind !== "call") throw new SyntaxError(`Invalid arguments: (${source})`)
  return statement.arguments
}

function matchingParen(source: string, open: number): number {
  let depth = 0
  for (let index = open; index < source.length; index += 1) {
    const character = source[index]
    if (character === "\"" || character === "'") {
      for (index += 1; index < source.length && source[index] !== character; index += 1) {
        if (source[index] === "\\") index += 1
      }
      continue
    }
    if (character === "(" || character === "[" || character === "{") depth += 1
    else if (character === ")" || character === "]" || character === "}") {
      depth -= 1
      if (depth === 0) return index
    }
  }
  throw new SyntaxError(`Unbalanced parentheses in ${source}`)
}

/** `Color.red.opacity(0.5)`, `.linear(duration: 1).delay(2)`, `Color(red: 1, green: 0, blue: 0)`. */
export function parseMemberChain(source: string): MemberChain | undefined {
  const text = source.trim()
  let cursor = 0
  let owner: string | undefined
  let ownerCall: readonly MunArgument[] | undefined
  const members: MemberSegment[] = []
  if (text[0] !== ".") {
    const head = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text)
    if (!head || !/^[A-Z]/.test(head[0])) return undefined
    owner = head[0]
    cursor = head[0].length
    if (text[cursor] === "(") {
      const close = matchingParen(text, cursor)
      ownerCall = parseArguments(text.slice(cursor + 1, close))
      cursor = close + 1
    }
  }
  while (cursor < text.length) {
    if (text[cursor] !== ".") return undefined
    const name = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(cursor + 1))
    if (!name) return undefined
    cursor += 1 + name[0].length
    if (text[cursor] === "(") {
      const close = matchingParen(text, cursor)
      members.push({ name: name[0], arguments: parseArguments(text.slice(cursor + 1, close)) })
      cursor = close + 1
    } else {
      members.push({ name: name[0] })
    }
  }
  return { owner, ownerCall, members }
}

interface ValueArgument extends ContractArgument {
  readonly source: string
}

function contractArguments(args: readonly MunArgument[]): ValueArgument[] {
  return args.map(argument => {
    if (argument.value.kind === "closure") throw new SyntaxError("Value arguments cannot be closures")
    const source = argument.value.source.trim()
    return { label: argument.label, source, type: staticType(source) }
  })
}

function staticType(source: string): string | undefined {
  if (/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(source)) return "number"
  if (source === "true" || source === "false") return "boolean"
  if (/^"(?:[^"\\]|\\.)*"$/.test(source)) return "string"
  if (/^\.[A-Za-z_]\w*$/.test(source)) return "string"
  if (/^\[/.test(source)) return "array"
  return undefined
}

function resolveMember(type: string, member: string, args: readonly MunArgument[]): ValueArguments {
  const symbols = nativeValueMemberSymbols(type, member)
  if (!symbols) throw new SyntaxError(`${type}.${member}(…) is not a SwiftUI ${type} member that Mün implements`)
  return resolveContractCall(symbols, contractArguments(args), { kind: "value", owner: type, member }).arguments
}

function nativeStaticMember(type: string, member: string): boolean {
  const spec = swiftUIApiManifest.values.find(value => value.name === type)
  return (spec?.members as readonly { readonly signature: string; readonly native?: string }[] | undefined)
    ?.some(overload => overload.signature === member && overload.native !== undefined) === true
}

export function staticNumber(source: string | undefined, what: string): number {
  if (source === undefined) throw new SyntaxError(`${what} is required`)
  const value = Number(source.trim())
  if (!/^-?\d+(?:\.\d+)?(?:e[+-]?\d+)?$/i.test(source.trim()) || !Number.isFinite(value)) {
    throw new SyntaxError(`${what} must be a static number: ${source}`)
  }
  return value
}

function staticBoolean(source: string | undefined, fallback: boolean, what: string): boolean {
  if (source === undefined) return fallback
  if (source.trim() === "true") return true
  if (source.trim() === "false") return false
  throw new SyntaxError(`${what} must be true or false: ${source}`)
}

function implicitMember(source: string | undefined): string | undefined {
  return source === undefined ? undefined : /^\.([A-Za-z_]\w*)$/.exec(source.trim())?.[1]
}

function compatibility(kind: "value", name: string, spelled: string): never {
  const spec = munExtension(kind, name)
  throw new SyntaxError(`${spelled} is a compatibility-only Mün spelling.${spec?.replacement ? ` Use ${spec.replacement}.` : ""}`)
}

// Fixed sRGB values for SwiftUI's named colors (macOS light appearance;
// see the `appearance` global divergence).
const namedColors: Readonly<Record<string, string>> = {
  black: "#000000", blue: "#007AFF", brown: "#A2845E", clear: "#00000000", cyan: "#32ADE6", gray: "#8E8E93",
  green: "#34C759", indigo: "#5856D6", mint: "#00C7BE", orange: "#FF9500", pink: "#FF2D55", primary: "#F0F0F7",
  purple: "#AF52DE", red: "#FF3B30", secondary: "#F0F0F799", teal: "#30B0C7", white: "#FFFFFF", yellow: "#FFCC00",
}

function hexByte(value: number): string {
  return Math.round(Math.min(1, Math.max(0, value)) * 255).toString(16).padStart(2, "0").toUpperCase()
}

function rgbHex(red: number, green: number, blue: number, opacity: number): string {
  const alpha = opacity >= 1 ? "" : hexByte(opacity)
  return `#${hexByte(red)}${hexByte(green)}${hexByte(blue)}${alpha}`
}

function hsbToRgb(hue: number, saturation: number, brightness: number): [number, number, number] {
  const h = ((hue % 1) + 1) % 1 * 6
  const c = brightness * saturation
  const x = c * (1 - Math.abs((h % 2) - 1))
  const m = brightness - c
  const [r, g, b] = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x] : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x]
  return [r + m, g + m, b + m]
}

function withOpacity(color: string, opacity: number): string {
  const hex = color.slice(1)
  const base = hex.slice(0, 6)
  const alpha = hex.length === 8 ? Number.parseInt(hex.slice(6), 16) / 255 : 1
  return `#${base.toUpperCase()}${hexByte(alpha * opacity)}`
}

const hexColor = /^#(?:[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/

/** A static SwiftUI Color as an sRGB hex string. */
export function lowerColor(source: string): string {
  const chain = parseMemberChain(source)
  if (!chain || (chain.owner !== undefined && chain.owner !== "Color")) {
    throw new SyntaxError(`Expected a static Color, received: ${source}`)
  }
  let color: string
  const [first, ...rest] = chain.members
  if (chain.ownerCall) {
    const args = chain.ownerCall
    const only = args.length === 1 && args[0].label === undefined && args[0].value.kind === "raw" ? args[0].value.source.trim() : undefined
    if (only && /^"/.test(only)) {
      // Mün extension: Color("#RRGGBB[AA]").
      const hex = JSON.parse(only) as string
      if (!hexColor.test(hex)) throw new SyntaxError(`Color("…") takes a hex sRGB color such as "#3366FF" (Mün has no asset catalogs): ${source}`)
      color = hex.toUpperCase()
    } else {
      const resolved = resolveMember("Color", "init", args)
      const space = resolved.get("colorSpace")?.source
      if (space !== undefined && implicitMember(space) !== "sRGB") throw new SyntaxError(`Mün colors support only the .sRGB color space: ${source}`)
      const number = (name: string, fallback?: number): number => {
        const value = resolved.get(name)?.source
        return value === undefined && fallback !== undefined ? fallback : staticNumber(value, `Color ${name}`)
      }
      const opacity = number("opacity", 1)
      if (resolved.has("white")) color = rgbHex(number("white"), number("white"), number("white"), opacity)
      else if (resolved.has("hue")) {
        const [red, green, blue] = hsbToRgb(number("hue"), number("saturation"), number("brightness"))
        color = rgbHex(red, green, blue, opacity)
      } else color = rgbHex(number("red"), number("green"), number("blue"), opacity)
    }
    for (const member of chain.members) color = applyColorMember(color, member, source)
    return color
  }
  if (!first || first.arguments) throw new SyntaxError(`Expected a static Color, received: ${source}`)
  const named = namedColors[first.name]
  if (!named || !nativeStaticMember("Color", first.name)) throw new SyntaxError(`Color.${first.name} is not a SwiftUI color Mün implements`)
  color = named
  for (const member of rest) color = applyColorMember(color, member, source)
  return color
}

function applyColorMember(color: string, member: MemberSegment, source: string): string {
  if (member.name === "opacity" && member.arguments) {
    const resolved = resolveMember("Color", "opacity", member.arguments)
    return withOpacity(color, staticNumber(resolved.get("opacity")?.source, "Color opacity"))
  }
  throw new SyntaxError(`Color.${member.name} is not implemented by native Mün: ${source}`)
}

const unitPoints: readonly MunUiOverlayAlignment[] = ["center", "leading", "trailing", "top", "bottom", "topLeading", "topTrailing", "bottomLeading", "bottomTrailing"]

function unitPoint(source: string | undefined, what: string): MunUiOverlayAlignment {
  const name = implicitMember(source) ?? (source?.trim().startsWith("UnitPoint.") ? source.trim().slice(10) : undefined)
  if (name && (unitPoints as readonly string[]).includes(name)) return name as MunUiOverlayAlignment
  throw new SyntaxError(`${what} must be a named UnitPoint (.leading, .topTrailing, …): ${source}`)
}

/** A static ShapeStyle (Color or LinearGradient). `.red` is Color.red. */
export function lowerPaint(source: string): MunUiPaint {
  const text = source.trim()
  if (/^["']/.test(text)) {
    throw new SyntaxError(`A string is not a ShapeStyle. Use Color("${text.slice(1, -1)}") or a named color such as .blue: ${source}`)
  }
  const chain = parseMemberChain(text)
  if (chain?.owner === "LinearGradient") {
    const args = chain.ownerCall ?? []
    if (args.length > 0 && args.every(argument => argument.label === undefined)) {
      compatibility("value", "LinearGradient", `LinearGradient(${args.map(argument => argument.value.kind === "raw" ? argument.value.source.trim() : "{…}").join(", ")})`)
    }
    const resolved = resolveMember("LinearGradient", "init", args)
    const colors = resolved.get("colors")?.source ?? ""
    const items = /^\[([\s\S]*)\]$/.exec(colors.trim())
    const entries = items ? splitTopLevel(items[1]).map(item => item.trim()).filter(Boolean) : []
    if (entries.length !== 2) throw new SyntaxError(`Native LinearGradient takes exactly two colors: ${source}`)
    return {
      kind: "linearGradient",
      start: lowerColor(entries[0]),
      end: lowerColor(entries[1]),
      startPoint: unitPoint(resolved.get("startPoint")?.source, "startPoint"),
      endPoint: unitPoint(resolved.get("endPoint")?.source, "endPoint"),
    }
  }
  return { kind: "solid", color: lowerColor(text) }
}

function scalar(args: ValueArguments, name: string, fallback: number, what: string): number {
  const value = args.get(name)?.source
  return value === undefined ? fallback : staticNumber(value, what)
}

type ValueArguments = ReadonlyMap<string, ValueArgument>

/** Native Animation implementations keyed by SDK member signature. */
const animationFactories: Readonly<Record<string, (args: ValueArguments) => Animation>> = {
  "default": () => Animation.default,
  "linear": () => Animation.linear(0.35),
  "easeIn": () => Animation.easeIn(0.35),
  "easeOut": () => Animation.easeOut(0.35),
  "easeInOut": () => Animation.easeInOut(0.35),
  "spring": () => Animation.spring(0.5, 0.825, 0),
  "interactiveSpring": () => Animation.interactiveSpring(0.15, 0.86, 0.25),
  "smooth": () => Animation.smooth(0.5, 0),
  "snappy": () => Animation.snappy(0.5, 0),
  "bouncy": () => Animation.bouncy(0.5, 0),
  "linear(duration:)": args => Animation.linear(scalar(args, "duration", 0.35, "duration")),
  "easeIn(duration:)": args => Animation.easeIn(scalar(args, "duration", 0.35, "duration")),
  "easeOut(duration:)": args => Animation.easeOut(scalar(args, "duration", 0.35, "duration")),
  "easeInOut(duration:)": args => Animation.easeInOut(scalar(args, "duration", 0.35, "duration")),
  "spring(response:dampingFraction:blendDuration:)": args => Animation.spring(scalar(args, "response", 0.5, "response"), scalar(args, "dampingFraction", 0.825, "dampingFraction"), scalar(args, "blendDuration", 0, "blendDuration")),
  "interactiveSpring(response:dampingFraction:blendDuration:)": args => Animation.interactiveSpring(scalar(args, "response", 0.15, "response"), scalar(args, "dampingFraction", 0.86, "dampingFraction"), scalar(args, "blendDuration", 0.25, "blendDuration")),
  "smooth(duration:extraBounce:)": args => Animation.smooth(scalar(args, "duration", 0.5, "duration"), scalar(args, "extraBounce", 0, "extraBounce")),
  "snappy(duration:extraBounce:)": args => Animation.snappy(scalar(args, "duration", 0.5, "duration"), scalar(args, "extraBounce", 0, "extraBounce")),
  "bouncy(duration:extraBounce:)": args => Animation.bouncy(scalar(args, "duration", 0.5, "duration"), scalar(args, "extraBounce", 0, "extraBounce")),
}

const animationModifiers: Readonly<Record<string, (animation: Animation, args: ValueArguments) => Animation>> = {
  "delay(_:)": (animation, args) => animation.delay(scalar(args, "delay", 0, "delay")),
  "speed(_:)": (animation, args) => animation.speed(scalar(args, "speed", 1, "speed")),
  "repeatCount(_:autoreverses:)": (animation, args) => animation.repeatCount(scalar(args, "repeatCount", 1, "repeatCount"), staticBoolean(args.get("autoreverses")?.source, true, "autoreverses")),
  "repeatForever(autoreverses:)": (animation, args) => animation.repeatForever(staticBoolean(args.get("autoreverses")?.source, true, "autoreverses")),
}

function resolveSignature(type: string, member: MemberSegment): { readonly signature: string; readonly args: ValueArguments } {
  if (!member.arguments) {
    if (!nativeStaticMember(type, member.name)) throw new SyntaxError(`${type}.${member.name} is not a SwiftUI ${type} member that Mün implements`)
    return { signature: member.name, args: new Map() }
  }
  const symbols = nativeValueMemberSymbols(type, member.name)
  if (!symbols) throw new SyntaxError(`${type}.${member.name}(…) is not a SwiftUI ${type} member that Mün implements`)
  const resolution = resolveContractCall(symbols, contractArguments(member.arguments), { kind: "value", owner: type, member: member.name })
  return { signature: resolution.signature, args: resolution.arguments }
}

/** A static SwiftUI Animation (`.easeInOut(duration: 0.3)`, `Animation.spring.delay(1)`). */
export function lowerAnimationValue(source: string): Animation {
  const chain = parseMemberChain(source)
  if (!chain || (chain.owner !== undefined && chain.owner !== "Animation") || chain.ownerCall || chain.members.length === 0) {
    throw new SyntaxError(`Expected a SwiftUI Animation such as .easeInOut(duration: 0.3): ${source}`)
  }
  const [factory, ...modifiers] = chain.members
  if (factory.arguments && factory.arguments.length > 0 && factory.arguments.every(argument => argument.label === undefined)) {
    throw new SyntaxError(`Animation.${factory.name}(_:) is a compatibility-only Mün spelling. SwiftUI labels its arguments, e.g. .${factory.name}(duration: …): ${source}`)
  }
  const resolved = resolveSignature("Animation", factory)
  const create = animationFactories[resolved.signature]
  if (!create) throw new SyntaxError(`Animation.${resolved.signature} is not implemented by native Mün`)
  let animation = create(resolved.args)
  for (const modifier of modifiers) {
    const step = resolveSignature("Animation", modifier)
    const apply = animationModifiers[step.signature]
    if (!apply) throw new SyntaxError(`Animation.${step.signature} is not implemented by native Mün`)
    animation = apply(animation, step.args)
  }
  return animation
}

export interface LoweredTransition {
  readonly insertion: readonly TransitionEffect[]
  readonly removal: readonly TransitionEffect[]
  readonly animation?: Animation
}

const edges = ["top", "bottom", "leading", "trailing"] as const

const both = (effect: TransitionEffect): LoweredTransition => ({ insertion: [effect], removal: [effect] })

/** Native AnyTransition implementations keyed by SDK member signature. */
const transitionFactories: Readonly<Record<string, (args: ValueArguments, source: string) => LoweredTransition>> = {
  "identity": () => ({ insertion: [], removal: [] }),
  "opacity": () => both({ kind: "opacity" }),
  "scale": () => both({ kind: "scale", scale: 0 }),
  "scale(scale:anchor:)": (args, source) => {
    const anchor = args.get("anchor")?.source
    if (anchor !== undefined && implicitMember(anchor) !== "center") throw new SyntaxError(`Native scale transitions use the .center anchor: ${source}`)
    return both({ kind: "scale", scale: staticNumber(args.get("scale")?.source, "scale") })
  },
  "move(edge:)": (args, source) => {
    const edge = implicitMember(args.get("edge")?.source)
    if (!edge || !(edges as readonly string[]).includes(edge)) throw new SyntaxError(`move(edge:) takes .top, .bottom, .leading or .trailing: ${source}`)
    return both({ kind: "move", edge: edge as (typeof edges)[number], distance: 24 })
  },
  "asymmetric(insertion:removal:)": args => {
    const insertion = lowerTransitionValue(args.get("insertion")!.source)
    const removal = lowerTransitionValue(args.get("removal")!.source)
    return { insertion: insertion.insertion, removal: removal.removal, ...(insertion.animation ? { animation: insertion.animation } : {}) }
  },
}

const transitionModifiers: Readonly<Record<string, (transition: LoweredTransition, args: ValueArguments) => LoweredTransition>> = {
  "combined(with:)": (transition, args) => {
    const other = lowerTransitionValue(args.get("with")!.source)
    return {
      insertion: [...transition.insertion, ...other.insertion],
      removal: [...transition.removal, ...other.removal],
      ...(transition.animation ?? other.animation ? { animation: transition.animation ?? other.animation } : {}),
    }
  },
  "animation(_:)": (transition, args) => ({ ...transition, animation: lowerAnimationValue(args.get("animation")!.source) }),
}

/** A static SwiftUI AnyTransition (`.opacity`, `.move(edge: .top).combined(with: .opacity)`). */
export function lowerTransitionValue(source: string): LoweredTransition {
  const chain = parseMemberChain(source)
  if (chain?.owner === "Transition") compatibility("value", "Transition", source.trim())
  if (!chain || (chain.owner !== undefined && chain.owner !== "AnyTransition") || chain.ownerCall || chain.members.length === 0) {
    throw new SyntaxError(`Expected a SwiftUI AnyTransition such as .opacity or .move(edge: .top): ${source}`)
  }
  const [base, ...modifiers] = chain.members
  const resolved = resolveSignature("AnyTransition", base)
  const create = transitionFactories[resolved.signature]
  if (!create) throw new SyntaxError(`AnyTransition.${resolved.signature} is not implemented by native Mün: ${source}`)
  let transition = create(resolved.args, source)
  for (const modifier of modifiers) {
    const step = resolveSignature("AnyTransition", modifier)
    const apply = transitionModifiers[step.signature]
    if (!apply) throw new SyntaxError(`AnyTransition.${step.signature} is not implemented by native Mün`)
    transition = apply(transition, step.args)
  }
  return transition
}

/** Value members native lowering implements, as `Type.signature` (implementation metadata). */
export function nativeValueImplementations(): readonly string[] {
  return [
    ...Object.keys(namedColors).map(name => `Color.${name}`),
    "Color.init(_:red:green:blue:opacity:)",
    "Color.init(_:white:opacity:)",
    "Color.init(hue:saturation:brightness:opacity:)",
    "Color.opacity(_:)",
    "LinearGradient.init(colors:startPoint:endPoint:)",
    "Transaction.init(animation:)",
    ...Object.keys(animationFactories).map(signature => `Animation.${signature}`),
    ...Object.keys(animationModifiers).map(signature => `Animation.${signature}`),
    ...Object.keys(transitionFactories).map(signature => `AnyTransition.${signature}`),
    ...Object.keys(transitionModifiers).map(signature => `AnyTransition.${signature}`),
  ].sort()
}

export type { MunUiTransition }

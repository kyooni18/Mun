import type { SemanticInitializerParameter, SemanticInitializerSymbol } from "./semantic.js"

/**
 * The one SwiftUI parity contract for Mün.
 *
 * Each entry names a public SwiftUI/SwiftUICore declaration (verified against
 * the checked-in SDK snapshot by `pnpm check:swiftui-snapshot`) and says, per
 * overload, how Mün implements it:
 *
 * - `contract`: whether Mün accepts the SDK source form exactly or a subset of
 *   it (narrower value family, omitted parameters).
 * - `native`: the native Semantic UI IR implementation — `parity` (equivalent
 *   native semantics) or `divergent` (a deliberate, documented difference).
 *   Absent means the native compiler does not implement the overload.
 * - `web`: the secondary Web backends — never a reason to downgrade `native`.
 * - `compat`: the legacy TypeScript View graph (`@mun/core/compat`) used by
 *   `.mun.ts` and the React/Vue compatibility renderers.
 *
 * The native compiler dispatches canonical calls through this table and
 * exports the implementations it has (`nativeLoweringMetadata` in
 * `@mun/compiler`); `pnpm check:swiftui-manifest` proves the two agree.
 */

export type SwiftUIApiKind = "view" | "modifier" | "value"
/** `exact`: the SDK overload's labels, order, defaults and closure roles. `subset`: a documented narrowing. */
export type SwiftUISourceContract = "exact" | "subset"
/** `parity`: equivalent native semantics. `divergent`: deliberate documented difference. */
export type SwiftUINativeSemantics = "parity" | "divergent"
export type SwiftUIWebSemantics = "parity" | "approximation" | "unsupported"

export interface SwiftUIOverloadSpec {
  /** SDK symbol title, e.g. `init(_:text:)` or `frame(width:height:alignment:)`. */
  readonly signature: string
  /** Parameters Mün accepts, in declaration order. Required for native overloads. */
  readonly parameters?: readonly SemanticInitializerParameter[]
  readonly contract: SwiftUISourceContract
  /** What a `subset` contract leaves out. */
  readonly subset?: string
  readonly native?: SwiftUINativeSemantics
  /** Required when `native` is `divergent`. */
  readonly divergence?: string
  readonly web?: SwiftUIWebSemantics
}

export interface SwiftUICompatInitializer {
  readonly signature: string
  readonly parameters: readonly SemanticInitializerParameter[]
  /** Index of the compatibility runtime initializer implementing this source form. */
  readonly runtimeIndex?: number
}

export interface SwiftUIViewSpec {
  readonly kind: "view"
  readonly name: string
  readonly initializers: readonly SwiftUIOverloadSpec[]
  /** Legacy TypeScript View graph mapping. */
  readonly compat?: { readonly initializers: readonly SwiftUICompatInitializer[] }
}

export type SwiftUIModifierLoweringSpec =
  | { readonly kind: "object"; readonly labels: readonly string[] }
  | { readonly kind: "ordered"; readonly labels: readonly string[] }
  | { readonly kind: "slots"; readonly labels: readonly (string | null)[] }
  | { readonly kind: "hybrid"; readonly objectLabels: readonly string[]; readonly orderedLabels: readonly string[] }

export interface SwiftUIModifierSpec {
  readonly kind: "modifier"
  readonly name: string
  /** SDK type that declares the modifier; `View` when absent. */
  readonly owner?: "View" | "Shape"
  /** SDK-backed overloads. Empty for a Mün-only compatibility modifier. */
  readonly signatures: readonly SwiftUIOverloadSpec[]
  readonly compat?: {
    /** SDK source signatures the legacy View graph accepts. */
    readonly signatures: readonly string[]
    /** Mün-only same-name signatures the legacy graph also accepts (not SwiftUI). */
    readonly munExtensions?: readonly string[]
    readonly lowering?: SwiftUIModifierLoweringSpec
    readonly animatable?: boolean
  }
}

/** Value-level SwiftUI API used inside View arguments (colors, animations, transitions). */
export interface SwiftUIValueSpec {
  readonly kind: "value"
  /** SDK type that owns the members. */
  readonly name: string
  /** Member paths relative to the type, e.g. `init(red:green:blue:opacity:)`, `red`, `linear(duration:)`. */
  readonly members: readonly SwiftUIOverloadSpec[]
}

/** A Mün API with no SwiftUI counterpart. */
export interface MunExtensionSpec {
  readonly kind: "view" | "modifier" | "value"
  readonly name: string
  /**
   * `extension`: intentional Mün syntax, valid in canonical `.mun`.
   * `compatibility`: accepted only by compatibility surfaces; canonical
   * `.mun` reports a diagnostic naming `replacement`.
   */
  readonly status: "extension" | "compatibility"
  readonly signatures: readonly string[]
  readonly reason: string
  readonly replacement?: string
}

const secureDivergence = "Masked presentation, no copy/cut and no value or characters exposed to assistive technology, like macOS; input methods stay enabled, whereas macOS secure text input disables them."

const positional = (name: string, type?: string, required = true): SemanticInitializerParameter => ({
  kind: "value",
  name,
  labelRequired: false,
  required,
  ...(type ? { type } : {}),
})

const labeled = (label: string, type?: string, required = true): SemanticInitializerParameter => ({
  kind: "value",
  name: label,
  label,
  labelRequired: true,
  required,
  ...(type ? { type } : {}),
})

const bound = (label: string, type?: string): SemanticInitializerParameter => ({
  kind: "binding",
  name: label,
  label,
  labelRequired: true,
  required: true,
  ...(type ? { type } : {}),
})

const content = (label = "content", trailing = true): SemanticInitializerParameter => ({
  kind: "viewBuilder",
  name: label,
  label,
  labelRequired: true,
  required: true,
  trailing,
})

const perform = (label = "action", required = true, trailing = true): SemanticInitializerParameter => ({
  kind: "action",
  name: label,
  label,
  labelRequired: true,
  required,
  trailing,
  type: "function",
})

// Legacy compatibility-graph parameter helpers (labels optional for trailing closures).
const compatValue = (name: string, label = name, required = true, type?: string): SemanticInitializerParameter => ({
  kind: "value", name, label, labelRequired: true, required, ...(type ? { type } : {}),
})
const compatBuilder = (name = "content", label = name, trailing = true, type?: string): SemanticInitializerParameter => ({
  kind: "viewBuilder", name, label, labelRequired: !trailing, required: true, trailing, ...(type ? { type } : {}),
})
const compatAction = (name = "action", label = name, trailing = false): SemanticInitializerParameter => ({
  kind: "action", name, label, labelRequired: !trailing, required: true, trailing, type: "function",
})
const compatBinding = (name: string, type?: string): SemanticInitializerParameter => ({
  kind: "binding", name, label: name, labelRequired: true, required: true, ...(type ? { type } : {}),
})

/**
 * Differences that apply across the surface, referenced by entries instead of
 * being restated. They are part of the parity report.
 */
export const swiftUIGlobalDivergences = Object.freeze({
  localization: "Mün has no localization tables. LocalizedStringKey arguments are plain String values and display verbatim — what SwiftUI shows when no table matches.",
  appearance: "The native host draws a fixed dark appearance. Named system colors resolve to fixed sRGB values and do not adapt to the system appearance.",
  defaultMetrics: "System-default metrics are fixed values: stack spacing 8pt, padding 16pt, Spacer minimum length 8pt.",
  typography: "Native text uses one system font size. Font, weight and design modifiers are not part of native Semantic UI IR yet.",
} as const)

const localization = "LocalizedStringKey and StringProtocol title overloads are one String parameter (see global divergence `localization`)."

const views = Object.freeze({
  Text: {
    kind: "view",
    name: "Text",
    initializers: [
      { signature: "init(_:)", parameters: [positional("content", "string")], contract: "subset", subset: `${localization} Image, Date and AttributedString overloads are not accepted.`, native: "parity", web: "parity" },
      { signature: "init(verbatim:)", parameters: [labeled("verbatim", "string")], contract: "exact", native: "parity", web: "parity" },
    ],
    compat: { initializers: [{ signature: "init(_:)", parameters: [{ kind: "value", name: "content", required: true, type: "string" }] }] },
  },
  Button: {
    kind: "view",
    name: "Button",
    initializers: [
      { signature: "init(_:action:)", parameters: [positional("title", "string"), perform()], contract: "subset", subset: `${localization} The title must be a string literal.`, native: "parity", web: "parity" },
      { signature: "init(action:label:)", parameters: [perform("action", true, false), content("label")], contract: "subset", subset: "The label must be a single Text with a string literal.", native: "parity", web: "parity" },
    ],
    compat: {
      initializers: [
        { signature: "init(_:action:)", parameters: [{ kind: "value", name: "title", required: true, type: "string" }, compatAction("action", "action", true)] },
        { signature: "init(action:label:)", parameters: [compatAction(), compatBuilder("label", "label", true)] },
      ],
    },
  },
  TextField: {
    kind: "view",
    name: "TextField",
    initializers: [
      { signature: "init(_:text:)", parameters: [positional("title", "string"), bound("text", "string")], contract: "subset", subset: `${localization} The title must be a string literal.`, native: "parity", web: "parity" },
      { signature: "init(_:text:prompt:)", parameters: [positional("title", "string"), bound("text", "string"), labeled("prompt")], contract: "subset", subset: `${localization} The prompt must be Text with a string literal.`, native: "parity", web: "parity" },
    ],
  },
  SecureField: {
    kind: "view",
    name: "SecureField",
    initializers: [
      { signature: "init(_:text:)", parameters: [positional("title", "string"), bound("text", "string")], contract: "subset", subset: `${localization} The title must be a string literal.`, native: "divergent", divergence: secureDivergence, web: "approximation" },
      { signature: "init(_:text:prompt:)", parameters: [positional("title", "string"), bound("text", "string"), labeled("prompt")], contract: "subset", subset: `${localization} The prompt must be Text with a string literal.`, native: "divergent", divergence: secureDivergence, web: "approximation" },
    ],
  },
  Toggle: {
    kind: "view",
    name: "Toggle",
    initializers: [
      { signature: "init(_:isOn:)", parameters: [positional("title", "string"), bound("isOn", "boolean")], contract: "subset", subset: `${localization} The title must be a string literal.`, native: "divergent", divergence: "Renders the macOS checkbox style; .toggleStyle(.switch) is not implemented.", web: "approximation" },
      { signature: "init(isOn:label:)", parameters: [bound("isOn", "boolean"), content("label")], contract: "subset", subset: "The label must be a single Text with a string literal.", native: "divergent", divergence: "Renders the macOS checkbox style; .toggleStyle(.switch) is not implemented.", web: "approximation" },
    ],
    compat: { initializers: [{ signature: "init(_:isOn:)", parameters: [{ kind: "value", name: "title", required: true, type: "string" }, compatBinding("isOn", "boolean")] }] },
  },
  Picker: {
    kind: "view",
    name: "Picker",
    initializers: [
      { signature: "init(_:selection:content:)", parameters: [positional("title", "string"), bound("selection"), content()], contract: "subset", subset: `${localization} Content must be Text views with static .tag(_:) values (optionally .disabled(true)).`, native: "divergent", divergence: "Always renders the radio-group style. .pickerStyle(.radioGroup) is the faithful spelling; other styles are rejected.", web: "approximation" },
    ],
  },
  ProgressView: {
    kind: "view",
    name: "ProgressView",
    initializers: [
      { signature: "init(value:total:)", parameters: [labeled("value", "number"), labeled("total", "number", false)], contract: "subset", subset: "Value and total are Double; a nil value is not accepted.", native: "parity", web: "approximation" },
      { signature: "init(_:value:total:)", parameters: [positional("title", "string"), labeled("value", "number"), labeled("total", "number", false)], contract: "subset", subset: `${localization} Value and total are Double.`, native: "parity", web: "approximation" },
    ],
  },
  VStack: {
    kind: "view",
    name: "VStack",
    initializers: [
      { signature: "init(alignment:spacing:content:)", parameters: [labeled("alignment", "string", false), labeled("spacing", "number", false), content()], contract: "exact", native: "parity", web: "approximation" },
    ],
    compat: { initializers: [{ signature: "init(alignment:spacing:content:)", runtimeIndex: 1, parameters: [compatValue("alignment", "alignment", false, "string"), compatValue("spacing", "spacing", false, "number"), compatBuilder("content", "content", true, "Content")] }] },
  },
  HStack: {
    kind: "view",
    name: "HStack",
    initializers: [
      { signature: "init(alignment:spacing:content:)", parameters: [labeled("alignment", "string", false), labeled("spacing", "number", false), content()], contract: "subset", subset: "Text-baseline alignments are not accepted.", native: "parity", web: "approximation" },
    ],
    compat: { initializers: [{ signature: "init(alignment:spacing:content:)", runtimeIndex: 1, parameters: [compatValue("alignment", "alignment", false, "string"), compatValue("spacing", "spacing", false, "number"), compatBuilder("content", "content", true, "Content")] }] },
  },
  ZStack: {
    kind: "view",
    name: "ZStack",
    initializers: [
      { signature: "init(alignment:content:)", parameters: [labeled("alignment", "string", false), content()], contract: "subset", subset: "Text-baseline alignments are not accepted.", native: "parity", web: "approximation" },
    ],
    compat: { initializers: [{ signature: "init(alignment:content:)", runtimeIndex: 1, parameters: [compatValue("alignment", "alignment", false, "string"), compatBuilder("content", "content", true, "Content")] }] },
  },
  ScrollView: {
    kind: "view",
    name: "ScrollView",
    initializers: [
      { signature: "init(_:content:)", parameters: [positional("axes", "string", false), content()], contract: "subset", subset: "One axis (.vertical or .horizontal); the two-axis set is not accepted.", native: "parity", web: "approximation" },
    ],
  },
  ForEach: {
    kind: "view",
    name: "ForEach",
    initializers: [
      { signature: "init(_:id:content:)", parameters: [positional("data", "array"), labeled("id"), content()], contract: "subset", subset: "Data is @State or @Binding collection state, an item field, or one filter of them; the content closure takes the element (not a Binding).", native: "parity", web: "approximation" },
      { signature: "init(_:content:)", parameters: [positional("data", "array"), content()], contract: "subset", subset: "Elements are identified by their `id` field (Mün records have no Identifiable conformance); Range<Int> data is not accepted.", native: "parity", web: "approximation" },
    ],
  },
  Group: {
    kind: "view",
    name: "Group",
    initializers: [
      { signature: "init(content:)", parameters: [content()], contract: "exact", native: "parity", web: "parity" },
    ],
    compat: { initializers: [{ signature: "init(content:)", parameters: [compatBuilder()] }] },
  },
  Spacer: {
    kind: "view",
    name: "Spacer",
    initializers: [
      { signature: "init(minLength:)", parameters: [labeled("minLength", "number", false)], contract: "exact", native: "parity", web: "approximation" },
    ],
    compat: { initializers: [{ signature: "init(minLength:)", parameters: [compatValue("minLength", "minLength", false, "number")] }] },
  },
  Divider: {
    kind: "view",
    name: "Divider",
    initializers: [
      { signature: "init()", parameters: [], contract: "exact", native: "parity", web: "approximation" },
    ],
    compat: { initializers: [{ signature: "init()", parameters: [] }] },
  },
  Rectangle: {
    kind: "view",
    name: "Rectangle",
    initializers: [{ signature: "init()", parameters: [], contract: "exact", native: "parity", web: "approximation" }],
  },
  RoundedRectangle: {
    kind: "view",
    name: "RoundedRectangle",
    initializers: [
      { signature: "init(cornerRadius:style:)", parameters: [labeled("cornerRadius", "number"), labeled("style", "string", false)], contract: "exact", native: "divergent", divergence: "Both corner styles draw circular corners.", web: "approximation" },
    ],
  },
  Circle: {
    kind: "view",
    name: "Circle",
    initializers: [{ signature: "init()", parameters: [], contract: "exact", native: "parity", web: "approximation" }],
  },
  Capsule: {
    kind: "view",
    name: "Capsule",
    initializers: [
      { signature: "init(style:)", parameters: [labeled("style", "string", false)], contract: "exact", native: "divergent", divergence: "Both corner styles draw circular ends.", web: "approximation" },
    ],
  },
  // Compatibility-graph-only Views: SDK-verified source forms implemented by
  // the legacy TypeScript graph, not by native Semantic UI IR.
  GeometryReader: {
    kind: "view",
    name: "GeometryReader",
    initializers: [{ signature: "init(content:)", contract: "subset", subset: "Compatibility Web graph only.", web: "approximation" }],
    compat: { initializers: [{ signature: "init(content:)", parameters: [compatBuilder()] }] },
  },
  List: {
    kind: "view",
    name: "List",
    initializers: [{ signature: "init(content:)", contract: "subset", subset: "Compatibility Web graph only.", web: "approximation" }],
    compat: { initializers: [{ signature: "init(content:)", parameters: [compatBuilder()] }] },
  },
  Section: {
    kind: "view",
    name: "Section",
    initializers: [{ signature: "init(content:)", contract: "subset", subset: "Compatibility Web graph only.", web: "approximation" }],
    compat: { initializers: [{ signature: "init(content:)", parameters: [compatBuilder()] }] },
  },
  TextEditor: {
    kind: "view",
    name: "TextEditor",
    initializers: [{ signature: "init(text:)", contract: "exact", web: "approximation" }],
    compat: { initializers: [{ signature: "init(text:)", parameters: [compatBinding("text", "string")] }] },
  },
} as const satisfies Readonly<Record<string, SwiftUIViewSpec>>)

const unitPoint = "string"

const values = Object.freeze([
  {
    kind: "value",
    name: "Color",
    members: [
      { signature: "init(_:red:green:blue:opacity:)", parameters: [positional("colorSpace", "string", false), labeled("red", "number"), labeled("green", "number"), labeled("blue", "number"), labeled("opacity", "number", false)], contract: "subset", subset: "Components are static numbers; only the .sRGB color space.", native: "parity", web: "parity" },
      { signature: "init(_:white:opacity:)", parameters: [positional("colorSpace", "string", false), labeled("white", "number"), labeled("opacity", "number", false)], contract: "subset", subset: "Components are static numbers; only the .sRGB color space.", native: "parity", web: "parity" },
      { signature: "init(hue:saturation:brightness:opacity:)", parameters: [labeled("hue", "number"), labeled("saturation", "number"), labeled("brightness", "number"), labeled("opacity", "number", false)], contract: "subset", subset: "Components are static numbers.", native: "parity", web: "parity" },
      { signature: "opacity(_:)", parameters: [positional("opacity", "number")], contract: "exact", native: "parity", web: "parity" },
      ...["black", "blue", "brown", "clear", "cyan", "gray", "green", "indigo", "mint", "orange", "pink", "primary", "purple", "red", "secondary", "teal", "white", "yellow"].map(name => ({
        signature: name, contract: "exact" as const, native: "divergent" as const, divergence: "Fixed sRGB value (see global divergence `appearance`).", web: "parity" as const,
      })),
    ],
  },
  {
    kind: "value",
    name: "LinearGradient",
    members: [
      { signature: "init(colors:startPoint:endPoint:)", parameters: [labeled("colors", "array"), labeled("startPoint", unitPoint), labeled("endPoint", unitPoint)], contract: "subset", subset: "Exactly two static colors; unit points are the nine named points.", native: "parity", web: "parity" },
    ],
  },
  {
    kind: "value",
    name: "Animation",
    members: [
      ...["default", "linear", "easeIn", "easeOut", "easeInOut", "spring", "interactiveSpring", "smooth", "snappy", "bouncy"].map(name => ({
        signature: name, contract: "exact" as const, native: "parity" as const, web: "approximation" as const,
      })),
      ...["linear", "easeIn", "easeOut", "easeInOut"].map(name => ({
        signature: `${name}(duration:)`, parameters: [labeled("duration", "number")], contract: "exact" as const, native: "parity" as const, web: "approximation" as const,
      })),
      { signature: "spring(response:dampingFraction:blendDuration:)", parameters: [labeled("response", "number", false), labeled("dampingFraction", "number", false), labeled("blendDuration", "number", false)], contract: "exact", native: "parity", web: "approximation" },
      { signature: "interactiveSpring(response:dampingFraction:blendDuration:)", parameters: [labeled("response", "number", false), labeled("dampingFraction", "number", false), labeled("blendDuration", "number", false)], contract: "exact", native: "parity", web: "approximation" },
      ...["smooth", "snappy", "bouncy"].map(name => ({
        signature: `${name}(duration:extraBounce:)`, parameters: [labeled("duration", "number", false), labeled("extraBounce", "number", false)], contract: "exact" as const, native: "parity" as const, web: "approximation" as const,
      })),
      { signature: "delay(_:)", parameters: [positional("delay", "number")], contract: "exact", native: "parity", web: "approximation" },
      { signature: "speed(_:)", parameters: [positional("speed", "number")], contract: "exact", native: "parity", web: "approximation" },
      { signature: "repeatCount(_:autoreverses:)", parameters: [positional("repeatCount", "number"), labeled("autoreverses", "boolean", false)], contract: "exact", native: "parity", web: "approximation" },
      { signature: "repeatForever(autoreverses:)", parameters: [labeled("autoreverses", "boolean", false)], contract: "exact", native: "parity", web: "approximation" },
    ],
  },
  {
    kind: "value",
    name: "AnyTransition",
    members: [
      { signature: "identity", contract: "exact", native: "parity", web: "approximation" },
      { signature: "opacity", contract: "exact", native: "parity", web: "approximation" },
      { signature: "scale", contract: "exact", native: "parity", web: "approximation" },
      { signature: "scale(scale:anchor:)", parameters: [labeled("scale", "number"), labeled("anchor", unitPoint, false)], contract: "subset", subset: "The anchor must be .center.", native: "parity", web: "approximation" },
      { signature: "move(edge:)", parameters: [labeled("edge", "string")], contract: "exact", native: "divergent", divergence: "Moves by a fixed 24pt instead of the view's full extent.", web: "approximation" },
      { signature: "asymmetric(insertion:removal:)", parameters: [labeled("insertion"), labeled("removal")], contract: "exact", native: "parity", web: "approximation" },
      { signature: "combined(with:)", parameters: [labeled("with")], contract: "exact", native: "parity", web: "approximation" },
      { signature: "animation(_:)", parameters: [positional("animation")], contract: "exact", native: "parity", web: "approximation" },
    ],
  },
  {
    kind: "value",
    name: "Transaction",
    members: [
      { signature: "init(animation:)", parameters: [labeled("animation")], contract: "subset", subset: "A static Animation or nil.", native: "parity", web: "approximation" },
    ],
  },
] as const satisfies readonly SwiftUIValueSpec[])

const alignmentDefault = labeled("alignment", "string", false)

/** A modifier implemented only by the legacy graph: its SDK signatures plus compat behavior. */
function compatModifier(
  name: string,
  signatures: readonly string[],
  web: SwiftUIWebSemantics,
  options: { readonly lowering?: SwiftUIModifierLoweringSpec; readonly animatable?: boolean; readonly exact?: boolean; readonly extensions?: readonly string[]; readonly deprecated?: string } = {},
): SwiftUIModifierSpec {
  return {
    kind: "modifier",
    name,
    signatures: signatures.map(signature => ({
      signature,
      contract: options.exact ? "exact" : "subset",
      ...(options.exact ? {} : { subset: `Compatibility Web graph only, with web-oriented value families.${options.deprecated ? ` Deprecated in the SDK: ${options.deprecated}` : ""}` }),
      web,
    })),
    compat: {
      signatures,
      ...(options.extensions ? { munExtensions: options.extensions } : {}),
      ...(options.lowering ? { lowering: options.lowering } : {}),
      ...(options.animatable ? { animatable: true } : {}),
    },
  }
}

function munCompatModifier(name: string, signature: string): SwiftUIModifierSpec {
  return { kind: "modifier", name, signatures: [], compat: { signatures: [], munExtensions: [signature] } }
}

const modifiers: readonly SwiftUIModifierSpec[] = Object.freeze([
  {
    kind: "modifier",
    name: "frame",
    signatures: [
      { signature: "frame(width:height:alignment:)", parameters: [labeled("width", "number", false), labeled("height", "number", false), alignmentDefault], contract: "exact", native: "parity", web: "approximation" },
      { signature: "frame(minWidth:idealWidth:maxWidth:minHeight:idealHeight:maxHeight:alignment:)", parameters: [labeled("minWidth", "number", false), labeled("idealWidth", "number", false), labeled("maxWidth", "number", false), labeled("minHeight", "number", false), labeled("idealHeight", "number", false), labeled("maxHeight", "number", false), alignmentDefault], contract: "subset", subset: "idealWidth and idealHeight are rejected with a diagnostic (native layout has no ideal-size proposal).", native: "parity", web: "approximation" },
    ],
    compat: {
      signatures: ["frame(width:height:alignment:)", "frame(minWidth:idealWidth:maxWidth:minHeight:idealHeight:maxHeight:alignment:)"],
      munExtensions: ["frame()"],
      lowering: { kind: "object", labels: ["width", "height", "alignment", "minWidth", "idealWidth", "maxWidth", "minHeight", "idealHeight", "maxHeight"] },
    },
  },
  {
    kind: "modifier",
    name: "padding",
    signatures: [
      { signature: "padding(_:)", parameters: [positional("length", "number")], contract: "subset", subset: "The EdgeInsets overload is not accepted.", native: "parity", web: "approximation" },
      { signature: "padding(_:_:)", parameters: [positional("edges", undefined, false), positional("length", "number", false)], contract: "exact", native: "parity", web: "approximation" },
    ],
    compat: { signatures: ["padding(_:)", "padding(_:_:)"] },
  },
  {
    kind: "modifier",
    name: "background",
    signatures: [
      { signature: "background(_:ignoresSafeAreaEdges:)", parameters: [positional("style"), labeled("ignoresSafeAreaEdges", undefined, false)], contract: "subset", subset: "Static Color or two-color LinearGradient; ignoresSafeAreaEdges accepts only its default .all (native windows have no safe-area insets).", native: "parity", web: "parity" },
      { signature: "background(alignment:content:)", parameters: [alignmentDefault, content()], contract: "exact", native: "parity", web: "approximation" },
    ],
    compat: { signatures: ["background(_:alignment:)"], lowering: { kind: "slots", labels: [null, "alignment"] } },
  },
  {
    kind: "modifier",
    name: "overlay",
    signatures: [
      { signature: "overlay(alignment:content:)", parameters: [alignmentDefault, content()], contract: "exact", native: "parity", web: "approximation" },
    ],
    compat: { signatures: ["overlay(_:alignment:)"], lowering: { kind: "slots", labels: [null, "alignment"] } },
  },
  {
    kind: "modifier",
    name: "foregroundStyle",
    signatures: [
      { signature: "foregroundStyle(_:)", parameters: [positional("style")], contract: "subset", subset: "Static Color or two-color LinearGradient.", native: "divergent", divergence: "Applies to the modified View only; it is not inherited by descendants through the environment.", web: "parity" },
    ],
    compat: { signatures: ["foregroundStyle(_:)", "foregroundStyle(_:_:)", "foregroundStyle(_:_:_:)"] },
  },
  {
    kind: "modifier",
    name: "fill",
    owner: "Shape",
    signatures: [
      { signature: "fill(_:style:)", parameters: [positional("content"), labeled("style", undefined, false)], contract: "subset", subset: "Static Color or two-color LinearGradient; a FillStyle is rejected with a diagnostic.", native: "parity", web: "approximation" },
    ],
  },
  {
    kind: "modifier",
    name: "cornerRadius",
    signatures: [
      { signature: "cornerRadius(_:antialiased:)", parameters: [positional("radius", "number"), labeled("antialiased", "boolean", false)], contract: "exact", native: "divergent", divergence: "Deprecated in the SDK (SwiftUI recommends clipShape(.rect(cornerRadius:))); kept because clipShape is not implemented. Rounds the View's own background; descendant content is not clipped.", web: "approximation" },
    ],
  },
  {
    kind: "modifier",
    name: "opacity",
    signatures: [{ signature: "opacity(_:)", parameters: [positional("opacity", "number")], contract: "exact", native: "parity", web: "parity" }],
    compat: { signatures: ["opacity(_:)"], animatable: true },
  },
  {
    kind: "modifier",
    name: "offset",
    signatures: [
      { signature: "offset(x:y:)", parameters: [labeled("x", "number", false), labeled("y", "number", false)], contract: "exact", native: "parity", web: "approximation" },
    ],
    compat: { signatures: ["offset(_:)", "offset(x:y:)"], lowering: { kind: "object", labels: ["x", "y"] }, animatable: true },
  },
  {
    kind: "modifier",
    name: "transition",
    signatures: [{ signature: "transition(_:)", parameters: [positional("transition")], contract: "subset", subset: "AnyTransition values listed under values.AnyTransition.", native: "parity", web: "approximation" }],
    compat: { signatures: ["transition(_:)"] },
  },
  {
    kind: "modifier",
    name: "animation",
    signatures: [
      { signature: "animation(_:value:)", parameters: [positional("animation"), labeled("value")], contract: "subset", subset: "Animation values listed under values.Animation; nil is not accepted.", native: "parity", web: "approximation" },
    ],
    compat: { signatures: ["animation(_:)", "animation(_:value:)"], munExtensions: ["animation()"], lowering: { kind: "ordered", labels: ["value"] } },
  },
  {
    kind: "modifier",
    name: "id",
    signatures: [{ signature: "id(_:)", parameters: [positional("id")], contract: "subset", subset: "String or number identity values.", native: "parity", web: "parity" }],
    compat: { signatures: ["id(_:)"] },
  },
  {
    kind: "modifier",
    name: "disabled",
    signatures: [{ signature: "disabled(_:)", parameters: [positional("disabled", "boolean")], contract: "exact", native: "parity", web: "approximation" }],
    compat: { signatures: ["disabled(_:)"] },
  },
  {
    kind: "modifier",
    name: "tag",
    signatures: [{ signature: "tag(_:includeOptional:)", parameters: [positional("tag"), labeled("includeOptional", "boolean", false)], contract: "subset", subset: "Only inside Picker content, with a static string or number.", native: "parity", web: "approximation" }],
  },
  {
    kind: "modifier",
    name: "pickerStyle",
    signatures: [{ signature: "pickerStyle(_:)", parameters: [positional("style")], contract: "subset", subset: "Only .radioGroup.", native: "parity", web: "approximation" }],
    compat: { signatures: ["pickerStyle(_:)"] },
  },
  {
    kind: "modifier",
    name: "accessibilityLabel",
    signatures: [{ signature: "accessibilityLabel(_:)", parameters: [positional("label", "string")], contract: "subset", subset: "A static String.", native: "parity", web: "approximation" }],
    compat: { signatures: ["accessibilityLabel(_:)"] },
  },
  {
    kind: "modifier",
    name: "onAppear",
    signatures: [{ signature: "onAppear(perform:)", parameters: [perform("perform", false)], contract: "subset", subset: "The action body is a native state action.", native: "parity", web: "approximation" }],
  },
  {
    kind: "modifier",
    name: "onDisappear",
    signatures: [{ signature: "onDisappear(perform:)", parameters: [perform("perform", false)], contract: "subset", subset: "The action body is a native state action.", native: "parity", web: "approximation" }],
  },
  // Compatibility-graph-only modifiers. Their SDK signatures are verified;
  // native Semantic UI IR does not implement them, and canonical `.mun`
  // reports them as unsupported.
  compatModifier("font", ["font(_:)"], "parity"),
  compatModifier("bold", ["bold(_:)"], "approximation"),
  compatModifier("scaleEffect", ["scaleEffect(_:anchor:)", "scaleEffect(x:y:anchor:)"], "approximation", { animatable: true, lowering: { kind: "hybrid", objectLabels: ["x", "y"], orderedLabels: ["anchor"] } }),
  compatModifier("rotationEffect", ["rotationEffect(_:anchor:)"], "approximation", { animatable: true, lowering: { kind: "ordered", labels: ["anchor"] } }),
  compatModifier("contentTransition", ["contentTransition(_:)"], "parity", { lowering: { kind: "ordered", labels: [] } }),
  compatModifier("mask", ["mask(_:)"], "approximation", { deprecated: "use mask(alignment:_:)." }),
  compatModifier("aspectRatio", ["aspectRatio(_:contentMode:)"], "approximation", { lowering: { kind: "slots", labels: [null, "contentMode"] } }),
  compatModifier("scaledToFit", ["scaledToFit()"], "approximation"),
  compatModifier("scaledToFill", ["scaledToFill()"], "approximation"),
  compatModifier("fixedSize", ["fixedSize()", "fixedSize(horizontal:vertical:)"], "approximation", { lowering: { kind: "slots", labels: ["horizontal", "vertical"] } }),
  compatModifier("layoutPriority", ["layoutPriority(_:)"], "approximation"),
  compatModifier("position", ["position(_:)", "position(x:y:)"], "approximation", { animatable: true, lowering: { kind: "slots", labels: ["x", "y"] } }),
  compatModifier("zIndex", ["zIndex(_:)"], "approximation"),
  compatModifier("clipShape", ["clipShape(_:style:)"], "approximation", { lowering: { kind: "slots", labels: [null, "style"] } }),
  compatModifier("clipped", ["clipped(antialiased:)"], "approximation", { lowering: { kind: "slots", labels: ["antialiased"] } }),
  compatModifier("border", ["border(_:width:)"], "approximation", { lowering: { kind: "slots", labels: [null, "width"] } }),
  compatModifier("shadow", ["shadow(color:radius:x:y:)"], "approximation", { animatable: true, lowering: { kind: "slots", labels: ["color", "radius", "x", "y"] } }),
  compatModifier("blur", ["blur(radius:opaque:)"], "approximation", { animatable: true, lowering: { kind: "slots", labels: ["radius", "opaque"] } }),
  compatModifier("brightness", ["brightness(_:)"], "approximation", { animatable: true }),
  compatModifier("contrast", ["contrast(_:)"], "approximation", { animatable: true }),
  compatModifier("saturation", ["saturation(_:)"], "approximation", { animatable: true }),
  compatModifier("grayscale", ["grayscale(_:)"], "approximation", { animatable: true }),
  compatModifier("hueRotation", ["hueRotation(_:)"], "approximation", { animatable: true }),
  compatModifier("colorInvert", ["colorInvert()"], "approximation"),
  compatModifier("colorMultiply", ["colorMultiply(_:)"], "approximation"),
  compatModifier("blendMode", ["blendMode(_:)"], "approximation"),
  compatModifier("compositingGroup", ["compositingGroup()"], "approximation"),
  compatModifier("drawingGroup", ["drawingGroup(opaque:colorMode:)"], "approximation", { lowering: { kind: "slots", labels: ["opaque", "colorMode"] } }),
  compatModifier("luminanceToAlpha", ["luminanceToAlpha()"], "approximation"),
  compatModifier("tint", ["tint(_:)"], "parity"),
  compatModifier("fontWeight", ["fontWeight(_:)"], "parity"),
  compatModifier("fontDesign", ["fontDesign(_:)"], "parity"),
  compatModifier("fontWidth", ["fontWidth(_:)"], "parity"),
  compatModifier("italic", ["italic(_:)"], "approximation"),
  compatModifier("underline", ["underline(_:pattern:color:)"], "approximation", { lowering: { kind: "slots", labels: [null, "pattern", "color"] } }),
  compatModifier("strikethrough", ["strikethrough(_:pattern:color:)"], "approximation", { lowering: { kind: "slots", labels: [null, "pattern", "color"] } }),
  compatModifier("monospaced", ["monospaced(_:)"], "approximation"),
  compatModifier("monospacedDigit", ["monospacedDigit()"], "approximation"),
  compatModifier("kerning", ["kerning(_:)"], "approximation", { animatable: true }),
  compatModifier("tracking", ["tracking(_:)"], "approximation", { animatable: true }),
  compatModifier("baselineOffset", ["baselineOffset(_:)"], "approximation", { animatable: true }),
  compatModifier("lineSpacing", ["lineSpacing(_:)"], "approximation", { animatable: true }),
  compatModifier("lineLimit", ["lineLimit(_:)", "lineLimit(_:reservesSpace:)"], "approximation", { lowering: { kind: "slots", labels: [null, "reservesSpace"] } }),
  compatModifier("minimumScaleFactor", ["minimumScaleFactor(_:)"], "approximation"),
  compatModifier("multilineTextAlignment", ["multilineTextAlignment(_:)"], "approximation"),
  compatModifier("truncationMode", ["truncationMode(_:)"], "approximation"),
  compatModifier("textCase", ["textCase(_:)"], "approximation"),
  compatModifier("allowsTightening", ["allowsTightening(_:)"], "approximation"),
  compatModifier("hidden", ["hidden()"], "approximation"),
  compatModifier("allowsHitTesting", ["allowsHitTesting(_:)"], "approximation"),
  compatModifier("onTapGesture", ["onTapGesture(count:perform:)"], "approximation", { lowering: { kind: "slots", labels: ["count", "perform"] } }),
  compatModifier("onLongPressGesture", ["onLongPressGesture(minimumDuration:maximumDistance:perform:onPressingChanged:)"], "approximation", { lowering: { kind: "slots", labels: ["minimumDuration", "maximumDistance", "perform", "onPressingChanged"] } }),
  compatModifier("onHover", ["onHover(perform:)"], "approximation", { lowering: { kind: "slots", labels: ["perform"] } }),
  compatModifier("preferredColorScheme", ["preferredColorScheme(_:)"], "approximation"),
  compatModifier("controlSize", ["controlSize(_:)"], "approximation"),
  compatModifier("scrollDisabled", ["scrollDisabled(_:)"], "approximation"),
  compatModifier("scrollIndicators", ["scrollIndicators(_:axes:)"], "approximation", { lowering: { kind: "slots", labels: [null, "axes"] } }),
  compatModifier("scrollBounceBehavior", ["scrollBounceBehavior(_:axes:)"], "approximation", { lowering: { kind: "slots", labels: [null, "axes"] } }),
  compatModifier("scrollClipDisabled", ["scrollClipDisabled(_:)"], "approximation"),
  compatModifier("scrollDismissesKeyboard", ["scrollDismissesKeyboard(_:)"], "approximation"),
  compatModifier("accessibilityHint", ["accessibilityHint(_:)"], "approximation"),
  compatModifier("accessibilityValue", ["accessibilityValue(_:)"], "approximation"),
  compatModifier("accessibilityHidden", ["accessibilityHidden(_:)"], "approximation"),
  compatModifier("accessibilityIdentifier", ["accessibilityIdentifier(_:)"], "approximation"),
  compatModifier("accessibilityHeading", ["accessibilityHeading(_:)"], "approximation"),
  compatModifier("accessibilitySortPriority", ["accessibilitySortPriority(_:)"], "approximation"),
  compatModifier("ignoresSafeArea", ["ignoresSafeArea(_:edges:)"], "approximation", { lowering: { kind: "slots", labels: [null, "edges"] } }),
  compatModifier("safeAreaPadding", ["safeAreaPadding(_:)", "safeAreaPadding(_:_:)"], "approximation"),
  compatModifier("gridCellColumns", ["gridCellColumns(_:)"], "approximation"),
  compatModifier("gridCellUnsizedAxes", ["gridCellUnsizedAxes(_:)"], "approximation"),
  compatModifier("gridCellAnchor", ["gridCellAnchor(_:)"], "approximation"),
  compatModifier("gridColumnAlignment", ["gridColumnAlignment(_:)"], "approximation"),
  compatModifier("transformEffect", ["transformEffect(_:)"], "approximation", { animatable: true }),
  compatModifier("projectionEffect", ["projectionEffect(_:)"], "approximation", { animatable: true }),
  compatModifier("rotation3DEffect", ["rotation3DEffect(_:axis:anchor:anchorZ:perspective:)"], "approximation", { animatable: true, lowering: { kind: "slots", labels: [null, "axis", "anchor", "anchorZ", "perspective"] } }),
  compatModifier("backgroundStyle", ["backgroundStyle(_:)"], "approximation"),
  compatModifier("dynamicTypeSize", ["dynamicTypeSize(_:)"], "approximation"),
  compatModifier("focusable", ["focusable(_:)"], "approximation"),
  compatModifier("buttonStyle", ["buttonStyle(_:)"], "approximation"),
  compatModifier("toggleStyle", ["toggleStyle(_:)"], "approximation"),
  compatModifier("textFieldStyle", ["textFieldStyle(_:)"], "approximation"),
  compatModifier("textEditorStyle", ["textEditorStyle(_:)"], "approximation"),
  compatModifier("listStyle", ["listStyle(_:)"], "approximation"),
  compatModifier("labelStyle", ["labelStyle(_:)"], "approximation"),
  compatModifier("progressViewStyle", ["progressViewStyle(_:)"], "approximation"),
  compatModifier("listRowInsets", ["listRowInsets(_:)", "listRowInsets(_:_:)"], "approximation"),
  compatModifier("listRowBackground", ["listRowBackground(_:)"], "approximation"),
  compatModifier("listRowSeparator", ["listRowSeparator(_:edges:)"], "approximation", { lowering: { kind: "slots", labels: [null, "edges"] } }),
  compatModifier("listSectionSeparator", ["listSectionSeparator(_:edges:)"], "approximation", { lowering: { kind: "slots", labels: [null, "edges"] } }),
  compatModifier("symbolRenderingMode", ["symbolRenderingMode(_:)"], "parity"),
  compatModifier("symbolVariant", ["symbolVariant(_:)"], "parity"),
  compatModifier("draggable", ["draggable(_:)"], "approximation"),
  compatModifier("dropDestination", ["dropDestination(for:action:isTargeted:)"], "approximation", { lowering: { kind: "slots", labels: ["for", "action", "isTargeted"] }, deprecated: "use dropDestination(for:isEnabled:action:)." }),
  compatModifier("accessibilityElement", ["accessibilityElement(children:)"], "approximation", { lowering: { kind: "slots", labels: ["children"] } }),
  compatModifier("accessibilityAction", ["accessibilityAction(_:_:)"], "approximation"),
  // Mün-only compatibility modifiers: never part of the SwiftUI claim.
  munCompatModifier("margin", "margin(_:)"),
  munCompatModifier("gap", "gap(_:)"),
  munCompatModifier("fontSize", "fontSize(_:)"),
  munCompatModifier("foreground", "foreground(_:)"),
  munCompatModifier("style", "style(_:)"),
  munCompatModifier("className", "className(_:)"),
  munCompatModifier("withProps", "withProps(_:)"),
  munCompatModifier("keyed", "keyed(_:)"),
  munCompatModifier("elementRef", "elementRef(_:)"),
  munCompatModifier("continuousCorners", "continuousCorners(_:)"),
])

/** Mün APIs with no SwiftUI declaration. */
const extensions = Object.freeze([
  { kind: "view", name: "Window", status: "extension", signatures: ["init(_:width:height:content:)"], reason: "Desktop window root. SwiftUI scenes (WindowGroup) are not part of the View tree Mün compiles." },
  { kind: "value", name: "Color", status: "extension", signatures: ["init(_:)"], reason: "Color(\"#RRGGBB\") / Color(\"#RRGGBBAA\") is a hex sRGB color. SwiftUI's same spelling looks up an asset-catalog color; Mün has no asset catalogs, so the string is a hex literal." },
  { kind: "view", name: "RadioGroup", status: "compatibility", signatures: ["init(_:_:)"], reason: "Pre-Picker radio control with option records.", replacement: "Picker(\"Title\", selection: $value) { Text(\"Label\").tag(value) }.pickerStyle(.radioGroup)" },
  { kind: "view", name: "Column", status: "compatibility", signatures: ["init(spacing:alignment:content:)"], reason: "Legacy alias.", replacement: "VStack(alignment:spacing:content:)" },
  { kind: "view", name: "Row", status: "compatibility", signatures: ["init(spacing:alignment:content:)"], reason: "Legacy alias.", replacement: "HStack(alignment:spacing:content:)" },
  { kind: "view", name: "Action", status: "compatibility", signatures: ["init(_:action:)"], reason: "Legacy alias.", replacement: "Button(_:action:)" },
  { kind: "view", name: "Panel", status: "compatibility", signatures: ["init()"], reason: "Legacy alias.", replacement: "Rectangle()" },
  { kind: "value", name: "Transition", status: "compatibility", signatures: ["opacity", "identity", "scale(_:)", "move(_:_:)", "asymmetric(_:_:)"], reason: "Pre-AnyTransition Mün transition values.", replacement: ".opacity, .scale(scale:anchor:), .move(edge:), .asymmetric(insertion:removal:)" },
  { kind: "value", name: "LinearGradient", status: "compatibility", signatures: ["init(_:_:_:_:)"], reason: "Positional two-color gradient.", replacement: "LinearGradient(colors: [a, b], startPoint: .leading, endPoint: .trailing)" },
  { kind: "modifier", name: "foregroundColor", status: "compatibility", signatures: ["foregroundColor(_:)"], reason: "Deprecated SwiftUI spelling.", replacement: ".foregroundStyle(_:)" },
] as const satisfies readonly MunExtensionSpec[])

/**
 * SwiftUI APIs Mün deliberately does not implement yet, with the missing
 * semantics. Names are verified against the SDK snapshot; the compiler uses
 * them to report a precise diagnostic instead of "unknown View".
 */
const unsupported = Object.freeze({
  views: [
    { name: "NavigationStack", reason: "navigation is not yet a runtime semantic (no path state or destination stack)" },
    { name: "NavigationLink", reason: "navigation is not yet a runtime semantic" },
    { name: "NavigationSplitView", reason: "navigation is not yet a runtime semantic" },
    { name: "TabView", reason: "no runtime tab selection semantics" },
    { name: "List", reason: "native has no list semantics (rows, separators, selection); use ScrollView with VStack and ForEach" },
    { name: "Section", reason: "native has no list/form sections" },
    { name: "Form", reason: "native has no form layout semantics" },
    { name: "Image", reason: "the native renderer has no image or SF Symbol pipeline" },
    { name: "Label", reason: "the native renderer has no image or SF Symbol pipeline" },
    { name: "TextEditor", reason: "native text editing is single-line" },
    { name: "GeometryReader", reason: "layout-dependent View evaluation is not part of Semantic UI IR" },
    { name: "LazyVStack", reason: "no virtualization; use VStack" },
    { name: "LazyHStack", reason: "no virtualization; use HStack" },
    { name: "LazyVGrid", reason: "no grid layout in Semantic UI IR" },
    { name: "Grid", reason: "no grid layout in Semantic UI IR" },
    { name: "Menu", reason: "no menu presentation semantics" },
    { name: "Slider", reason: "no continuous-value control in native" },
    { name: "Stepper", reason: "no stepper control in native" },
    { name: "DatePicker", reason: "no date values or calendar control in native" },
    { name: "ColorPicker", reason: "no color values in native state" },
    { name: "Table", reason: "no table semantics" },
    { name: "Canvas", reason: "no immediate-mode drawing in Semantic UI IR" },
    { name: "Path", reason: "no vector path primitive in Semantic UI IR" },
    { name: "Link", reason: "no URL opening service" },
    { name: "DisclosureGroup", reason: "use if with a Bool @State" },
    { name: "ViewThatFits", reason: "layout-dependent View selection is not part of Semantic UI IR" },
    { name: "AnyView", reason: "Mün Views are lowered statically" },
    { name: "EmptyView", reason: "use an empty if branch" },
  ],
  modifiers: [
    { name: "sheet", reason: "presentation is not yet a runtime semantic" },
    { name: "popover", reason: "presentation is not yet a runtime semantic" },
    { name: "alert", reason: "presentation is not yet a runtime semantic" },
    { name: "confirmationDialog", reason: "presentation is not yet a runtime semantic" },
    { name: "toolbar", reason: "toolbars need the window/navigation model first" },
    { name: "navigationTitle", reason: "navigation is not yet a runtime semantic" },
    { name: "navigationDestination", reason: "navigation is not yet a runtime semantic" },
    { name: "task", reason: "no asynchronous work model in native state actions" },
    { name: "environment", reason: "only .disabled and .foregroundStyle propagate through the native environment" },
    { name: "gesture", reason: "gesture composition is not yet a semantic model" },
    { name: "simultaneousGesture", reason: "gesture composition is not yet a semantic model" },
    { name: "highPriorityGesture", reason: "gesture composition is not yet a semantic model" },
    { name: "onChange", reason: "no state-change observers in native actions" },
    { name: "onSubmit", reason: "no submit triggers in native text fields" },
    { name: "focused", reason: "no FocusState in native" },
    { name: "searchable", reason: "no search field semantics" },
    { name: "refreshable", reason: "no asynchronous work model" },
    { name: "contextMenu", reason: "no menu presentation semantics" },
    { name: "help", reason: "no tooltip semantics" },
    { name: "keyboardShortcut", reason: "no command routing for shortcuts" },
  ],
  /** SDK overloads of implemented APIs that Mün deliberately leaves out. */
  overloads: {
    TextField: ["init(_:text:axis:)", "init(_:text:prompt:axis:)", "init(text:prompt:label:)"],
    SecureField: ["init(text:prompt:label:)"],
    Toggle: ["init(_:systemImage:isOn:)", "init(_:sources:isOn:)"],
    Button: ["init(_:role:action:)", "init(_:systemImage:action:)", "init(role:action:label:)"],
    Text: ["init(_:tableName:bundle:comment:)"],
    ProgressView: ["init()", "init(_:)", "init(label:)", "init(value:total:label:)"],
    Picker: ["init(selection:content:label:)", "init(_:systemImage:selection:content:)"],
    ScrollView: [],
    background: ["background(_:in:fillStyle:)", "background(in:fillStyle:)"],
    overlay: ["overlay(_:ignoresSafeAreaEdges:)", "overlay(_:in:fillStyle:)"],
    offset: ["offset(_:)"],
    animation: ["animation(_:)", "animation(_:body:)"],
    transition: [],
  } as Readonly<Record<string, readonly string[]>>,
})

export function swiftUIUnsupportedInitializerSignatures(view: string): readonly string[] {
  return unsupported.overloads[view] ?? []
}

export function swiftUIUnsupportedModifierSignatures(modifier: string): readonly string[] {
  return unsupported.overloads[modifier] ?? []
}

/** Canonical SwiftUI source contract. */
export const swiftUIApiManifest = Object.freeze({
  schemaVersion: 2,
  views,
  values,
  modifiers,
  extensions,
  unsupported,
  divergences: swiftUIGlobalDivergences,
})

export type SwiftUIViewName = keyof typeof views

/** Overloads of a View implemented by native Semantic UI IR, as compiler symbols. */
export function nativeViewInitializerSymbols(name: string): readonly SemanticInitializerSymbol[] | undefined {
  const spec = (views as Readonly<Record<string, SwiftUIViewSpec>>)[name]
  if (!spec) return undefined
  const native = spec.initializers.filter(initializer => initializer.native && initializer.parameters)
  if (native.length === 0) return undefined
  return native.map((initializer, index) => Object.freeze({
    kind: "initializer" as const,
    index,
    signature: initializer.signature,
    parameters: initializer.parameters ?? [],
  }))
}

/** Overloads of a modifier implemented by native Semantic UI IR, as compiler symbols. */
export function nativeModifierSymbols(name: string): readonly SemanticInitializerSymbol[] | undefined {
  const spec = modifiers.find(modifier => modifier.name === name)
  const native = spec?.signatures.filter(signature => signature.native && signature.parameters) ?? []
  if (native.length === 0) return undefined
  return native.map((signature, index) => Object.freeze({
    kind: "initializer" as const,
    index,
    signature: signature.signature,
    parameters: signature.parameters ?? [],
  }))
}

/** Value-member overloads implemented natively, keyed by member signature. */
export function nativeValueMemberSymbols(type: string, member: string): readonly SemanticInitializerSymbol[] | undefined {
  const spec = values.find(value => value.name === type)
  const matches = (spec?.members as readonly SwiftUIOverloadSpec[] | undefined)?.filter(overload =>
    overload.native && overload.parameters && overload.signature.startsWith(`${member}(`)) ?? []
  if (matches.length === 0) return undefined
  return matches.map((overload, index) => Object.freeze({
    kind: "initializer" as const,
    index,
    signature: overload.signature,
    parameters: overload.parameters ?? [],
  }))
}

export function munExtension(kind: MunExtensionSpec["kind"], name: string): MunExtensionSpec | undefined {
  return (extensions as readonly MunExtensionSpec[]).find(extension => extension.kind === kind && extension.name === name)
}

/** Every modifier name the legacy compatibility graph accepts. */
export const swiftUIStaticModifierNames: ReadonlySet<string> = new Set(modifiers.filter(modifier => modifier.compat).map(modifier => modifier.name))
export const swiftUIAnimatableModifierNames: ReadonlySet<string> = new Set(modifiers.filter(modifier => modifier.compat?.animatable).map(modifier => modifier.name))
/** SDK-backed modifier names (Mün-only compatibility modifiers excluded). */
export const swiftUICanonicalModifierNames: ReadonlySet<string> = new Set(modifiers.filter(modifier => modifier.signatures.length > 0).map(modifier => modifier.name))
/** Modifier names native Semantic UI IR implements. */
export const swiftUINativeModifierNames: ReadonlySet<string> = new Set(modifiers.filter(modifier => modifier.signatures.some(signature => signature.native)).map(modifier => modifier.name))

export function swiftUIModifierLowering(name: string): SwiftUIModifierLoweringSpec | undefined {
  return modifiers.find(modifier => modifier.name === name)?.compat?.lowering
}

/**
 * Legacy compatibility-graph initializer symbols for a SwiftUI View, mapped to
 * runtime initializer indices. Used by the `.mun.ts`/Web compatibility pipeline.
 */
export function swiftUIInitializerSymbols(name: string): readonly SemanticInitializerSymbol[] | undefined {
  const spec = (views as Readonly<Record<string, SwiftUIViewSpec>>)[name]
  if (!spec?.compat) return undefined
  return spec.compat.initializers.map((initializer, index) => Object.freeze({
    kind: "initializer" as const,
    index: initializer.runtimeIndex ?? index,
    signature: initializer.signature,
    parameters: initializer.parameters,
  }))
}

/** Views with a legacy compatibility-graph mapping. */
export function swiftUIViewNames(): readonly string[] {
  return Object.entries(views as Readonly<Record<string, SwiftUIViewSpec>>).filter(([, spec]) => spec.compat).map(([name]) => name)
}

/** Views with at least one native overload. */
export function swiftUINativeViewNames(): readonly string[] {
  return Object.entries(views as Readonly<Record<string, SwiftUIViewSpec>>).filter(([, spec]) => spec.initializers.some(initializer => initializer.native)).map(([name]) => name)
}

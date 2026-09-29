import type { SemanticInitializerParameter, SemanticInitializerSymbol } from "./semantic.js"

export type SwiftUIApiKind = "view" | "modifier" | "value"
type SwiftUIParityFidelity = "source" | "source-subset" | "web-approximation"

export interface SwiftUIInitializerSpec {
  readonly signature: string
  readonly parameters: readonly SemanticInitializerParameter[]
  /** Index of the compatibility/runtime initializer that implements this SwiftUI source form. */
  readonly runtimeIndex?: number
}

export interface SwiftUIViewSpec {
  readonly kind: "view"
  readonly name: string
  /** What this entry promises beyond matching an SDK-backed SwiftUI symbol. */
  readonly fidelity: SwiftUIParityFidelity
  /** Canonical SwiftUI authoring initializers. Compatibility overloads stay runtime-only. */
  readonly initializers: readonly SwiftUIInitializerSpec[]
}

export interface SwiftUIModifierSpec {
  readonly kind: "modifier"
  readonly name: string
  readonly fidelity?: SwiftUIParityFidelity
  /** Every Mün source signature accepted for this modifier name. */
  readonly signatures: readonly string[]
  /**
   * Public SwiftUI signatures when Mun also exposes same-name extensions.
   * Omitted means every signature above is part of the SwiftUI parity claim.
   */
  readonly swiftUISignatures?: readonly string[]
  readonly animatable?: boolean
  /** Mun-only compatibility API. It is intentionally excluded from parity counts. */
  readonly compatibility?: boolean
  /** How Swift-style labeled arguments lower to the JavaScript runtime call. */
  readonly lowering?: SwiftUIModifierLoweringSpec
}

export type SwiftUIModifierLoweringSpec =
  | { readonly kind: "object"; readonly labels: readonly string[] }
  | { readonly kind: "ordered"; readonly labels: readonly string[] }
  | { readonly kind: "slots"; readonly labels: readonly (string | null)[] }
  | { readonly kind: "hybrid"; readonly objectLabels: readonly string[]; readonly orderedLabels: readonly string[] }

const value = (name: string, label = name, required = true, type?: string): SemanticInitializerParameter => ({
  kind: "value",
  name,
  label,
  labelRequired: true,
  required,
  ...(type ? { type } : {}),
})

const builder = (name = "content", label = name, trailing = true, type?: string): SemanticInitializerParameter => ({
  kind: "viewBuilder",
  name,
  label,
  labelRequired: !trailing,
  required: true,
  trailing,
  ...(type ? { type } : {}),
})

const action = (name = "action", label = name, trailing = false): SemanticInitializerParameter => ({
  kind: "action",
  name,
  label,
  labelRequired: !trailing,
  required: true,
  trailing,
  type: "function",
})

const binding = (name: string, label = name, required = true, type?: string): SemanticInitializerParameter => ({
  kind: "binding",
  name,
  label,
  labelRequired: true,
  required,
  ...(type ? { type } : {}),
})

const views = Object.freeze({
  Text: Object.freeze({
    kind: "view" as const,
    name: "Text",
    fidelity: "source-subset" as const,
    initializers: Object.freeze([Object.freeze({
      signature: "init(_:)",
      parameters: Object.freeze([
        { kind: "value" as const, name: "content", required: true, type: "string" },
      ]),
    })]),
  }),
  VStack: Object.freeze({
    kind: "view" as const,
    name: "VStack",
    fidelity: "web-approximation" as const,
    initializers: Object.freeze([Object.freeze({
      signature: "init(alignment:spacing:content:)",
      runtimeIndex: 1,
      parameters: Object.freeze([
        value("alignment", "alignment", false, "string"),
        value("spacing", "spacing", false, "number"),
        builder("content", "content", true, "Content"),
      ]),
    })]),
  }),
  HStack: Object.freeze({
    kind: "view" as const,
    name: "HStack",
    fidelity: "web-approximation" as const,
    initializers: Object.freeze([Object.freeze({
      signature: "init(alignment:spacing:content:)",
      runtimeIndex: 1,
      parameters: Object.freeze([
        value("alignment", "alignment", false, "string"),
        value("spacing", "spacing", false, "number"),
        builder("content", "content", true, "Content"),
      ]),
    })]),
  }),
  ZStack: Object.freeze({
    kind: "view" as const,
    name: "ZStack",
    fidelity: "web-approximation" as const,
    initializers: Object.freeze([Object.freeze({
      signature: "init(alignment:content:)",
      runtimeIndex: 1,
      parameters: Object.freeze([
        value("alignment", "alignment", false, "string"),
        builder("content", "content", true, "Content"),
      ]),
    })]),
  }),
  Button: Object.freeze({
    kind: "view" as const,
    name: "Button",
    fidelity: "source-subset" as const,
    initializers: Object.freeze([
      Object.freeze({
        signature: "init(_:action:)",
        parameters: Object.freeze([
          { kind: "value" as const, name: "title", required: true, type: "string" },
          action("action", "action", true),
        ]),
      }),
      Object.freeze({
        signature: "init(action:label:)",
        parameters: Object.freeze([action(), builder("label", "label", true)]),
      }),
    ]),
  }),
  Spacer: Object.freeze({
    kind: "view" as const,
    name: "Spacer",
    fidelity: "web-approximation" as const,
    initializers: Object.freeze([Object.freeze({
      signature: "init(minLength:)",
      parameters: Object.freeze([value("minLength", "minLength", false, "number")]),
    })]),
  }),
  Divider: Object.freeze({
    kind: "view" as const,
    name: "Divider",
    fidelity: "web-approximation" as const,
    initializers: Object.freeze([Object.freeze({
      signature: "init()",
      parameters: Object.freeze([]),
    })]),
  }),
  Group: Object.freeze({
    kind: "view" as const,
    name: "Group",
    fidelity: "source" as const,
    initializers: Object.freeze([Object.freeze({
      signature: "init(content:)",
      parameters: Object.freeze([builder()]),
    })]),
  }),
  GeometryReader: Object.freeze({
    kind: "view" as const,
    name: "GeometryReader",
    fidelity: "web-approximation" as const,
    initializers: Object.freeze([Object.freeze({
      signature: "init(content:)",
      parameters: Object.freeze([builder()]),
    })]),
  }),
  List: Object.freeze({
    kind: "view" as const,
    name: "List",
    fidelity: "web-approximation" as const,
    initializers: Object.freeze([Object.freeze({
      signature: "init(content:)",
      parameters: Object.freeze([builder()]),
    })]),
  }),
  Section: Object.freeze({
    kind: "view" as const,
    name: "Section",
    fidelity: "web-approximation" as const,
    initializers: Object.freeze([Object.freeze({
      signature: "init(content:)",
      parameters: Object.freeze([builder()]),
    })]),
  }),
  Toggle: Object.freeze({
    kind: "view" as const,
    name: "Toggle",
    fidelity: "web-approximation" as const,
    initializers: Object.freeze([Object.freeze({
      signature: "init(_:isOn:)",
      parameters: Object.freeze([
        { kind: "value" as const, name: "title", required: true, type: "string" },
        binding("isOn", "isOn", true, "boolean"),
      ]),
    })]),
  }),
  TextEditor: Object.freeze({
    kind: "view" as const,
    name: "TextEditor",
    fidelity: "web-approximation" as const,
    initializers: Object.freeze([Object.freeze({
      signature: "init(text:)",
      parameters: Object.freeze([binding("text", "text", true, "string")]),
    })]),
  }),
}) satisfies Readonly<Record<string, SwiftUIViewSpec>>

const modifiers = Object.freeze([
  { kind: "modifier", name: "padding", fidelity: "web-approximation", signatures: ["padding(_:)", "padding(_:_:)"] },
  {
    kind: "modifier",
    name: "frame",
    fidelity: "web-approximation",
    signatures: ["frame(width:height:alignment:)", "frame(minWidth:idealWidth:maxWidth:minHeight:idealHeight:maxHeight:alignment:)", "frame()"],
    lowering: {
      kind: "object",
      labels: ["width", "height", "alignment", "minWidth", "idealWidth", "maxWidth", "minHeight", "idealHeight", "maxHeight"],
    },
  },
  { kind: "modifier", name: "font", fidelity: "source-subset", signatures: ["font(_:)"] },
  { kind: "modifier", name: "bold", fidelity: "web-approximation", signatures: ["bold(_:)"] },
  { kind: "modifier", name: "foregroundStyle", fidelity: "source-subset", signatures: ["foregroundStyle(_:)", "foregroundStyle(_:_:)" , "foregroundStyle(_:_:_:)"] },
  { kind: "modifier", name: "background", fidelity: "source-subset", signatures: ["background(_:alignment:)"], lowering: { kind: "slots", labels: [null, "alignment"] } },
  { kind: "modifier", name: "opacity", fidelity: "source", signatures: ["opacity(_:)"] , animatable: true },
  {
    kind: "modifier",
    name: "scaleEffect",
    fidelity: "web-approximation",
    signatures: ["scaleEffect(_:anchor:)", "scaleEffect(x:y:anchor:)"],
    animatable: true,
    lowering: { kind: "hybrid", objectLabels: ["x", "y"], orderedLabels: ["anchor"] },
  },
  { kind: "modifier", name: "rotationEffect", fidelity: "web-approximation", signatures: ["rotationEffect(_:anchor:)"], animatable: true, lowering: { kind: "ordered", labels: ["anchor"] } },
  { kind: "modifier", name: "offset", fidelity: "web-approximation", signatures: ["offset(_:)", "offset(x:y:)"], animatable: true, lowering: { kind: "object", labels: ["x", "y"] } },
  {
    kind: "modifier",
    name: "animation",
    fidelity: "source-subset",
    signatures: ["animation()", "animation(_:)", "animation(_:value:)"],
    swiftUISignatures: ["animation(_:)", "animation(_:value:)"],
    lowering: { kind: "ordered", labels: ["value"] },
  },
  { kind: "modifier", name: "transition", fidelity: "source-subset", signatures: ["transition(_:)"] },
  { kind: "modifier", name: "contentTransition", fidelity: "source-subset", signatures: ["contentTransition(_:)"] , lowering: { kind: "ordered", labels: [] } },
  { kind: "modifier", name: "mask", fidelity: "web-approximation", signatures: ["mask(_:)"] },
  { kind: "modifier", name: "overlay", fidelity: "web-approximation", signatures: ["overlay(_:alignment:)"], lowering: { kind: "slots", labels: [null, "alignment"] } },
  { kind: "modifier", name: "aspectRatio", fidelity: "web-approximation", signatures: ["aspectRatio(_:contentMode:)"] , lowering: { kind: "slots", labels: [null, "contentMode"] } },
  { kind: "modifier", name: "scaledToFit", fidelity: "web-approximation", signatures: ["scaledToFit()"] },
  { kind: "modifier", name: "scaledToFill", fidelity: "web-approximation", signatures: ["scaledToFill()"] },
  { kind: "modifier", name: "fixedSize", fidelity: "web-approximation", signatures: ["fixedSize()", "fixedSize(horizontal:vertical:)"] , lowering: { kind: "slots", labels: ["horizontal", "vertical"] } },
  { kind: "modifier", name: "layoutPriority", fidelity: "web-approximation", signatures: ["layoutPriority(_:)"] },
  { kind: "modifier", name: "position", fidelity: "web-approximation", signatures: ["position(_:)", "position(x:y:)"] , lowering: { kind: "slots", labels: ["x", "y"] }, animatable: true },
  { kind: "modifier", name: "zIndex", fidelity: "web-approximation", signatures: ["zIndex(_:)"] },
  { kind: "modifier", name: "clipShape", fidelity: "web-approximation", signatures: ["clipShape(_:style:)"] , lowering: { kind: "slots", labels: [null, "style"] } },
  { kind: "modifier", name: "clipped", fidelity: "web-approximation", signatures: ["clipped(antialiased:)"] , lowering: { kind: "slots", labels: ["antialiased"] } },
  { kind: "modifier", name: "border", fidelity: "web-approximation", signatures: ["border(_:width:)"] , lowering: { kind: "slots", labels: [null, "width"] } },
  { kind: "modifier", name: "shadow", fidelity: "web-approximation", signatures: ["shadow(color:radius:x:y:)"] , lowering: { kind: "slots", labels: ["color", "radius", "x", "y"] }, animatable: true },
  { kind: "modifier", name: "blur", fidelity: "web-approximation", signatures: ["blur(radius:opaque:)"] , lowering: { kind: "slots", labels: ["radius", "opaque"] }, animatable: true },
  { kind: "modifier", name: "brightness", fidelity: "web-approximation", signatures: ["brightness(_:)"] , animatable: true },
  { kind: "modifier", name: "contrast", fidelity: "web-approximation", signatures: ["contrast(_:)"] , animatable: true },
  { kind: "modifier", name: "saturation", fidelity: "web-approximation", signatures: ["saturation(_:)"] , animatable: true },
  { kind: "modifier", name: "grayscale", fidelity: "web-approximation", signatures: ["grayscale(_:)"] , animatable: true },
  { kind: "modifier", name: "hueRotation", fidelity: "web-approximation", signatures: ["hueRotation(_:)"] , animatable: true },
  { kind: "modifier", name: "colorInvert", fidelity: "web-approximation", signatures: ["colorInvert()"] },
  { kind: "modifier", name: "colorMultiply", fidelity: "web-approximation", signatures: ["colorMultiply(_:)"] },
  { kind: "modifier", name: "blendMode", fidelity: "web-approximation", signatures: ["blendMode(_:)"] },
  { kind: "modifier", name: "compositingGroup", fidelity: "web-approximation", signatures: ["compositingGroup()"] },
  { kind: "modifier", name: "drawingGroup", fidelity: "web-approximation", signatures: ["drawingGroup(opaque:colorMode:)"] , lowering: { kind: "slots", labels: ["opaque", "colorMode"] } },
  { kind: "modifier", name: "luminanceToAlpha", fidelity: "web-approximation", signatures: ["luminanceToAlpha()"] },
  { kind: "modifier", name: "tint", fidelity: "source-subset", signatures: ["tint(_:)"] },
  { kind: "modifier", name: "fontWeight", fidelity: "source-subset", signatures: ["fontWeight(_:)"] },
  { kind: "modifier", name: "fontDesign", fidelity: "source-subset", signatures: ["fontDesign(_:)"] },
  { kind: "modifier", name: "fontWidth", fidelity: "source-subset", signatures: ["fontWidth(_:)"] },
  { kind: "modifier", name: "italic", fidelity: "web-approximation", signatures: ["italic(_:)"] },
  { kind: "modifier", name: "underline", fidelity: "web-approximation", signatures: ["underline(_:pattern:color:)"] , lowering: { kind: "slots", labels: [null, "pattern", "color"] } },
  { kind: "modifier", name: "strikethrough", fidelity: "web-approximation", signatures: ["strikethrough(_:pattern:color:)"] , lowering: { kind: "slots", labels: [null, "pattern", "color"] } },
  { kind: "modifier", name: "monospaced", fidelity: "web-approximation", signatures: ["monospaced(_:)"] },
  { kind: "modifier", name: "monospacedDigit", fidelity: "web-approximation", signatures: ["monospacedDigit()"] },
  { kind: "modifier", name: "kerning", fidelity: "web-approximation", signatures: ["kerning(_:)"] , animatable: true },
  { kind: "modifier", name: "tracking", fidelity: "web-approximation", signatures: ["tracking(_:)"] , animatable: true },
  { kind: "modifier", name: "baselineOffset", fidelity: "web-approximation", signatures: ["baselineOffset(_:)"] , animatable: true },
  { kind: "modifier", name: "lineSpacing", fidelity: "web-approximation", signatures: ["lineSpacing(_:)"] , animatable: true },
  { kind: "modifier", name: "lineLimit", fidelity: "web-approximation", signatures: ["lineLimit(_:)", "lineLimit(_:reservesSpace:)"] , lowering: { kind: "slots", labels: [null, "reservesSpace"] } },
  { kind: "modifier", name: "minimumScaleFactor", fidelity: "web-approximation", signatures: ["minimumScaleFactor(_:)"] },
  { kind: "modifier", name: "multilineTextAlignment", fidelity: "web-approximation", signatures: ["multilineTextAlignment(_:)"] },
  { kind: "modifier", name: "truncationMode", fidelity: "web-approximation", signatures: ["truncationMode(_:)"] },
  { kind: "modifier", name: "textCase", fidelity: "web-approximation", signatures: ["textCase(_:)"] },
  { kind: "modifier", name: "allowsTightening", fidelity: "web-approximation", signatures: ["allowsTightening(_:)"] },
  { kind: "modifier", name: "disabled", fidelity: "web-approximation", signatures: ["disabled(_:)"] },
  { kind: "modifier", name: "hidden", fidelity: "web-approximation", signatures: ["hidden()"] },
  { kind: "modifier", name: "allowsHitTesting", fidelity: "web-approximation", signatures: ["allowsHitTesting(_:)"] },
  { kind: "modifier", name: "onTapGesture", fidelity: "web-approximation", signatures: ["onTapGesture(count:perform:)"] , lowering: { kind: "slots", labels: ["count", "perform"] } },
  { kind: "modifier", name: "onLongPressGesture", fidelity: "web-approximation", signatures: ["onLongPressGesture(minimumDuration:maximumDistance:perform:onPressingChanged:)"] , lowering: { kind: "slots", labels: ["minimumDuration", "maximumDistance", "perform", "onPressingChanged"] } },
  { kind: "modifier", name: "onHover", fidelity: "web-approximation", signatures: ["onHover(perform:)"] , lowering: { kind: "slots", labels: ["perform"] } },
  { kind: "modifier", name: "preferredColorScheme", fidelity: "web-approximation", signatures: ["preferredColorScheme(_:)"] },
  { kind: "modifier", name: "controlSize", fidelity: "web-approximation", signatures: ["controlSize(_:)"] },
  { kind: "modifier", name: "scrollDisabled", fidelity: "web-approximation", signatures: ["scrollDisabled(_:)"] },
  { kind: "modifier", name: "scrollIndicators", fidelity: "web-approximation", signatures: ["scrollIndicators(_:axes:)"] , lowering: { kind: "slots", labels: [null, "axes"] } },
  { kind: "modifier", name: "scrollBounceBehavior", fidelity: "web-approximation", signatures: ["scrollBounceBehavior(_:axes:)"] , lowering: { kind: "slots", labels: [null, "axes"] } },
  { kind: "modifier", name: "scrollClipDisabled", fidelity: "web-approximation", signatures: ["scrollClipDisabled(_:)"] },
  { kind: "modifier", name: "scrollDismissesKeyboard", fidelity: "web-approximation", signatures: ["scrollDismissesKeyboard(_:)"] },
  { kind: "modifier", name: "accessibilityLabel", fidelity: "web-approximation", signatures: ["accessibilityLabel(_:)"] },
  { kind: "modifier", name: "accessibilityHint", fidelity: "web-approximation", signatures: ["accessibilityHint(_:)"] },
  { kind: "modifier", name: "accessibilityValue", fidelity: "web-approximation", signatures: ["accessibilityValue(_:)"] },
  { kind: "modifier", name: "accessibilityHidden", fidelity: "web-approximation", signatures: ["accessibilityHidden(_:)"] },
  { kind: "modifier", name: "accessibilityIdentifier", fidelity: "web-approximation", signatures: ["accessibilityIdentifier(_:)"] },
  { kind: "modifier", name: "accessibilityHeading", fidelity: "web-approximation", signatures: ["accessibilityHeading(_:)"] },
  { kind: "modifier", name: "accessibilitySortPriority", fidelity: "web-approximation", signatures: ["accessibilitySortPriority(_:)"] },
  { kind: "modifier", name: "ignoresSafeArea", fidelity: "web-approximation", signatures: ["ignoresSafeArea(_:edges:)"], lowering: { kind: "slots", labels: [null, "edges"] } },
  { kind: "modifier", name: "safeAreaPadding", fidelity: "web-approximation", signatures: ["safeAreaPadding(_:)", "safeAreaPadding(_:_:)" ] },
  { kind: "modifier", name: "gridCellColumns", fidelity: "web-approximation", signatures: ["gridCellColumns(_:)"] },
  { kind: "modifier", name: "gridCellUnsizedAxes", fidelity: "web-approximation", signatures: ["gridCellUnsizedAxes(_:)"] },
  { kind: "modifier", name: "gridCellAnchor", fidelity: "web-approximation", signatures: ["gridCellAnchor(_:)"] },
  { kind: "modifier", name: "gridColumnAlignment", fidelity: "web-approximation", signatures: ["gridColumnAlignment(_:)"] },
  { kind: "modifier", name: "transformEffect", fidelity: "web-approximation", signatures: ["transformEffect(_:)"] , animatable: true },
  { kind: "modifier", name: "projectionEffect", fidelity: "web-approximation", signatures: ["projectionEffect(_:)"] , animatable: true },
  { kind: "modifier", name: "rotation3DEffect", fidelity: "web-approximation", signatures: ["rotation3DEffect(_:axis:anchor:anchorZ:perspective:)"], lowering: { kind: "slots", labels: [null, "axis", "anchor", "anchorZ", "perspective"] }, animatable: true },
  { kind: "modifier", name: "backgroundStyle", fidelity: "web-approximation", signatures: ["backgroundStyle(_:)"] },
  { kind: "modifier", name: "dynamicTypeSize", fidelity: "web-approximation", signatures: ["dynamicTypeSize(_:)"] },
  { kind: "modifier", name: "focusable", fidelity: "web-approximation", signatures: ["focusable(_:)"] },
  { kind: "modifier", name: "id", fidelity: "source-subset", signatures: ["id(_:)"] },
  { kind: "modifier", name: "buttonStyle", fidelity: "web-approximation", signatures: ["buttonStyle(_:)"] },
  { kind: "modifier", name: "toggleStyle", fidelity: "web-approximation", signatures: ["toggleStyle(_:)"] },
  { kind: "modifier", name: "pickerStyle", fidelity: "web-approximation", signatures: ["pickerStyle(_:)"] },
  { kind: "modifier", name: "textFieldStyle", fidelity: "web-approximation", signatures: ["textFieldStyle(_:)"] },
  { kind: "modifier", name: "textEditorStyle", fidelity: "web-approximation", signatures: ["textEditorStyle(_:)"] },
  { kind: "modifier", name: "listStyle", fidelity: "web-approximation", signatures: ["listStyle(_:)"] },
  { kind: "modifier", name: "labelStyle", fidelity: "web-approximation", signatures: ["labelStyle(_:)"] },
  { kind: "modifier", name: "progressViewStyle", fidelity: "web-approximation", signatures: ["progressViewStyle(_:)"] },
  { kind: "modifier", name: "listRowInsets", fidelity: "web-approximation", signatures: ["listRowInsets(_:)", "listRowInsets(_:_:)" ] },
  { kind: "modifier", name: "listRowBackground", fidelity: "web-approximation", signatures: ["listRowBackground(_:)"] },
  { kind: "modifier", name: "listRowSeparator", fidelity: "web-approximation", signatures: ["listRowSeparator(_:edges:)"], lowering: { kind: "slots", labels: [null, "edges"] } },
  { kind: "modifier", name: "listSectionSeparator", fidelity: "web-approximation", signatures: ["listSectionSeparator(_:edges:)"], lowering: { kind: "slots", labels: [null, "edges"] } },
  { kind: "modifier", name: "symbolRenderingMode", fidelity: "source-subset", signatures: ["symbolRenderingMode(_:)"] },
  { kind: "modifier", name: "symbolVariant", fidelity: "source-subset", signatures: ["symbolVariant(_:)"] },
  { kind: "modifier", name: "draggable", fidelity: "web-approximation", signatures: ["draggable(_:)"] },
  { kind: "modifier", name: "dropDestination", fidelity: "web-approximation", signatures: ["dropDestination(for:action:isTargeted:)"], lowering: { kind: "slots", labels: ["for", "action", "isTargeted"] } },
  { kind: "modifier", name: "accessibilityElement", fidelity: "web-approximation", signatures: ["accessibilityElement(children:)"], lowering: { kind: "slots", labels: ["children"] } },
  { kind: "modifier", name: "accessibilityAction", fidelity: "web-approximation", signatures: ["accessibilityAction(_:_:)"] },
  // Compatibility surface. These remain callable while the canonical SwiftUI
  // surface is expanded, but the parity tool does not count them as SwiftUI.
  { kind: "modifier", name: "margin", signatures: ["margin(_:)"] , compatibility: true },
  { kind: "modifier", name: "gap", signatures: ["gap(_:)"] , compatibility: true },
  { kind: "modifier", name: "fontSize", signatures: ["fontSize(_:)"] , compatibility: true },
  { kind: "modifier", name: "foreground", signatures: ["foreground(_:)"] , compatibility: true },
  { kind: "modifier", name: "style", signatures: ["style(_:)"] , compatibility: true },
  { kind: "modifier", name: "className", signatures: ["className(_:)"] , compatibility: true },
  { kind: "modifier", name: "withProps", signatures: ["withProps(_:)"] , compatibility: true },
  { kind: "modifier", name: "keyed", signatures: ["keyed(_:)"] , compatibility: true },
  { kind: "modifier", name: "elementRef", signatures: ["elementRef(_:)"] , compatibility: true },
  { kind: "modifier", name: "continuousCorners", signatures: ["continuousCorners(_:)"], compatibility: true },
] as const satisfies readonly SwiftUIModifierSpec[])

/** Canonical SwiftUI source contract. Runtime compatibility overloads map into it explicitly. */
export const swiftUIApiManifest = Object.freeze({
  schemaVersion: 1,
  views,
  modifiers,
})

export const swiftUIStaticModifierNames: ReadonlySet<string> = new Set(modifiers.map(modifier => modifier.name))
export const swiftUIAnimatableModifierNames: ReadonlySet<string> = new Set(modifiers.filter(modifier => "animatable" in modifier && modifier.animatable).map(modifier => modifier.name))
export const swiftUICanonicalModifierNames: ReadonlySet<string> = new Set(modifiers.filter(modifier => !("compatibility" in modifier && modifier.compatibility)).map(modifier => modifier.name))

export function swiftUIModifierLowering(name: string): SwiftUIModifierLoweringSpec | undefined {
  const modifier = modifiers.find(modifier => modifier.name === name)
  return modifier && "lowering" in modifier ? modifier.lowering : undefined
}

/** Compiler-ready semantic symbols generated from the canonical manifest. */
export function swiftUIInitializerSymbols(name: string): readonly SemanticInitializerSymbol[] | undefined {
  const spec = views[name as keyof typeof views]
  if (!spec) return undefined
  return spec.initializers.map((initializer, index) => Object.freeze({
    kind: "initializer" as const,
    index: "runtimeIndex" in initializer ? initializer.runtimeIndex : index,
    signature: initializer.signature,
    parameters: initializer.parameters,
  }))
}

export function swiftUIViewNames(): readonly string[] {
  return Object.keys(views)
}

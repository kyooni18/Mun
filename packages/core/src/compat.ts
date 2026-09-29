/**
 * Transitional compatibility surface for the pre-IR TypeScript View graph.
 *
 * Canonical Mün source compiles to Semantic UI IR through @mun/core. Renderer
 * adapters that still consume the historical graph import this module
 * explicitly so DOM/HTML-oriented compatibility does not define core Mün.
 */
export * from "./animation.js"
export * from "./api-manifest.js"
export * from "./closures.js"
export * from "./content-transition.js"
export * from "./controls.js"
export * from "./advanced.js"
export * from "./style.js"
export * from "./graph.js"
export * from "./html.js"
export * from "./identity.js"
export * from "./layout.js"
export * from "./presentation.js"
export {
  Action,
  Binding,
  State,
  collectStateReads,
  isBinding,
  isStateRef,
  resolveValue,
  stateTransaction,
  stateVersion,
  subscribeState,
} from "./state.js"
export type { BindingRef, StateRef, Value } from "./state.js"
export * from "./transition.js"
export { VectorSymbol } from "./vector-symbol.js"
export type {
  LucideIconDataLike,
  SVGIconAttributeValue,
  SVGIconNode,
  SVGIconOptions,
  VectorSymbolDescriptor,
  VectorSymbolLayer,
  VectorSymbolOptions,
} from "./vector-symbol.js"
export * from "./semantic.js"
export * from "./views.js"
export * from "./ui-ir.js"
export { Path, TextEditor } from "./web-primitives.js"
export type { PathProps, TextEditorProps } from "./web-primitives.js"

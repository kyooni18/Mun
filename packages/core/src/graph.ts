/**
 * Public graph barrel.
 *
 * Runtime concerns intentionally live behind focused modules so renderer
 * adapters depend on stable graph contracts rather than one monolithic file:
 * types/environment, nodes, modifiers, traversal, and initializer semantics.
 */
export { munForeignComponent, munInitializers, munNamedArguments, munView } from "./graph/symbols.js"
export type {
  ClassValue,
  CompiledTemplateDescriptor,
  CompiledTemplateElement,
  CompiledTemplateFragment,
  CompiledTemplateSlot,
  CompiledTemplateValue,
  CompiledTemplateViewNode,
  EdgeInsets,
  ElementViewNode,
  ForeignComponentDescriptor,
  ForeignComponentOptions,
  ForeignComponentSchema,
  ForeignComponentSlot,
  FragmentViewNode,
  GeometryFrame,
  GeometryProxy,
  GeometryViewNode,
  LazyViewNode,
  LazyViewRange,
  Length,
  ModifiableViewNode,
  ModifiedContent,
  Modifiers,
  OffsetValue,
  Point,
  ScaleEffectValue,
  Size,
  View,
  ViewGraphChild,
  ViewGraphLeaf,
  ViewGraphValue,
  ViewHostNode,
  ViewModifier,
  ViewModifierNode,
  ViewNode,
  ViewValue,
  MunRenderer,
} from "./graph/types.js"
export * from "./graph/environment.js"
export { modifiedContent, modifiedContentCompiled, modifier, modifierGraphOf } from "./graph/modifiers.js"
export {
  ForeignComponent,
  compiledTemplate,
  defineCompiledTemplate,
  geometryView,
  isForeignComponent,
  isViewNode,
  lazyView,
  viewElement,
  viewFragment,
  viewHost,
} from "./graph/nodes.js"
export { collectLogicalViewIdentities, renderViewNode } from "./graph/renderer.js"
export {
  ViewBuilder,
  ViewType,
  MunInitializerAmbiguityError,
  MunInitializerError,
  assertInitializerCall,
  createViewNode,
  defineBuiltinView,
  defineView,
  flattenViewBuilder,
  initializer,
  initializerKinds,
  initializersOf,
  namedArguments,
  registerInitializers,
  resolveBuilderClosure,
  resolveBuilderInput,
  resolveInitializer,
  structView,
  viewBuilderSemanticSymbol,
} from "./graph/initializers.js"
export type {
  InitializerMatch,
  InitializerParameter,
  InitializerParameterKind,
  InitializerResolution,
  NamedArguments,
  TypedViewConstructor,
  ViewBuilderClosure,
  ViewBuilderContent,
  ViewBuilderResult,
  ViewConstructor,
  ViewConstructorMetadata,
  ViewDefinition,
  ViewFieldDefinition,
} from "./graph/initializers.js"

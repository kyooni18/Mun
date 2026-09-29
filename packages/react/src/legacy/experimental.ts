/**
 * Mun's exploratory runtime surface. These APIs are intentionally separate
 * from the stable function DSL until their geometry and plugin contracts are
 * consolidated.
 */
export { coordinateSpace, coordinateSpaceOf, emptyLayoutNode } from './coordinate.js'
export type { CoordinateNode, CoordinateSpace, LayoutFrame } from './coordinate.js'

export { createLayoutNode, layoutPass } from './layout-engine.js'
export type { LayoutNode, LayoutResult, ProposedSize } from './layout-engine.js'

export * from './runtime/layout-observer.js'
export * from './runtime/modifier-pipeline.js'
export * from './runtime/renderer.js'
export * from './runtime/view-graph.js'
export * from './runtime/jsx-node.js'
export * from './runtime/coordinate-runtime.js'

export { collectChildren, resolveBuilder } from './builder.js'
export type { MunBuilder } from './builder.js'
export { transformMunBuilderSyntax } from './compiler/builder-transform.js'

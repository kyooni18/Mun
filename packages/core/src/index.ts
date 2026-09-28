/**
 * Canonical backend-neutral Mün core.
 *
 * This surface describes language semantics, motion values, and Semantic UI IR.
 * The historical TypeScript View graph lives at @mun/core/compat and is used by
 * compatibility renderers while they migrate to direct Semantic UI IR lowering.
 */
export {
  Animation,
  Transaction,
  currentTransaction,
  snapshotTransaction,
  swiftUIAnimationFactoryArgumentLabels,
  withAnimation,
  withTransaction,
} from "./animation.js"
export type {
  AnimationDescriptor,
  AnimationKind,
  TransactionOptions,
} from "./animation.js"
export * from "./closures.js"
export * from "./semantic.js"
export * from "./ui-ir.js"

export { Transition } from "./transition.js"
export type { TransitionDescriptor, TransitionEdge, TransitionEffect } from "./transition.js"

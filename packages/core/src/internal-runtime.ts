/**
 * Compiler/renderer ABI. This subpath is intentionally not part of the
 * user-facing Mun authoring surface; adapters may evolve it in lockstep with
 * core without widening the candidate 1.0 root API.
 */
export {
  compiledCollectionContent,
  compiledCollectionPlanOf,
  keyedCollectionChildKey,
  keyedCollectionEntries,
  keyedCollectionEntryKey,
  keyedCollectionView,
  gpuIslandView,
} from "./graph/nodes.js"
export { renderViewNodeAt } from "./graph/renderer.js"
export { ignoresSafeAreaStyle, paddingStyle, safeAreaPaddingStyle } from "./internal-layout.js"
export { mapStateArrayData, reactiveIdentity } from "./state.js"
export { snapshotStateArrayForSubscription } from "./state-internal.js"
export type {
  CompiledPatchIR,
  CompiledPatchLocation,
  CompiledPatchValues,
  CompiledCollectionPlan,
  CompiledCollectionRow,
  CompiledTemplateSlotKind,
  CompiledViewBodyEvaluation,
  CompiledViewBodyPlan,
  CompiledViewModifierSpec,
  KeyedCollectionEntry,
  KeyedCollectionIdentity,
  KeyedCollectionViewNode,
  GPUIslandGraphIR,
  GPUIslandViewNode,
  GPUIslandViewOptions,
} from "./graph/types.js"
export type { StateListener, StateMutation, StateMutationBatch } from "./state.js"

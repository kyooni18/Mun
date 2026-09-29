# Compiler optimization

Mün treats optimization as removal of work whose semantic answer is already
known, not as a second definition of the UI language. The canonical View graph,
initializer metadata, State/Binding semantics, identity rules, and renderer
contracts remain owned by `@mun/core`.

## Optimization pipeline

After Mün-only syntax has been lowered to valid TypeScript, the compiler can
use the TypeScript `TypeChecker` and Mün's semantic metadata to specialize the
program. The current production path performs these high-value steps:

1. Resolve same-file and imported View calls when the initializer is uniquely
   known. Proven calls use `createNodeCompiled`; uncertain calls keep
   `createNodeSpecialized` or the ordinary runtime callable path.
2. Normalize compiler-generated labeled-argument carriers into the exact
   runtime parameter slots when labels/properties map unambiguously.
3. Replace simple zero-argument `@ViewBuilder` closures with their produced
   child arrays. Action closures remain closures because their execution is
   intentionally deferred.
4. Fuse statically typed modifier chains into one `modifiedContentCompiled`
   operation with compact `[name, arguments]` tuples.
5. Lower proven intrinsic host subtrees into a renderer-neutral compiled
   template plus dynamic slots. Static host element names, props, styles, and
   leaves are frozen once at module evaluation; only slot values are allocated
   per evaluation. Opaque/custom View children can remain slots without forcing
   the intrinsic parent back to the generic builder path.
6. Hoist fully static compiled subtrees whose construction contains no dynamic
   values, opaque calls, State reads, refs, or user-controlled accessors.
7. Attach declared State dependency metadata. A separate
   `dependenciesComplete` flag tells a renderer whether runtime discovery may
   be skipped or whether the metadata is only a seed.

## Trusted initializer path

`createNodeCompiled` is intentionally narrower than the normal callable View
API. It assumes the compiler has already selected the concrete initializer and
validated the argument shape. It therefore does not repeat overload search,
named-argument normalization, closure-role selection, or runtime parameter
scoring. Initializer build functions still own semantic materialization such as
option snapshotting and immutable graph construction.

The compiler will not enter this path merely because a call looks static. `any`,
`unknown`, `never`, unsafe callable return/parameter types, unresolved
variadics, and ambiguous mappings force a guarded fallback. Callable types are
inspected recursively so `() => any` cannot bypass ViewBuilder validation by
hiding an unsafe result inside an otherwise object-like function type.

## Compiled template and slot IR

`defineCompiledTemplate` freezes a renderer-neutral host template once, while
`compiledTemplate` binds the dynamic graph/value slots for one evaluation. A
template contains only host `element`/`fragment` instructions, inert data props,
primitive leaves, and explicit slots. Each slot records the structural identity
path that the equivalent ordinary graph would have used. `defineCompiledTemplate`
validates that every slot is present exactly once and pre-indexes those identity
paths, so updates do not rescan the static template just to route dynamic Views.
This keeps keyed/custom View lifetime identical when a static parent is compiled
away.

The compiler derives host props by executing the already-proven core builtin
initializer at compile time with inert marker values. It does not maintain a
second VStack/Text/CSS semantic table. If the resulting graph contains geometry,
lazy nodes, modified content, functions, foreign renderer values, unsupported
props, unsafe arguments, or another shape it cannot serialize, the pass simply
keeps the existing compiled/generic graph path.

React, Vue, Web DOM, and Web SSR expose a `MunRenderer.template` fast path. They
compile each immutable descriptor into a renderer-native factory once and reuse
that factory for later instances, materializing native elements/VNodes/DOM/HTML
without repeating the generic host-node kind dispatch. They re-enter generic
graph traversal only for dynamic slots. A renderer that does
not implement the hook receives an equivalent generic traversal from core. This
makes the optimization optional and preserves the renderer-independent semantic
contract.

## Static subtrees

A compiled node can be hoisted only when its complete construction is immutable
and independent of render-time state. The analysis intentionally rejects opaque
identifiers, arbitrary property access, function/action values, refs, dynamic
State, and unknown calls. A dynamic parent may still reuse a proven static
child.

The important optimization is structural: repeated renders no longer allocate
identical Mün graph objects for content such as a fixed title or static stack.
This preserves renderer independence while reducing allocation and graph
traversal before React, Vue, or Web materialization.

## State dependency proof

Runtime dependency collection remains the correctness baseline. Compiler
metadata only replaces it when the complete read set is proven. The proof uses
a deliberately small closed world of locally owned State reads and known Mün
or intrinsic operations. Arbitrary member calls are not assumed pure merely
because a method happens to have a modifier-like name.

When the proof fails, renderers merge declared dependencies with the reads
observed during graph evaluation. This allows the optimization to expand later
without making an incomplete static analysis a correctness dependency.

## Renderer boundary

The first renderer-native AOT phase is implemented through the shared template/
slot IR. The compiler still emits renderer-neutral Mün values; it never imports
React, Vue, or DOM APIs. Each renderer owns the final native materialization of
that IR. This is deliberately preferable to three compiler backends that could
quietly redefine Mün semantics.

The template path now also carries dependency-to-patch metadata for exhaustive
State-backed text slots. Direct Web resolves those compiler prop names to the
mounted State identities once and reuses a packed dirty mask, so changing one
independent State can evaluate only the slots that depend on it. The full slot
evaluator remains the exact fallback when dependency ownership cannot be proven.

The next frontier is the same mechanism for dynamic host props/styles,
event/action slots, and keyed collection templates. Those extensions must
preserve the same rule: code the compiler cannot prove remains a normal Mün
graph and is handled by the existing traversal.

## Compute planning and Kernel IR

The compiler now has one shared syntax-level effect analysis for data-oriented
specializations. Collection rows and immutable State array maps no longer keep
separate definitions of scalar purity. The common proof records row/index
dependencies, ambient scalar captures, access depth, dynamic element access,
and intrinsic blockers such as calls, assignments, ambient member reads, and
unsupported expressions. Each consumer still applies its own stricter policy.

Proven scalar/map expressions can additionally lower into a small
backend-neutral Kernel IR. The initial instruction set covers constants, row
loads, index and captured scalar inputs, unary/binary operations, conditional
select, and map field outputs. Kernel coverage alone does not establish a
Resident Compute region: object-backed State maps and DOM collection rows keep
their ordinary JavaScript execution and report packed/native backends blocked.

The Vite compiler can expose a post-specialization execution plan through the
opt-in `onExecutionPlan` hook. Planning is skipped entirely when the hook is not
configured. Each region records its effect facts, Kernel IR coverage, output
sink, explicit input/output residency, and hypothetical backend suitability.
Those backend entries are diagnostic planning hints only and do not activate a
native runtime path. A separate packed-to-packed `ResidentRegionIR` can be
lowered into a fused TypedArray loop with `emitResidentRegionJS`. This is the
mandatory baseline for future native promotion; see
[RESIDENT_COMPUTE.md](RESIDENT_COMPUTE.md).

Resident fusion now optimizes that shared IR before backend lowering. A backward
field-liveness pass removes writes that are overwritten before the sink, safe
constant/algebraic folding reduces arithmetic, and captures are narrowed to the
retained expressions. The same optimized region can feed packed JS, direct
scalar/SIMD WASM, or the experimental SoA Kernel IR to WGSL emitter. WGSL
lowering remains compute-only until the compiler can prove a GPU-resident render
consumer; a DOM consumer still blocks WebGPU promotion.

Eligible dense-`f32` resident regions additionally carry an experimental
region-specific WebAssembly module generated directly from Kernel IR. Its row
loop hoists column bases and executes the fused arithmetic without bytecode
dispatch. The bytecode form remains as the generic compatibility and shared
Worker representation. Native selection remains measurement-driven because a
specialized scalar WASM loop can still lose to a JIT-optimized packed-JS loop
on a particular engine or workload.

## Performance measurement

Optimization is evaluated against equivalent host-framework work. The
application benchmark contains raw React and raw Vue client baselines alongside
Mün React/Vue for full-tree updates, single-item changes, and keyed reversal.
The benchmark also measures dynamic, specialized, and compiled initializer
construction, plus ordinary dynamic graph construction against compiled
template instantiation.

Ratio limits are regression ceilings, not promises of a fixed performance
multiple. The target is to make Mün's semantic abstraction disappear from hot
production paths whenever its answer is statically knowable, while preserving
identical behavior for every fallback case.

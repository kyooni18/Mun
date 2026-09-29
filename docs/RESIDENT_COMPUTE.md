# Resident Compute Islands

Mün's native compute architecture is organized around data residency, not
isolated arithmetic expressions. A backend may be promoted only when the
producer, fused compute kernels, and consumer share a representation long
enough to amortize every boundary.

```text
Mün source
  -> semantic compiler
      +-> ordinary View graph -> React / Vue / DOM
      `-> ResidentRegionIR -> packed numeric storage
                               +-> compiled JS TypedArray loop
                               +-> WASM SIMD (experimental)
                               +-> shared Worker/WASM (experimental)
                               `-> GPU Island (experimental) -> GPU renderer
```

An object-backed `State<T[]>` map and a DOM collection are not Resident Compute
regions. Kernel IR coverage can make those paths easier to analyze, but it does
not make row packing, object reconstruction, DOM patching, or readback free.
The execution-plan diagnostic therefore reports native backends as blocked for
those regions even when their scalar expressions are portable.

## Milestone 1: packed JavaScript baseline

The first implementation contains no WASM, Worker, or WebGPU execution.
`@mun/core/internal/execution` defines column layouts, packed storage,
Kernel IR, and `ResidentRegionIR`. A valid initial region must be packed at both
ends, use matching stable layouts, and contain map kernels whose fields have
already passed type/layout proof.

Two JavaScript paths exist for different purposes:

- `executeResidentRegionJS` is a small correctness/reference executor.
- `emitResidentRegionJS` lowers a proven region at compile time into one fused
  numeric loop with column indexes and captures fixed outside the row loop.

The emitted loop is ordinary bundled JavaScript and does not require runtime
code generation, `eval`, or object materialization. Callers own source and sink
storage, so persistent regions can reuse the same allocation and increment its
version after each execution.

Run the baseline with:

```sh
pnpm benchmark:resident
```

The benchmark compares an object `map` that reconstructs rows with the fused,
in-place TypedArray executor and verifies equivalent checksums. It is evidence
for the packed architecture, not a fixed cross-machine performance promise.

## Milestone 2: persistent packed state

Persistent packed residency is now implemented in the same internal execution
surface.

- `PackedState` owns authoritative column memory, logical length, reserved
  capacity, versioning, and merged dirty ranges.
- `reserve()` and `resize()` keep stable packed allocation semantics while
  making view re-acquisition explicit through `PackedStateChange.storageChanged`.
- `mutate()` and `invalidate()` record versioned dirty ranges instead of
  forcing whole-buffer work.
- `executeResidentRegionPackedState()` reuses those dirty ranges and only
  evaluates the affected packed rows while marking the fused output columns
  dirty for the next resident consumer.
- `emitResidentRegionJS()` now emits the matching range-aware packed loop, so
  the compile-time baseline and the reference executor share one residency
  contract.

## Promotion rule

Backend selection must account for the whole boundary:

```text
benefit = compute cost saved
        - transfer cost
        - materialization cost
        - synchronization cost
```

Rows alone are not a sufficient threshold. Native promotion uses actual dirty
rows multiplied by compiler-known weighted kernel cost and SIMD suitability.
Clearly small work stays on packed JS, clearly large vectorizable work can enter
AOT SIMD immediately, and only the uncertain crossover band is measured. Native
promotion still has to beat the compiled packed-JS executor end to end, not an
intentionally slower object or IR-interpreter baseline.

## Current optimization frontier

The first native and sparse-rendering experiments now exist behind the same
residency and correctness gates:

1. Resident map chains run a backward field-liveness pass before fusion. Writes
   overwritten before the final sink are removed, safe numeric identities and
   constants are folded, captures are narrowed, and the fused operation estimate
   is recomputed from the optimized Kernel IR.
2. Dense `f32` regions can carry region-specific scalar and `f32x4` WebAssembly
   modules. The SIMD module executes four packed rows per iteration and keeps a
   scalar tail for arbitrary dirty-range boundaries. Packed JS remains the
   mandatory baseline and tiny dirty slices continue to prefer it naturally.
3. Shared Worker/WASM has a bounded persistent pool. Hot bindings retain their
   initialized Worker, cold idle bindings are evicted LRU, and pool size is a
   hard upper bound. Eligible Workers now instantiate a shared-memory form of
   the same region-specialized SIMD loop instead of always interpreting the
   generic resident bytecode. Engines that reject the direct shared module fall
   back to the generic Worker ABI. Worker promotion still requires live frame
   pressure plus a measured end-to-end win.
4. GPU Islands now have two compute-to-render proof targets: the particle field
   and a large animated line chart. Both keep the authoritative data buffer on
   the GPU and upload only a small frame uniform. A generic packed-`f32` Kernel
   IR to WGSL lowering also exists for future compiler-proven GPU renderer sinks.
5. Direct Web can map exhaustive State dependencies to individual Patch IR text
   locations. A State-only invalidation can therefore evaluate only the affected
   slot expressions rather than evaluating every dynamic slot in the View body.

The next expansion should focus on filter/transform region semantics, wider
host-prop/style/event Patch IR generation, and GPU renderer sinks that can
consume the generic WGSL region without any CPU readback.

Animation remains the existing proof point for dense resident memory. Its
solver stays animation-owned. The small `@mun/execution` substrate
shares buffer layout, scheduling capability, telemetry, and frame-budget
signals without merging compiler compute and animation semantics.

## Experimental feature toggle

Resident Compute native backends are disabled by default. Existing `State`, DOM,
React, and Vue rendering keeps its normal path until an application explicitly
opts in:

```ts
createMunVitePlugin({ experimentalResidentCompute: true })
mount(App(), container, { experimentalResidentCompute: true })
```

The execution substrate also accepts `{ enabled: true, wasm, worker, gpu }` for
per-backend switches. Omitting the option (or setting `enabled: false`) keeps
the mandatory packed-JavaScript baseline and renderer fallbacks active.

## Experimental direct WASM specialization

Eligible dense-`f32` resident regions now carry four native representations:

- the versioned resident bytecode used by the generic scalar/SIMD ABI and the
  shared-memory Worker path;
- a small region-specific scalar WebAssembly module whose exported row loop
  contains the fused Kernel IR arithmetic directly;
- a region-specific SIMD module that lowers the same Kernel IR to `f32x4`
  operations, including comparisons/selects and a scalar tail;
- a shared-memory version of that direct SIMD module for the persistent Worker
  path.

The direct module removes per-row opcode dispatch, operand-stack interpretation,
and repeated column-pointer lookup from the normal main-thread path. Column base
addresses are hoisted outside the row/range loops. If the engine rejects the
specialized module, Mün falls back to the generic resident kernel without
changing semantics.

The compiler also attaches a cost profile to each native program: loads, stores,
arithmetic, divisions, comparisons/selects, weighted work per item, branch
pressure, and SIMD suitability. `ResidentAdaptiveNativeScheduler` combines that
profile with the actual dirty row count. Conservative bootstrap thresholds avoid
trial execution for obvious cases; samples collected around the crossover build
per-region linear JS/WASM cost models and refine later decisions. Recent global
telemetry still uses a bounded median, so cold compilation and GC pauses do not
dominate calibration.

The native matrix benchmark covers 256 through 262,144 rows, 1/10/100% dirty
ranges, and light, medium, and heavy arithmetic. It now prints the scheduler's
bootstrap choice and reports accuracy on decisive cases, while leaving near-
crossover cases to calibration rather than pretending one fixed threshold is
universal.

Run the matrix with `pnpm benchmark:resident:native`. Release validation uses a
conservative large/full-range regression ceiling and verifies that the compiler
still reaches the `wasm-aot-simd` backend without weakening packed-JS fallback.

# Mün architecture

Mün is a native-first standalone UI language and runtime. The canonical source
format is `.mun`, and the canonical cross-backend contract is Mün Semantic UI
IR.

```text
.mun
  |
  v
parser / semantic analysis
  |
  v
Semantic UI IR
  |
  +--> native runtime/backend        primary
  |      +--> state + transactions
  |      +--> layout + motion
  |      +--> input + accessibility
  |      +--> retained scene
  |      +--> platform renderer
  |
  +--> Web / Astro lowering          secondary
```

The language does not use DOM nodes, HTML tags, CSS properties, React elements,
Vue VNodes, WebView, or Chromium as core concepts.

See [NATIVE_ARCHITECTURE.md](./NATIVE_ARCHITECTURE.md) for the native runtime
details and [MOTION_MIGRATION.md](./MOTION_MIGRATION.md) for the reused motion
subsystems.

## Canonical package boundary

`@mun/core` is the backend-neutral canonical surface. It exposes Semantic UI
IR, semantic symbol resolution, closures used by language analysis, and the
renderer-neutral animation/transaction/transition values required by
compilation. It must not expose the historical HTML graph as the canonical
language model.

The older TypeScript View graph remains available explicitly through
`@mun/core/compat`. Existing React, Vue, Astro, and direct Web compatibility
adapters may depend on that subpath while they migrate. New language semantics
must not be defined there.

`@mun/compiler` owns parsing, semantic analysis, diagnostics, and lowering from
canonical `.mun` source into Semantic UI IR. TypeScript machinery may remain an
implementation technique for analysis and compatibility transforms, but
`.mun.ts` is not a canonical language format.

`@mun/web` is a secondary backend. It owns browser output and may therefore use
HTML, DOM, CSS, hydration, browser events, and browser layout internally. Those
concepts must not flow back into `@mun/core`, Semantic UI IR, or canonical Mün
source.

`@mun/react`, `@mun/vue`, and the current Astro integration are compatibility
or host-integration surfaces. They consume Mün; they do not define Mün.

## Semantic UI IR

Semantic UI IR represents UI meaning rather than a renderer tree. Current nodes
cover window, row, column, conditional, text, panel, and action semantics.
State expressions, layout, visual properties, accessibility metadata,
transitions, actions, transaction metadata, and motion bindings are attached as
backend-neutral data.

A backend chooses its representation only after this boundary. The native
backend projects the program into runtime state, layout, a retained visual
scene, and a separate accessibility tree. The Web backend may project the same
program into browser output.

Unsupported canonical constructs fail explicitly rather than silently acquiring
Web-specific meaning.

## Native runtime

The native runtime is the primary execution architecture. It owns state
mutation, transaction resolution, presentation values, motion scheduling,
layout, hit testing, focus, accessibility projection, retained scene
construction, and rendering integration.

Platform libraries are downstream implementation details. Their object models
must not become Mün syntax or Semantic UI IR types.

```text
state mutation
    |
    v
Transaction
    |
    v
motion resolution
    |
    v
presentation state
    |
    v
layout
    |
    +--> retained visual Scene --> native renderer
    |
    +--> AccessibilityTree     --> platform a11y
```

## Motion reuse

Mün reuses the existing renderer-neutral animation assets rather than creating a
native-only animation model. `Animation`, `Transaction`,
`withAnimation`, `withTransaction`, transition semantics, and
`@mun/animation/core` planning remain above backends.

The compiler serializes compact motion execution plans and semantic property
masks into the IR. Native Rust execution preserves spring/timing behavior,
velocity-preserving retargeting, delay, repetition, autoreverse, and transaction
precedence. Web lowering may realize the same plans with browser mechanisms, but
browser timing APIs are not the semantic authority.

## Web and Astro

Web output is intentionally downstream:

```text
.mun
  -> @mun/compiler
  -> Semantic UI IR
  -> @mun/web
  -> browser representation
```

Astro follows the same direction. An `@mun { ... }` region is Mün source
embedded in an Astro host file; it must pass through the same compiler and
Semantic UI IR as standalone `.mun` before Web lowering.

Host HTML remains host HTML. Raw HTML is not canonical Mün syntax.

## Compatibility graph

The historical graph, initializer manifest, host styling helpers, HTML element
types, renderer traversal, and framework bridges remain valuable migration
assets. They are compatibility implementation, not the core contract.

The explicit boundary is:

```text
@mun/core          Semantic UI IR + semantic language contract
@mun/core/compat   historical TypeScript View graph
@mun/web           secondary browser backend
@mun/react         compatibility React adapter
@mun/vue           compatibility Vue adapter
```

Compatibility code can continue to evolve for maintenance, but a new canonical
feature should be specified first in Mün semantics and Semantic UI IR, then
implemented in the native runtime, and only then lowered by secondary backends.

## Compiler and optimization rule

Compiler optimizations may specialize, fuse, cache, or precompute a program only
when they preserve the canonical semantic result. Existing packed execution,
resident compute, GPU eligibility, and compatibility graph specialization are
optimization layers; none of them define a second UI language.

Likewise, editor tooling should offer Mün views and language constructs for
canonical `.mun` source. Host tag names and browser attributes belong to
host-language tooling, not Mün completions.

## Architectural invariants

1. `.mun` is the canonical source format.
2. Semantic UI IR is the canonical cross-backend UI contract.
3. `@mun/core` is backend-neutral and does not expose HTML semantics.
4. Native execution is the primary architecture.
5. `@mun/web` is a secondary lowering target.
6. Astro consumes Mün through the same compiler and IR.
7. The historical View graph is explicit compatibility at `@mun/core/compat`.
8. Motion/runtime assets are reused wherever their behavior is renderer-neutral.
9. New features are not specified in terms of a particular backend's object
   model.

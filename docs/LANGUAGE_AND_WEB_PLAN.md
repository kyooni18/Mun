# Mun language and web implementation plan

Mun will be a SwiftUI-like frontend language capable of building complete web applications. Developers will author application UI and behavior in `.mun`, using Views, state, bindings, modifiers, models, and structured asynchronous work. The compiler and runtime will realize those concepts through HTML, CSS, and JavaScript.

Status: implementation plan; the [first counter/profile milestone](WEB_MILESTONE.md)
is implemented with [documented capability limits](CAPABILITIES.md). Subsequent
phases remain planned. The product direction is agreed; API spelling, package boundaries, and individual language features below require implementation design. Existing APIs remain supported during migration.

## Product contract

- Make `.mun` the primary documented authoring language, including application behavior. Typical applications must not require handwritten JavaScript or TypeScript companion files.
- Preserve SwiftUI's recognizable composition model: `struct`, `View`, `body`, builder blocks, labeled arguments, property wrappers, bindings, environment, identity, and ordered modifiers.
- Define Mun's own language semantics and supported Swift-like subset. Full Swift source compatibility, Apple's SwiftUI implementation, and Swift ABI compatibility are outside this plan.
- Express web capabilities through consistent Mun APIs. Responsive layout, semantic documents, routing, forms, browser services, and advanced styling are first-class language and library concerns.
- Support browser capabilities beyond the standard library through typed, lifecycle-aware interop. Functional completeness means a growing standard library plus access to the underlying platform, rather than a promise to wrap every browser API before release.
- Keep browser output compatible with native navigation, accessibility, text selection, form behavior, and developer tools.

JavaScript is a compilation target and an integration boundary. Direct JS/TS View builders can remain available without defining the primary Mun experience. Native targets and React/Vue adapters remain optional consumers.

## Starting point

The repository already contains substantial reusable infrastructure:

| Area | Existing location | Planned use |
| --- | --- | --- |
| Parsing, transformation, semantic analysis and diagnostics | `packages/compiler/src` | Extend toward one explicit Mun language contract |
| Views, state, bindings, identity, styles and controls | `packages/core/src` | Preserve behavior while clarifying runtime semantics |
| DOM rendering, server HTML, hydration and focus | `packages/web/src` | Primary browser implementation |
| Animation | `packages/animation` | Preserve transactions, interruption and motion behavior |
| Development integration | `packages/vite`, `bin`, `editors` | Compile, preview, diagnose and debug Mun applications |
| Native Semantic UI IR | Compiler, core and native packages | Reuse useful analysis without restricting web capabilities |

These locations establish implementation starting points, not evidence that every required behavior is complete. README, architecture and roadmap currently center JS/TS authoring with optional `.mun`; several language and styling documents retain an older native-first contract. Phase 1 reconciles both with the agreed language direction.

## Target architecture

```text
.mun modules
    |
    v
Parser and source AST
    |
    v
Module resolution, name resolution and type checking
    |
    v
Typed Mun program
    |                         |
    v                         v
Client lowering               Server lowering
    |                         |
    v                         v
Reactive runtime and DOM      HTML and hydration data
    |                         |
    +---------- Browser ------+
```

The typed program must describe ordinary functions and expressions, model behavior, async operations, UI composition, and web capabilities. It cannot be limited to a static UI tree. Start with an internal typed representation over existing parser and semantic structures; introduce a separate serialized IR only when a demonstrated consumer needs it.

Shared analysis feeds client and server output. Browser-only operations have explicit execution boundaries. Core composition stays separate from DOM implementation, while the web standard library can represent capabilities that have no native equivalent.

## Phase 1 Define the language and migration contract

Write a compact language specification covering declarations, imports, functions, closures, control flow, collections, optionals, type inference, errors, and `async`/`await`. Document supported Swift-like behavior and deliberate differences, including numeric types, equality, reference versus value semantics, and JavaScript boundary conversions. Decide model and observable declaration syntax here rather than accidentally promising all of Swift.

Specify builder branches and loops, parameter labels, `@State`, `@Binding`, environment, identity, task lifetime, and modifier ordering. Establish the server/client execution model and state serialization limits before adding application APIs.

Create a capability matrix with four statuses: verified, partial, missing, and experimental. Audit current code and tests against that matrix. Mark proposed APIs separately from implemented ones.

Update README, architecture, styling, language reference and scaffolds to communicate one direction. Keep historical native design material clearly identified. Document compatibility for existing `.mun` sources and JS/TS consumers.

Exit criteria: a consistent language contract, a migration policy, and a prioritized gap matrix. A counter and an async form have agreed Mun source examples that guide subsequent phases.

## Phase 2 Build a reliable Mun compilation path

Extend the existing parser and semantic model incrementally. Resolve symbols and modules before lowering; type-check Views, arguments, bindings, models, callbacks and async results. Implement only the language subset committed in Phase 1. Diagnose unsupported constructs at their original source locations.

Use shared analysis for client compilation, SSR and editor diagnostics. Carry source ranges through lowering and generate usable source maps. Avoid separate implementations of language semantics for each renderer.

Introduce a typed foreign-module boundary for imported JavaScript libraries, including a clear policy for declarations, nullable values, promises, callbacks and exceptions. Ordinary Mun code should not need knowledge of generated JavaScript.

Exit criteria: the counter and async form compile through the shared path; invalid binding and async usage produce actionable Mun diagnostics; runtime failures map back to `.mun` source.

## Phase 3 Stabilize state identity and lifecycle

Define persistent state storage by View identity, including keyed collections and conditional branches. Track reactive dependencies, batch compatible updates, and ensure state changes update affected DOM without replacing unrelated input elements.

Implement observable models, derived values, bindings, environment propagation and deterministic cleanup. Define task start, cancellation, restart and stale-result handling. Preserve transaction and animation behavior across updates. Establish error propagation and recoverable application error boundaries.

Exit criteria: reordering keyed rows preserves row state and focus; editing text survives unrelated updates; removing a View cancels its tasks and subscriptions; an older async response cannot overwrite a newer request through the standard data API. Run these as focused behavior tests, including real browser checks for input and focus.

## Phase 4 Complete the web View and layout foundation

Provide Mun Views or semantic modifiers for headings, paragraphs, landmarks, links, lists, tables, forms, media, SVG and canvas. Render correct native elements wherever browser semantics matter. Keep accessibility roles, names, focus order and keyboard behavior part of each control's contract.

Add responsive layout, Grid, wrapping, intrinsic sizing, overflow, scrolling, sticky positioning and overlays. Define how numeric dimensions, relative units, modifier order and wrapper elements behave in the browser. Let browser layout handle these relationships whenever possible.

Design typed styles for themes, tokens, typography, responsive conditions, interaction states, pseudo-elements and reduced motion. Preserve stacking, clipping and hit-testing semantics when modifiers require wrappers. Provide a documented CSS integration boundary for specialized styling without making it necessary for ordinary screens.

Exit criteria: a responsive article page and a dashboard shell are authored entirely in Mun, with semantic HTML, keyboard access, selectable content and predictable layout across narrow and wide containers.

## Phase 5 Add complete application workflows

Provide typed routes, route parameters, query state, nested layouts, real links, redirects, not-found handling, browser history and scroll restoration. Navigation must support direct URL entry, reload, back/forward and opening links in a new tab.

Add task-based data loading with cancellation, caching, invalidation, loading/error states and mutation handling. Define request isolation and server-only boundaries so credentials and server implementations cannot enter client bundles. Keep backend integration transport-neutral.

Implement forms with native submission semantics, validation, field errors, file input, autofill and composition-aware input. Add document title, metadata, localization and bidirectional text support. Specify how authentication state participates in routing and data loading without committing the framework to an authentication provider.

Exit criteria: an account application supports direct links, async loading, validation, a mutation, recoverable failures and back/forward navigation using Mun application code.

## Phase 6 Unify server rendering and hydration

Build on existing server HTML and hydration code. Use the same analyzed Mun program and View semantics for static generation, request-time rendering and client rendering. Define deterministic identity, supported serialized values, escaping and URL handling, mismatch recovery and request-scoped state.

Specify when lifecycle work runs. Browser tasks start after client attachment; server loaders run within request scope. Prevent cross-request state leakage and duplicate server mutations during hydration. Preserve user input made before hydration completes.

Add streaming or selective hydration after the basic contract is reliable and an application demonstrates a benefit. Define deployment adapters only around concrete server-runtime requirements.

Exit criteria: the content and account applications render useful HTML before JavaScript starts, hydrate without losing input, isolate concurrent requests and produce matching production behavior after deployment.

## Phase 7 Finish browser integration and developer tools

Provide typed browser services for storage, files, clipboard, observers, workers and other platform features as needed by reference applications. Define representable-style integration for custom elements and imperative libraries, with create, update and dispose hooks. Expose element references at that boundary.

Complete state-preserving HMR, editor completion, formatting, diagnostics and runtime inspection. Make stable component identity and the conditions that reset state visible to developers. Package builds, assets, lazy modules and production errors should work through the normal Mun CLI workflow.

Exit criteria: a substantial external widget integrates with lifecycle cleanup; authors can find compilation and runtime errors in Mun source; production apps need no manual edits to generated output.

## Phase 8 Validate application coverage and release

Maintain three reference applications throughout implementation:

| Application | Required evidence |
| --- | --- |
| Content website | Semantic documents, responsive typography, navigation, metadata, static output and accessible links |
| Account application | State, forms, async loading, mutation errors, authentication integration and SSR |
| Data dashboard | Keyed updates, filtering, large collections, charts, responsive layout and external integration |

Each application uses Mun for application UI and behavior. Handwritten host code is limited to documented deployment and foreign-library boundaries. Publish those boundaries so gaps are visible.

Measure production bundle size, compilation time, update cost, memory growth, hydration behavior and HMR against the current implementation. Establish budgets from recorded baselines and supported workloads before claiming performance improvements. Run keyboard, screen-reader, IME, autofill and cross-browser validation on the workflows where those behaviors matter.

Exit criteria: all three applications build and deploy from clean scaffolds, meet the capability matrix's release requirements, and have no unexplained state loss, hydration failures or resource leaks in their acceptance scenarios.

## Delivery order and checkpoints

Phases 1 through 3 establish the language and runtime foundation. Phases 4 and 5 then add application capability in small complete slices. Phase 6 planning starts in Phase 1, and its basic server/client contract must be exercised in early slices rather than added after application APIs are fixed. Tooling work accompanies every phase; Phase 7 closes integration and production gaps.

The first implementation milestone is a counter followed by an async profile form, both authored entirely in `.mun`, compiled from shared semantic analysis and rendered through the existing web runtime. The form must demonstrate binding, validation, cancellation, failure recovery, stable input and a small server-rendered hydration case. This exercises the architecture before expanding the API catalog.

For each slice, commit a working checkpoint with its specification, implementation, focused regression coverage and capability-matrix update. Prefer a few tests that protect meaningful behavior; avoid broad compile-time matrices that only repeat API signatures. Keep the existing web path functional while migrating features, and retire duplicate lowering paths only after equivalent behavior is verified.

## Decisions to resolve during implementation

| Decision | Resolution point |
| --- | --- |
| Exact Swift-like subset and model semantics | Phase 1 specification |
| Reuse versus replacement of current parser and lowering steps | Phase 2, based on the first complete slice |
| Public spellings for web semantics and typed styling | Phase 4, tested in the content and dashboard apps |
| Route and data API package boundaries | Phase 5, after runtime ownership is established |
| Default deployment adapters and server runtimes | Phase 6, driven by reference app deployment |

The release target is a coherent language and dependable application workflows. SwiftUI API counts remain useful compatibility information, but completed web application behavior determines readiness.

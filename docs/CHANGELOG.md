# Changelog

## Next alpha

- Added the first renderer-neutral compiled template/slot IR. Proven intrinsic
  host structure is frozen once at module evaluation, dynamic children retain
  their original graph identity paths as slots, and React/Vue/Web DOM plus Web
  SSR materialize templates through cached renderer-native factories with a
  generic core fallback. Slot identity paths are indexed once at template
  definition, and intrinsic containers can stay templated even when an opaque
  custom View child remains dynamic.
- Added proof-driven compiler AOT optimization: `createNodeCompiled` bypasses
  runtime overload/label/type resolution for proven calls, Swift-style labeled
  arguments are normalized to runtime slots, simple ViewBuilder closures are
  elided, static modifier chains use compact compiled descriptors, and immutable
  View subtrees are hoisted to module scope.
- Added conservative compile-time State dependency metadata with an explicit
  completeness bit. React/Vue skip runtime read discovery only for compiler-
  proven closed bodies and automatically fall back when helpers, shared State,
  or opaque property access can hide reads.
- Expanded performance coverage with raw React/raw Vue client baselines for
  full, single-item, and keyed-reverse updates plus compiled-initializer timing;
  client ratio budgets are configurable CI regression guards.
- Added a pnpm 11-native local-development workflow for completely separate projects: `dev:link`, local scaffolding, workspace-file overrides, direct bundler plumbing links, watch mode, portable local tarballs, and `create-mun` release verification.
- Made the canonical `mun` package renderer-independent at install time: React and the React renderer are optional compatibility peers instead of mandatory dependencies; React, Vue, and Web source-linked consumers now all pass standalone Vite production builds.
- Removed stale local archives and `.pi`/AppleDouble metadata from source, switched every monorepo-internal dependency to `workspace:*`, and isolated legacy React regression tests under the explicit compatibility entry point.
- Hardened canonical Mün parsing/lowering against ordinary TypeScript methods, generators, generics, regex literals, multiline State, qualified View calls, statement-bearing ViewBuilders, and raw-HTML/entity edge cases.
- Made top-level State ownership binding-aware and scope-aware; shared/exported/mutable State remains module-scoped and emits `MUN_STATE_SCOPE` warnings in compiler and VS Code diagnostics.
- Unified concrete View identity and typed `ForEach` keys across React, Vue, and Web, including same-display-name remounts and lazy offscreen State preservation.
- Hardened the Web renderer's commit/ref lifecycle, native event aliases, boolean/ARIA attributes, SVG/XML namespaces, hydration prop reconciliation, and lazy State cleanup.
- Added context-aware source maps, cache-safe TypeScript specialization reuse, renderer parity/browser CI, the medium Showcase fixture, expanded performance workloads, and release-package verification.
- Aligned `Grid`/`LazyGrid` TypeScript overload order with runtime initializer indices, added minified production-bundle Chromium validation for all seven browser fixtures, and made DOM benchmark rounds sequential to remove cross-instance JSDOM scheduling noise.
- Replaced the State/Action Vite macro scanner with a TypeScript AST transform and source maps; generic State calls, lexical scopes, and function-valued actions are preserved.
- Added regression coverage for `examples/App.ts`, transparent Group fragments, shared mutable State ownership, required Component props, JSX modifier typing, JSDOM interaction, and presentation accessibility.
- Added Escape/focus handling for Sheet, a single alertdialog host for Alert, and keyboard/menuitem semantics for Menu.
- Added State owner reconciliation and cleanup for replacement, nested, shared, circular, and unsubscribed object graphs; split mixed macro declarations and added column-level source-map anchors plus diagnostics.
- Added unique Alert IDs, stacked-presentation hydration tests, expanded Menu keyboard behavior, repeated dynamic-dependency tests, fragment stress cases, and SSR hydration coverage.
- Unified experimental geometry naming around `CoordinateNode` and measured `LayoutNode`; expanded the modifier benchmark matrix and added a CI benchmark guard.
- Moved layout experiments, coordinate/observer infrastructure, plugin metadata, and the block-builder transform behind `@mun/ui/experimental`.
- Standardized repository commands on pnpm and added React 18/19 CI coverage plus an opt-in Playwright browser suite.

## 0.1.0

- Made arrays and plain objects stored in `State()` mutation-aware, including nested plain-object updates such as `items.value.push(...)` and `items.value[0].done = true`.
- Kept React elements, frozen values, class instances, `Map`, `Set`, and other special objects outside the mutable-container proxy path.
- Fixed `Spacer(minLength)` so an explicit minimum length is not lost to flex shrinking.
- Expanded React interoperability coverage for `memo`, `forwardRef`, `Raw(...)`, and directly-created React component elements inside Mün layout containers.
- Revalidated TypeScript build, runtime tests, macro transforms, and the React/Vite demo in CI.

## 1.0.0-alpha.3

- Switched Mün state subscriptions to React `useSyncExternalStore` semantics.
- Preserved top-level `State()` declaration order inside macro-generated per-view state factories so later state initializers can reference earlier state values.
- Added typed React props support to `view()` and allowed scoped state factories to initialize from props.
- Expanded runtime coverage for controls, collections, navigation, presentation, SSR portal safety, and state subscription behavior.
- Revalidated TypeScript build, runtime tests, macro transforms, and the React/Vite demo in CI.

## 1.0.0-alpha.2

- Replaced the Vue runtime with React and React DOM.
- Reimplemented Mün elements as React elements while preserving method-style modifiers.
- Reimplemented coordinate-free stack, grid, spacer, scroll, and shape primitives.
- Added React component layout hosts so normal React components remain first-class Mün layout items.
- Reworked `State`, `Action`, and `view` macros for per-component-instance React state.
- Ported controls: Image, Label, Link, ProgressView, Picker, Slider, and Stepper.
- Ported collections: List, Section, LazyVStack, LazyHStack, and LazyGrid.
- Ported navigation and presentation with React Context and React portals.
- Replaced the example app and CI with React/Vite coverage.

## 0.9.x and earlier

The 0.x line was Vue-based. Mün 1.0 intentionally changes renderer rather than maintaining a dual-runtime compatibility layer.

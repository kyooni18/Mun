# Mün API

The API is divided into a canonical semantic surface and explicit compatibility
surfaces.

## @mun/core

`@mun/core` is backend-neutral. It exposes:

- animation and transaction values;
- shared semantic initializer/call types;
- Mün Semantic UI IR types;
- compiler/runtime semantic metadata needed by native execution.

It does not expose HTML tags, DOM event types, CSS style objects, React
elements, or Vue VNodes as canonical APIs.

## @mun/compiler

`@mun/compiler` owns canonical `.mun` parsing, diagnostics, semantic
analysis, source maps, and Semantic UI IR compilation.

Primary entry points include:

```ts
compileMunFile(source, fileName)
compileMunUiProgram(source, options)
createMunSemanticModel(source, fileName)
diagnoseMunSource(source)
```

Canonical `.mun` input rejects raw HTML.

## Native runtime

The Rust crates under `native/` consume Semantic UI IR and implement native
windowing, layout, scene rendering, input, accessibility, state mutation, and
motion execution.

Use the repository commands:

```bash
pnpm native:build
pnpm native:run -- path/to/App.mun
```

## @mun/web

`@mun/web` is a secondary backend. Its IR entry point lowers
`MunUiProgram` into Web output. Its existing DOM/SSR/hydration APIs also
support the transitional View graph used by compatibility integrations.

HTML, CSS, and DOM behavior belong here rather than in the canonical language
or IR.

## @mun/astro

`@mun/astro` integrates standalone `.mun` source and embedded `@mun`
regions with Astro. The integration must route Mün source through the shared
compiler and semantic model before producing Web output.

## @mun/core/compat

`@mun/core/compat` is the explicit migration surface for the older TypeScript
View graph. React, Vue, and legacy Web renderers may depend on it.

Do not use this surface to define new core language semantics.

## @mun/react and @mun/vue

These packages are compatibility renderer adapters. They remain supported for
existing applications, but their host-framework concepts are not part of the
canonical Mün language.

## Root @mun/ui package

The root package exports the canonical `@mun/core` surface by default.
Renderer/framework adapters are opt-in subpaths or packages.

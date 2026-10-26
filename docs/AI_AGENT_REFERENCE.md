# Mün agent reference

Mün is a SwiftUI-like frontend language; `.mun` is primary for UI and behavior.
JavaScript is the compilation and integration target.

## Package boundaries

- `@mun/core` / `@mun/ui`: public View graphs, state, bindings, layout, modifiers,
  controls, identity, and animation. Keep the SwiftUI-like authoring model central.
- `@mun/core/compat`: supported alias for existing graph imports.
- `@mun/web`: primary DOM/HTML renderer, SSR and hydration; no React requirement.
- `@mun/compiler` / `@mun/vite`: the primary `.mun` compilation path to JavaScript.
- React, Vue, Astro: optional integrations, not the definition of a Mün View.
- `native/`: experimental Rust runtime and Semantic UI IR consumer. Native
  scaffolds require `--target native`; don't make Rust a web prerequisite.

JavaScript/TypeScript authoring must work without the custom syntax compiler.
Preserve View identity, reactive state, binding behavior, transaction precedence,
and animation semantics across renderers. Prefer focused regression tests and
standard browser execution over native-first expansion.

The historical web-first Vune commits `798c5a6`, `ac8447e`, and `965276f` provide
architectural context. See [architecture](./ARCHITECTURE.md) for current direction.

## Validation

```bash
pnpm build
pnpm test
pnpm demo:web:build
pnpm test:browser:web
```

Use native checks only for changes to the experimental native backend.

Start with [the language contract](LANGUAGE_REFERENCE.md), [capabilities](CAPABILITIES.md)
and [first milestone evidence](WEB_MILESTONE.md) for current implementation limits.

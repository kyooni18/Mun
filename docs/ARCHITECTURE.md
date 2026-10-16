# Mün architecture

Mün is a web-first, SwiftUI-inspired JavaScript frontend framework. The public
API centers on declarative Views, stacks, controls, state, bindings, modifiers,
identity, and animation. DOM/CSS rendering is the primary production direction.

```text
JS / TS builders -------------------------+
.mun -> @mun/compiler -> JavaScript -------+-> @mun/core -> @mun/web -> DOM / HTML
                                                      -> optional React / Vue / Astro
```

`@mun/core` and `@mun/ui` expose the same renderer-independent View authoring
API. `@mun/core/compat` is a supported alias for earlier renderer imports, not a
separate second-class authoring model. Renderers consume View graphs; core does
not depend on a renderer. `@mun/web` provides mounting, SSR, and hydration.
`@mun/vite` integrates optional `.mun` SwiftUI-like source compilation into a
standard Vite frontend. Plain JS/TS authors do not need a custom language.

This restores the web-first Vune direction visible in commits `798c5a6`,
`ac8447e`, and `965276f`, rather than reverting unrelated framework progress.

## Experimental native backend

Semantic UI IR exports and the Rust native runtime remain available for
experimentation. Native commands, packaging, and platform rendering are opt-in
via `--target native`; they must not become prerequisites for web authoring or
change the default scaffold. The historical design is preserved in
[NATIVE_ARCHITECTURE.md](./NATIVE_ARCHITECTURE.md).

Resident Compute Islands and native execution experiments are optional and do
not define the core SwiftUI-like frontend API.

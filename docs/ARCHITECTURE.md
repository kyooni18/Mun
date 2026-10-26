# Mün architecture

Mün is a SwiftUI-like frontend language for complete web applications. `.mun`
is the primary authoring format for UI and behavior. The public API centers on declarative Views, stacks, controls, state, bindings, modifiers,
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
`@mun/vite` compiles `.mun` modules for a standard Vite frontend. Direct JS/TS
builders remain supported for integration and existing consumers.

Both SSR and client compilation use `transformMunSource`: parsed source structs,
initializer/binding metadata and shared web validation feed the same lowered View
graph. Methods retain async/result annotations and original body ranges. Web
diagnostics follow that path; explicit native diagnostics retain the experimental
IR compiler. Core owns identity/state and `.task` lifetime; web owns native DOM
controls, reconciliation and hydration. No second server implementation of Mun
behavior is introduced.

The first slice is [a counter and async form](WEB_MILESTONE.md). Its host only
serves HTML/HTTP and attaches the compiled graph. See [the language contract](LANGUAGE_REFERENCE.md)
and [capabilities](CAPABILITIES.md) for limits, including incomplete type checking,
foreign boundaries and SSR serialization.

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

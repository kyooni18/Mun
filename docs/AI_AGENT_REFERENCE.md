# Mün agent reference

Mün is a native-first standalone UI language and runtime.

## Architectural invariant

Always preserve this dependency direction:

```text
.mun
  -> @mun/compiler
  -> Mün Semantic UI IR
     -> native runtime/backend
     -> secondary Web/Astro lowering
```

Astro, React, Vue, DOM, HTML, and CSS must not define the canonical language or
Semantic UI IR.

## Canonical source

`.mun` is the canonical file format. Compatibility host files may continue to
exist during migration, but new language examples, tests, and native features
should use `.mun`.

Canonical `.mun` rejects raw HTML.

## Core boundary

`@mun/core` contains backend-neutral semantics, motion values, and Semantic UI
IR.

The old TypeScript View graph is isolated behind `@mun/core/compat`. Existing
React/Vue/Web compatibility code may import it. New native language work should
not.

## Native-first implementation order

For a new UI feature:

1. define the semantic behavior;
2. add parser/compiler support;
3. extend Semantic UI IR if needed;
4. implement native runtime/backend support;
5. add Web/Astro lowering only when useful.

Do not add DOM/CSS fields to core IR to make the Web backend easier.

## Motion

Reuse the existing renderer-neutral animation/runtime assets. Preserve
transaction precedence, property-local animation overrides, delay, repeats,
autoreverse behavior, spring retarget velocity, timing curves, and timeline
mapping.

Do not create a second native animation model.

## Important directories

`packages/core`: canonical semantics/IR plus explicit `compat` migration
surface.

`packages/compiler`: parser, semantic analysis, diagnostics, source lowering,
and Semantic UI IR compilation.

`native/`: native runtime and desktop backend.

`packages/web`: secondary DOM/HTML/CSS backend.

`packages/astro`: secondary Astro integration.

`packages/react`, `packages/vue`: compatibility renderers.

`examples/NativeDemo.mun`: canonical end-to-end native fixture.

## Validation

Prefer the closest checks first:

```bash
pnpm --filter @mun/core run check
pnpm --filter @mun/compiler run check
node --test tests/native-ui-ir.test.mjs tests/web-ui-ir.test.mjs
pnpm native:build
```

Run broader workspace tests after structural changes.

## Migration rule

Do not delete mature animation/runtime behavior merely because its current
implementation sits in a compatibility path. Reuse or port the behavior behind
the semantic/native boundary.

Conversely, do not preserve a browser concept in `@mun/core` just because a
legacy renderer needs it. Put such dependencies behind `@mun/core/compat` or
the relevant backend.

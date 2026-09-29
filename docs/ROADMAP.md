# Mün roadmap

Mün is moving to a native-first architecture with canonical `.mun` source and
a shared Semantic UI IR.

## Architecture target

```text
.mun
  -> compiler
  -> Semantic UI IR
     -> native runtime/backend
        -> macOS / Windows / Linux
     -> Web/Astro backend
```

## Current priority

The primary goal is a complete native desktop UI stack: language semantics,
semantic IR, layout, rendering, input, accessibility, state, animation,
presentation, and platform backends.

The existing compiler, animation engine, state/runtime work, and performance
assets should be reused rather than replaced when their semantics are
backend-neutral.

## Core cleanup

Keep `@mun/core` backend-neutral. Browser-oriented graph APIs remain isolated
behind `@mun/core/compat` until React/Vue/Web compatibility paths can lower
from Semantic UI IR directly.

Do not add new HTML/DOM/CSS contracts to canonical core.

## Compiler

Expand `compileMunUiProgram` from the current vertical slice to cover the full
canonical View surface, richer expressions, collections, input, presentation,
accessibility, and layout while keeping `.mun` the canonical source format.

## Native runtime

Continue the native runtime toward:

- complete layout semantics;
- retained scene rendering;
- pointer/keyboard/focus input;
- accessibility trees;
- state-driven incremental updates;
- full motion/timeline behavior;
- native controls and presentation;
- macOS, Windows, and Linux backends.

## Motion

Preserve the existing renderer-neutral motion model and port missing execution
capabilities instead of designing a separate native animation system.

## Web and Astro

Maintain `packages/web` and `packages/astro` as secondary consumers of the
same compiler/IR. Browser representation is allowed inside those backends, not
inside canonical language semantics.

## Compatibility renderers

React and Vue remain useful integration targets, but new language design should
not be constrained by their component or DOM models.

## Completion criterion

Mün is native-first when a representative desktop application can be authored
as standalone `.mun`, compiled to Semantic UI IR, and run on supported desktop
platforms without any browser runtime, while Web/Astro continue to consume the
same source/compiler model as secondary targets.

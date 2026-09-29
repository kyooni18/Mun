# Mün design

Mün is a native-first standalone UI language and runtime. The canonical source
format is `.mun`. The compiler parses Mün source and lowers it into Mün Semantic
UI IR before any backend-specific representation is chosen.

The dependency direction is:

```text
.mun
  -> @mun/compiler
  -> Mün Semantic UI IR
     -> native runtime/backend
        -> macOS
        -> Windows
        -> Linux
     -> secondary Web/Astro backends
```

The semantic IR is the architecture boundary. Native and Web consume the same
program model; Web does not define the language model.

## Canonical language model

Mün owns component composition, layout intent, state, actions, input semantics,
accessibility semantics, animation intent, and rendering semantics. Canonical
Mün has no DOM nodes, HTML tags, CSS properties, WebView, or Chromium concepts.

A `.mun` file expresses Views such as `Text`, `VStack`, `HStack`,
`Button`, and shape Views. The compiler resolves those constructs and emits
backend-neutral nodes such as windows, rows, columns, text, actions, panels,
state expressions, layout metadata, accessibility metadata, and motion
bindings.

Raw HTML is rejected in canonical `.mun` source.

## Semantic UI IR

`@mun/core` is the canonical backend-neutral surface. Its public contract is
language semantics, motion values, and Semantic UI IR. The IR does not contain
HTML tag names, DOM event objects, CSS declarations, React elements, or Vue
VNodes.

The initial IR is intentionally compact. It represents the semantics needed by
the current native vertical slice while preserving room for richer layout,
input, accessibility, presentation, and rendering capabilities without making
a browser representation normative.

Accessibility is stored separately from visual representation. A native backend
can build a platform accessibility tree while the Web backend can lower the
same semantics to accessible markup.

## Native runtime

The native path is primary. It consumes Semantic UI IR directly and owns window
creation, layout execution, input routing, state updates, animation scheduling,
scene construction, and platform presentation.

Native Mün must not route through HTML, CSS, DOM, WebView, or Chromium.

The current native runtime reuses the existing renderer-neutral animation and
runtime work rather than replacing it. Spring/timing plans, transactions,
retargeting behavior, repetition, and timeline semantics are lowered from the
same core motion model into native execution.

## Web and Astro

`packages/web` is a secondary backend. HTML, CSS, DOM nodes, hydration, browser
events, and browser layout APIs are introduced only after semantic compilation
or inside the explicit compatibility renderer path.

Astro is also a consumer. Standalone `.mun` and embedded `@mun { ... }`
regions must pass through the same Mün parser/compiler and semantic model before
the Astro/Web lowering runs. Astro must not introduce a second HTML-oriented Mün
language.

Host HTML remains host HTML. It does not become part of canonical Mün syntax.

## Compatibility graph

The repository still contains the mature TypeScript View graph inherited from
the earlier Web-first implementation. It remains valuable for the React, Vue,
Web, and migration surfaces while they move toward direct Semantic UI IR
consumption.

That graph is explicitly isolated behind `@mun/core/compat`. It is not the
canonical `@mun/core` contract and must not be used to define new language
semantics.

Compatibility renderers may keep their existing DOM-oriented implementation,
but new native features should be expressed first in the canonical semantic
model and IR.

## State and actions

State belongs to Mün, not to a renderer. Canonical compilation records state
declarations and state expressions in the semantic program. Actions lower into
semantic mutations and transactions that native or Web execution can apply.

Renderer-specific state bridges may exist for React/Vue compatibility, but
those bridges are adapters and do not alter Mün state semantics.

## Animation

Animation intent is renderer-neutral. Property motion bindings refer to semantic
properties such as opacity, translation, scale, rotation, dimensions, spacing,
and colors. The compiler lowers `Animation`, `Transaction`,
`withAnimation`, and property-local animation modifiers into execution plans.

Backends decide how to realize those plans, but they must preserve the same
semantic transaction and retargeting behavior.

## Direction for new work

New language features should follow this order:

```text
syntax
  -> compiler semantic analysis
  -> Semantic UI IR
  -> native runtime/backend
  -> optional secondary Web/Astro lowering
```

A feature that can only be described in DOM/CSS terms is a Web-backend feature,
not a Mün core feature.

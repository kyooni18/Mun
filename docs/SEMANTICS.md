# Mün semantics

This document describes canonical Mün semantics. The canonical source format is
`.mun`, and the canonical compiler result is Mün Semantic UI IR.

## Source model

A Mün module may declare state, Views, stored fields, initializers, actions, and
ordinary expressions supported by the compiler. View-builder blocks compose
semantic Views such as `Text`, `VStack`, `HStack`, `Button`, and shapes.

Raw HTML is not part of canonical `.mun` syntax. Browser markup belongs to a
host framework or to the secondary Web compatibility layer.

## View composition

A View describes semantic UI structure rather than a platform object. Builder
branches and collections compose child Views. Custom `struct ...: View`
declarations lower through the same compiler as built-in Views.

The compiler resolves initializer labels, stored fields, state/binding roles,
and builder closures before lowering to Semantic UI IR.

## Semantic UI IR

The IR is backend-neutral. Current programs contain state declarations and a
semantic tree with window, row, column, conditional, text, panel, and action
nodes. Nodes may carry layout, visual, accessibility, and motion metadata.

The IR never uses DOM nodes, HTML tag names, CSS declarations, React elements,
or Vue VNodes as its semantic representation.

## State

`State` is a Mün language/runtime concept. State reads become semantic
expressions and supported actions become semantic state mutations.

Backends execute the same state model. React/Vue state bridges are compatibility
adapters, not alternate Mün semantics.

## Layout

Layout is expressed as relationships and constraints: stacks, spacing,
alignment, padding, frame dimensions, and related semantic modifiers. Backends
implement those relationships in their own layout systems.

Canonical numeric dimensions are semantic UI dimensions, not CSS pixels.

## Visual properties

Visual modifiers such as background, foreground, corner radius, and opacity
lower to semantic visual/motion properties. Backend-specific representation is
chosen only after semantic compilation.

## Accessibility

Accessibility metadata is independent of visual representation. Native
backends can construct platform accessibility trees while the Web backend can
lower the same semantics to accessible markup.

## Motion and transactions

Animation descriptors and transactions are renderer-neutral. The compiler
records semantic property motion, triggers, and execution plans. Native and Web
backends preserve the same transaction, delay, repeat, autoreverse, and
retargeting rules.

## Compatibility graph

The mature TypeScript View graph used by existing React/Vue/Web integrations is
available through `@mun/core/compat`. It may contain host-element and
browser-oriented compatibility concepts.

That graph is not the canonical language model. New language semantics should
be added to Semantic UI IR first, then lowered by native and optional secondary
backends.

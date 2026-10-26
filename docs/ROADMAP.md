# Mün roadmap

The proposed [Mun language and web implementation plan](./LANGUAGE_AND_WEB_PLAN.md)
sets out the next direction: primary `.mun` authoring with SwiftUI-like language
semantics and complete web application capabilities. The sections below describe
the existing implementation baseline during that migration.

## Primary: SwiftUI-inspired web frontend

- Keep View composition, stacks, controls, state, bindings, identity, modifiers,
  and animation as the central Mun composition model.
- Make `.mun` primary through Vite; retain JS/TS integration builders.
- Prioritize DOM rendering correctness, accessibility, SSR/hydration, reactive
  updates, browser testing, bundle size, and frontend developer experience.
- Keep React, Vue, and Astro integrations optional.
- Preserve the web-first architecture established by Vune without reverting
  unrelated progress.

## Experimental

Native runtime, Semantic UI IR compilation, native packaging and hot reload,
and Resident Compute Islands remain research areas. They must not displace web
workflows or introduce native toolchain requirements for ordinary frontend apps.
See [native architecture](./NATIVE_ARCHITECTURE.md) for the retained design.

The [first milestone](WEB_MILESTONE.md) implements the counter/profile slice.
[Capability status](CAPABILITIES.md) records the remaining language/application gaps.
This does not complete the full plan or all of Phases 1–3.

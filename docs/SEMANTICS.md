# Mun semantics

The current web language contract is [Language reference](LANGUAGE_REFERENCE.md).
Mun applications use `.mun` for UI and behavior, with Views, state, bindings,
identity, lifecycle tasks and ordered modifiers. The compiler lowers that source
to the existing core View graph; DOM, SSR and hydration share those semantics.

The [first web milestone](WEB_MILESTONE.md) exercises a counter and async profile
form. [Capabilities](CAPABILITIES.md) records tested behavior and remaining gaps.
The [implementation plan](LANGUAGE_AND_WEB_PLAN.md) describes subsequent work.

Semantic UI IR and the Rust runtime remain experimental native consumers. Their
historical source contract is retained in [native architecture](NATIVE_ARCHITECTURE.md)
and [the historical book](MUN_BOOK.md); they do not restrict web language features.

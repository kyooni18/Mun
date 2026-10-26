# Language and web capabilities

Statuses: **verified** means exercised by a named check; **partial** means a
usable subset with stated limits; **missing** means planned without an implemented
contract; **experimental** means an opt-in surface outside the web release contract.
Proposed APIs in [the plan](LANGUAGE_AND_WEB_PLAN.md) are not available merely
because they appear there.

| Capability | Status | Evidence and boundary |
| --- | --- | --- |
| `.mun` counter, View methods, `@State`, `$` and `@Binding` | verified | `tests/language-web.test.mjs`; `examples/language-web` |
| Native form submit, empty-field validation, async save and retry | verified | Compiled integration and Chromium tests; validation and behavior live in `.mun` |
| `.task(id:)` abort on restart/removal; stale result suppression | verified | Profile test deliberately uses a transport that ignores abort; application checks signal and request revision |
| Focus, selection and stable input across unrelated updates | verified | Compiled profile integration test and real Chromium check (`test:browser:language-web`) |
| SSR and hydration through one compiled View graph | verified | Compiled profile hydration test; no server lifecycle requests, early text edit adopted into binding, fresh state per render/mount; Chromium tests SSR without JS and delayed attachment |
| Method source ranges, binding roles and async diagnostics | partial | Original AST ranges and source maps tested; web compiler checks syntax, method await boundaries and known member binding roles. Full module/type/async-result checking remains open |
| Web editor diagnostics | partial | Compiler and LSP web-module diagnostics tested. Web modules use web lowering; `@main` compilation units retain explicit native diagnostics. Completion/hover still use the older native catalog |
| General task/data API | missing | No standard cache, invalidation or mutation API. `.task` supplies lifetime; stale checks and HTTP result validation are application responsibilities |
| Typed foreign-library and HTTP boundary | missing | Profile uses platform `fetch`, `JSON` and promises directly in `.mun`; no typed response decoder or server-only loader boundary yet |
| Arbitrary state serialization and SSR loaders | missing | This slice renders deterministic default state per request; no payload serialization, streaming or server mutation |
| Forms, IME, autofill and accessibility coverage | partial | Native form/submit/input with accessible name and live status. Validation is application code; IME, autofill, field-error framework and screen-reader testing remain |
| General builder/module/model language | partial | Existing builder branches/loops, observable classes and ES modules retained; not a full Swift implementation or complete type checker |
| Native Semantic UI IR, Rust and resident compute | experimental | Explicit native APIs/commands retained independently of the web language path |

This is the first vertical slice, not completion of Phases 1–8. See
[acceptance criteria and evidence](WEB_MILESTONE.md).

Reproduce the first slice with `pnpm demo:language-web` and
`pnpm test:browser:language-web`. `pnpm demo:language-web:build` builds the production
client bundle; the example SSR server is a development host, not a production
server adapter. Chromium is the real-browser acceptance target for this milestone;
Firefox, WebKit, IME, autofill and assistive-technology checks remain open.

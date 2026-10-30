# Mun web language: first milestone contract

Mun is a SwiftUI-like frontend language. `.mun` contains application UI and
behavior; JavaScript is the compilation and foreign-library target. This document
specifies the **implemented web subset**, not Swift source or ABI compatibility.
[Capabilities](CAPABILITIES.md) distinguishes tested behavior from proposals.

## Modules, declarations and values

A web module uses ES-style `import` and `export`. `export default App()` exports
a View description. Built-in Views, value types and language functions resolve
without imports through the compiler's built-in registry, with lexical shadowing and
a located error for unknown names ([details](BUILTINS_AND_OPT_IN.md)); explicit
imports remain supported. Relative `.mun` imports are compiled by Vite
for both SSR and the browser. A module may define `struct Name: View` with stored
fields, initializers, `var body: some View`, computed properties and `func` members.
`@main` remains the entry convention for the experimental native compiler.

Mun owns View composition, wrapper projections and instance identity. Ordinary
method expressions currently use the existing JavaScript/TypeScript expression
subset: property access, calls, objects, arrays, arithmetic, comparisons, optional
chaining and `null`/`undefined`. `String`, `Int`, `Double` and `Bool` field metadata
are accepted; numbers execute as JavaScript numbers (IEEE-754 double precision),
not Swift fixed-width integers. There is no overflow-checking integer contract.
Use `===`/`!==` for strict equality. Existing `==` retains JavaScript coercion;
Swift's identity meaning for `===` does not apply.

Objects, arrays and model instances have reference semantics. State observes
supported object/array mutations; assigning a struct View does not copy a model
as a Swift value. Local `let` currently retains JavaScript's block-scoped mutable
behavior; `const` is also accepted. Swift local immutability and full value-copy
semantics have not been implemented. Existing JS/TS-compatible sources are kept
working rather than silently changing these meanings.

Type inference covers known View initializers, binding roles and a subset of
literal/declared types. It is not a complete module or async-result type checker.
Web optional values currently use `null`, `undefined` and `?.`; native optional
syntax (`T?`, `nil`, optional patterns) is not a promised web contract. Swift enum,
protocol, generic constraint and pattern-matching coverage remains incomplete.

## Functions, closures, control flow and errors

A member method is `func name(parameters) [async] [-> resultType] { statements }`.
Method argument labels are lowered to positional calls. Return annotations are
retained (`async -> T` lowers to `Promise<T>`). Untyped parameters remain allowed
at the current foreign boundary. Swift `throws`, `try?` and `try!` are unsupported;
method effects other than `async` receive a source-oriented diagnostic.

Use `return`, `if (condition) { ... }`, ordinary `for`/`while`, arrays and objects
in methods. `throw new Error(...)` and `try { ... } catch (error) { ... }` are the
current recoverable error syntax. These statements are authored in `.mun` and
are not companion application code. An `await` in an ordinary method requires
`async`; awaiting outside an async function is diagnosed before output runs.
Nested functions obey their own async boundary.

Trailing builder closures use `{ item in ... }`; action closures use
`Button("Increase") { count += 1 }`. Expression callbacks such as
`event => { event.preventDefault(); begin() }` are supported at the web API
boundary. Existing closure lowering infers async action/lifecycle closures when
they contain `await`; methods require the explicit effect. A body returns Views,
not a promise. Await work in a `.task` or action rather than during composition.

## Composition and data flow

Builders compose children in source order. Existing `if` branches and collection
builders (`ForEach`, with explicit stable identity for reorderable items) remain
available. Stateful child Views persist by structural/key identity; removing and
reintroducing a View creates fresh state. A different branch or key can change
identity. `.id` and collection keys must be stable and unique.

`@State var name = ""` belongs to a rendered View instance. Read/write `name` as a
plain value inside the View; `$name` projects a writable binding. A child declares
`@Binding var name: String` and receives `NameField(name: $name)`. Bare `name` is a
value and is invalid where a known binding parameter is required.
`TextField("Display name", text: $name)` binds a native text input and provides its
accessible name. `Element("form", { onSubmit: ... }) { ... }` composes semantic web
elements without raw HTML. Validation in this milestone is application code.

Computed properties are evaluated during composition. `@Observable` classes and
`@Environment` remain existing runtime facilities, not a promise of all Swift
Observation semantics. A model can be explicitly shared through props/environment;
instance State should not be exported as mutable module-wide storage.

Modifiers apply in authored order. Layout-neutral modifiers may merge props;
modifiers requiring distinct layout/painting semantics can introduce wrappers.
Changing state patches compatible DOM nodes so unrelated controls retain focus,
text and selection. See [styling](STYLING.md) for the current web representation.

## Task lifetime and web execution

`.task(id: request) { signal in await save(signal) }` starts after client attachment,
restarts when `id` changes and aborts the previous signal on restart or removal.
Pass the signal to `fetch`. Cancellation is cooperative: code must inspect
`signal.aborted` and a request revision before publishing results if its transport
can ignore abort. See the [profile source](../examples/language-web/Profile.mun)
for validation, pending state, cancellation, HTTP/network errors and retry.
There is no standard cached data/mutation API yet. Unhandled task failures are
reported; application `try/catch` provides recovery in this slice.

SSR and client rendering execute **the same lowered core View graph**, without
a second server language implementation. SSR creates fresh instance state and
does not run lifecycle refs/tasks. Keep composition and module initialization
free of browser effects. Browser work belongs in client actions/tasks. Host
JavaScript is limited to deployment, attachment and foreign integration.

The example renders default state to useful HTML, then calls `mount(...,
{ hydrate: true })`. Matching text inputs edited before attachment retain their
node, focus, selection and value; hydration feeds the edit through their input
handler to synchronize State. No submission runs merely because hydration occurs.
This does not yet specify arbitrary serialized state, server loaders, secrets,
streaming, mismatched-tree early-input preservation, checkboxes or select edits.

## Diagnostics, compatibility and migration

Web compilation, SSR and web diagnostics share parser/lowering validation.
The parsed AST retains method and body ranges. Source maps retain original Mun
source/tokens; they are token-aligned maps, not a full statement-level debug IR.
Full runtime error fidelity and typed imported-module checking remain gaps.
`diagnoseMunSource(source, file, { target: "native" })` explicitly retains native
IR diagnostics; the LSP recognizes the legacy `@main` native compilation unit.
Web editor completion/hover still need migration from the native API catalog.

Existing `.mun`, `.mun.ts`, direct JS/TS builders and `@mun-ui/core/compat` imports
remain supported. This milestone fixes lost binding metadata and adds web control
support; it does not remove native APIs or require rewriting existing consumers.
New documentation and scaffolds use `.mun` and instance `@State` first. Native-only
syntax need not compile for web; choose the explicit native toolchain for those
sources. Proposed language and web APIs stay in the plan until implemented and
verified. Changes to existing expression semantics need an explicit future
migration policy rather than implicit Swift compatibility assumptions.

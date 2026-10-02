# SwiftUI API parity

Mün's canonical authoring surface follows SwiftUI: when an API exists in Mün,
a call uses SwiftUI's public name, argument labels, argument order, defaults,
overload shape and closure roles. The pipeline is unchanged by this goal:

```text
.mun source → Mün parser/compiler → Semantic UI IR → mun-runtime → native renderer
```

Native is the primary target. Web, React and Vue are compatibility backends:
their limitations are recorded separately and never downgrade a native claim.

The generated [parity report](SWIFTUI_PARITY_REPORT.md) lists every claimed
overload, its terms, and every deliberately unsupported API.

## Vocabulary

Each overload carries three independent facts.

**Source contract** — does Mün accept SwiftUI's spelling?

- *source-contract parity*: the SDK title with every label, order, default and
  closure role, accepting the same argument families.
- *source-contract subset*: the SDK title, but narrower arguments (for example
  a string literal where SwiftUI takes `LocalizedStringKey`). The manifest says
  exactly what is left out, and anything outside the subset is a compile-time
  diagnostic, never a runtime failure.

**Native semantics** — what does the native runtime do with it?

- *native semantic parity*: observable behavior matches SwiftUI on macOS
  (layout, state, accessibility, input) within the documented global
  divergences.
- *deliberate divergence*: implemented on purpose with a documented
  difference (for example, `Picker` always uses the radio-group style).
- *compatibility-only*: no native implementation. The API exists only for the
  legacy graph (`.mun.ts`, React, Vue, DOM), and canonical `.mun` rejects it.

**Web** — *web parity*, *web approximation* (browser semantics stand in), or
*web unsupported*.

Global divergences apply everywhere and are listed once in the report:
`localization` (titles are plain Strings), `appearance` (fixed dark palette),
`defaultMetrics` (stack spacing 8, padding 16, Spacer 8) and `typography`.

## Source of truth

The contract has three parts, and checks keep them consistent:

| Part | Where | What it holds |
| --- | --- | --- |
| SDK snapshot | `api/swiftui-symbols.snapshot.json` | Public SwiftUI + SwiftUICore declarations from the installed Xcode SDK |
| Parity manifest | `packages/core/src/api-manifest.ts` (`@mun/core/swiftui-manifest`) | Claimed overloads, their parameters and the three facts above; Mün extensions; compatibility-only spellings; unsupported APIs |
| Native lowering | `nativeViews`, `nativeModifiers` and the value tables in `packages/compiler/src` | One implementation per claimed native signature |

The manifest is not a runtime API. It lives on its own subpath, so canonical
`@mun/core` exports stay backend-neutral.

### The SDK snapshot

The snapshot is generated, never written from memory:

```sh
pnpm snapshot:swiftui
```

This runs `swift-symbolgraph-extract` for SwiftUI and SwiftUICore against the
selected Xcode's macOS SDK, with the target pinned to the SDK version. Its
header records:

- Xcode version and build;
- SDK name, version and build;
- target and modules;
- the full public symbol count and digest;
- the digest of the stored entries.

The stored entries are a deterministic reference subset, one sorted entry per
line: nominal types, initializers, static members, and members of `View`,
`Shape`, `Text`, `Image`, `Color`, `Animation` and `AnyTransition`, each with
its declaration and macOS availability. Two runs on the same Xcode produce
byte-identical files. `--full-output <path>` writes the complete extraction
for investigation.

Regenerate it only when the project moves to a new reference SDK, and commit
it with the manifest changes that the new SDK requires. Ordinary builds and
tests never regenerate it.

### Checks

`pnpm test:parity` runs as part of `pnpm test` and CI. It runs three steps:

1. `pnpm check:swiftui-manifest` compares every native claim with the
   compiler's lowering tables, in both directions, so no claim lacks an
   implementation and no implementation is unclaimed. It also:
   - compiles each compatibility-only spelling and expects a
     "compatibility-only" diagnostic;
   - checks that unsupported APIs are not also claimed;
   - checks the legacy graph's mapping.
2. `pnpm check:swiftui-snapshot` verifies each SDK-shaped claim against the
   snapshot:
   - the type exists, and the exact title exists;
   - labels and order, SDK defaults versus optional parameters, Binding
     parameters, and closure parameters all match;
   - the API is available on macOS;
   - SDK deprecation is acknowledged in the manifest;
   - every "unsupported" entry is real macOS SwiftUI API.

   A hand-edited snapshot fails its digest.
3. `node scripts/swiftui-parity-report.mjs --check` fails when the generated
   report is stale. Regenerate it with `pnpm report:swiftui-parity`.

The report deliberately has no coverage percentage. SwiftUI's surface is open
ended, so counts of claimed and listed-unsupported APIs are reported instead.

## Diagnostics

A canonical call resolves against the manifest's overloads for that name. A
call that fits none of them is a compile error naming the closest overload and
the reason, followed by `Mün supports: …` and every valid signature:

| Problem | Example message |
| --- | --- |
| Unknown or wrong label | `it has no argument label 'value:' (labels: isOn:)` |
| Order | `argument 'maxWidth:' must come before 'minHeight:'`, `the unlabeled argument must come before 'isOn:'` |
| Missing or extra argument | `it requires 'text:'`, `it has too many arguments` |
| Missing label | `argument 1 needs the label 'minLength:'` |
| Value for a Binding | `A Binding is required, but 'on' is a value — pass $on` |
| Binding for a value | `'value:' takes a value, not a Binding — remove the $` |
| Closure role | `'perform:' requires a closure`, `it does not take a trailing closure` |
| Argument type | `'value:' expects Double, received String` |
| Known SwiftUI overload Mün lacks | `Toggle(_:systemImage:isOn:) is a SwiftUI initializer that Mün does not implement` |
| Unimplemented parameter | `.frame(idealWidth:) is not implemented in native Mün …` |
| Compatibility-only API in `.mun` | `… is compatibility-only …`, with the canonical replacement |
| Unknown SwiftUI View/modifier | the unsupported reason from the manifest |

## The Mün language boundary

Canonical `.mun` is Swift-derived. The table classifies every construct.

| Construct | Status |
| --- | --- |
| `struct Name: View { var body: some View { … } }`, `@main` | Swift-derived (canonical entry) |
| `@State var`, `@Binding var`, `let`, `var`, inferred types from literals | Swift-derived |
| `private` / `fileprivate` members | Swift-derived; see below |
| `String`, `Int`, `Double`, `Bool`, `[T]`, `[K: V]`, `T?`, `nil`, `[:]` | Swift-derived (canonical types) |
| `if` / `else if` / `else`, ternary, `switch` with literal cases | Swift-derived |
| String interpolation `"\(value)"`, `$state`, `.toggle()` | Swift-derived |
| Trailing closures on Views and modifiers, implicit member expressions (`.leading`) | Swift-derived |
| `Window(_:width:height:content:)`, `Color("#RRGGBB")` | Intentional Mün extensions |
| Record literals `{ id: "a", title: "A" }` and keyed collection actions (`tasks.move(id, by: 1)`) | Intentional Mün syntax (Mün has no value structs yet) |
| `export default App()` | TS/JS compatibility syntax (prefer `@main`) |
| Top-level `const flag = State(false)` with `flag.value` | TS/JS compatibility syntax (prefer `@State`) |
| `string`, `number`, `boolean`, `T[]`, `Array<T>`, `Record<K, V>`, `T \| null` | TS compatibility spellings: a diagnostic in canonical `.mun`, accepted by the legacy `.mun.ts`/React/Vue pipelines |
| `.mun.ts` files, `@mun/core/compat` | Legacy compatibility; never needed for canonical `.mun` |

Rules with defined meanings:

- **Types.** Both spellings normalize to one internal type. A declared
  `@State` type is checked against its initial value (`Int` requires an
  integer), and a `@Binding` against the state passed to it. Arithmetic on
  `Int` uses Double semantics (no integer division); this is a deliberate
  divergence.
- **`private`/`fileprivate`.** The member is internal to its View. It is not a
  memberwise-initializer parameter, so it needs a default value. Passing it
  from a caller is diagnosed, and it cannot be a `@Binding`.

  Swift would make the memberwise initializer file-private instead. Mün's
  stricter rule has the same effect for single-file Views.
- **`@State` ownership.** `@State` is View-owned identity storage, and it is
  never a memberwise parameter. A caller that needs to drive a value passes a
  `@Binding`. Swift lets a caller seed the initial value; Mün deliberately
  doesn't.
- **`switch`.**
  - The subject is a scalar, and cases are String, number or Bool literals or
    comma lists of them. Cases are lowered as equality conditions.
  - The switch must be exhaustive: a `default:`, or both `true` and `false`.
  - Ranges, `where`, `fallthrough`, repeated cases and empty cases are
    diagnosed.
- **Entry.** `@main` selects the entry View. `export default` is accepted, but
  naming a different View from `@main` is an error.

## Subsystems

| Subsystem | Status |
| --- | --- |
| Lifecycle: `onAppear(perform:)`, `onDisappear(perform:)` | Native. Actions run when a View starts or stops being semantically present: an active branch, a live collection item, or a new `.id(_:)` identity. Each runs once per change, never per frame. Disappearances run before appearances. A bounded fixpoint stops cascades and reports a diagnostic. |
| Environment | Lexical only: `foregroundStyle` and `disabled` propagate to descendants. There is no general `EnvironmentValues`/`@Environment` yet. |
| `.task`, navigation, presentation (sheet/alert), toolbars, gestures, PreferenceKey | Not implemented and listed as unsupported. They will be designed in the IR first: navigation before toolbars, and PreferenceKey only when a concrete View needs it. |
| Styles | Only `.pickerStyle(.radioGroup)`. No protocol-level `ButtonStyle`/`ToggleStyle` claims. |

## Native modifier semantics

Modifier order is observable, as in SwiftUI. Mün's native box model has stages
in this order:

1. padding
2. frame
3. background
4. cornerRadius
5. opacity and offset

A modifier written after a later stage wraps the View in a layer. So
`.padding().background(c)` paints the padding and `.background(c).padding()`
does not.

`foregroundStyle` and `disabled` propagate lexically to descendants. Shapes,
`Color`, `ScrollView`, `Spacer` and `ProgressView` take the space they are
offered, and `TextField` takes the offered width. The window centers its root
View and fills only the axes on which the root is flexible.

## Expansion order

To promote another SwiftUI API:

1. Find its declaration in the snapshot. Copy the title and every parameter;
   don't reconstruct them from memory.
2. Add the overload to the manifest with its three facts. A parameter that
   isn't implemented stays in the parameter list and is rejected by lowering
   with a diagnostic.
3. Implement it in the runtime/IR, and add the native lowering keyed by the
   signature.
4. Add a compiled-source example or contract test and negative diagnostics.
5. Run `pnpm test:parity`, `pnpm report:swiftui-parity`, the cargo workspace
   tests and `node scripts/verify-native-contracts.mjs`.

## Compatibility backends and animation

The legacy View graph (`@mun/core/compat`) serves `.mun.ts`, React, Vue and the
DOM renderer. Its modifiers are listed in the report as compatibility-only, and
Mün-only legacy modifiers are listed too: `margin`, `gap`, `className`,
`withProps`, a parameterless `.animation()` and others.

For these backends, `Animation`, `Transaction`, `withAnimation` and
`withTransaction` live in core. A state write snapshots the active transaction,
so asynchronous renderer updates keep the animation chosen at mutation time.
The DOM renderer interpolates numeric, color and transform values with
`@mun/animation`, retargeting live springs. React and Vue use a style-transition
fallback. These are web approximations. Native motion is implemented in
`mun-runtime` from the Semantic UI IR's motion plans.

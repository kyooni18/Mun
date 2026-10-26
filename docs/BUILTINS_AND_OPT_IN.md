# Built-ins and opt-in features

Mün's public API has two tiers. Both ship in the one `@mun/ui` install.

| Tier | How you get it | Resolved by |
| --- | --- | --- |
| **Built-in** | Write the name in a `.mun` file. No import. | The compiler, statically |
| **Opt-in** | `import { … } from "@mun/ui/<feature>"` | Ordinary ES modules |

## Built-ins

```swift
struct Counter: View {
  @State var count = 0
  var body: some View {
    VStack(spacing: 12) {
      Text("Count: \(count)")
      Button("Increase") { count += 1 }
    }
    .padding(16)
  }
}
export default Counter()
```

The authoritative list is `munBuiltinSymbols()` from `@mun/compiler`
([`builtins.ts`](../packages/compiler/src/builtins.ts)). It is derived from what
the web runtime actually exports, and the compiler, the language server's
completion and hover, and the diagnostics all read it:

- **Views**: every runtime View type: `Text`, `Image`, `Icon`, `Label`, `Button`, `Link`,
  `Spacer`, `Divider`, `VStack`, `HStack`, `ZStack`, `LazyVStack`, `LazyHStack`, `Grid`,
  `LazyGrid`, `Group`, `Box`, `ScrollView`, `List`, `Section`, `ForEach`, `GeometryReader`,
  `SafeArea`, `NavigationStack`, `NavigationLink`, `TextField`, `TextArea`, `TextEditor`,
  `Toggle`, `Switch`, `Slider`, `Stepper`, `Picker`, `RadioGroup`, `Menu`, `ProgressView`,
  `Sheet`, `Alert`, `Rectangle`, `RoundedRectangle`, `Circle`, `Capsule`, `Path`.
- **Value types**: `Color`, `LinearGradient`, `Animation`, `Transition`, `ContentTransition`,
  `SymbolEffect`, `Transaction`, `VectorSymbol`.
- **Functions**: `State`, `Binding`, `Observable`, `Element`, `withAnimation`,
  `withTransaction`, `environmentValue`.
- **Types** (erased, editor-only): `View`, `String`, `Bool`, `Int`, `Double`, `Float`,
  `Character`, `Void`, `Never`.
- **Modifiers** (`.padding`, `.animation`, `.overlay`, …) are members of a View and never need importing.

### Resolution rules

1. The compiler lowers the module, then resolves every *free* identifier with real
   lexical scoping. Parameters, `let`/`const`/`var`, functions, classes, nested Views
   and imports are honoured.
2. A declaration or an explicit import **shadows** the built-in. A `struct Text: View`
   in the file makes every `Text(…)` in scope refer to it.
3. Only built-ins that are actually read are imported (`import { Text, VStack } from
   "@mun/core/compat"`). Each module imports just what it uses, so bundlers tree-shake
   unused Views exactly as with hand-written imports.
4. A name that resolves nowhere is an error at its source position:
   `Cannot find 'Frobnicate' in scope.` (lowercase typos such as `greting` too). Naming an opt-in feature without importing it
   says which module to import. A SwiftUI name that only the native target implements
   (`SecureField`) says so too. JavaScript and browser globals (`console`, `fetch`,
   `window`, `ResizeObserver`, `URL`) are not affected. Astro `@mun` blocks read their
   frontmatter through `transformMunSource(…, { externalScope: true })`.
5. Explicit imports from `@mun/core`, `@mun/core/compat` or `@mun/ui` keep working.

Implicit resolution applies only to `.mun` files. JavaScript and TypeScript modules
(including `.mun.ts`) keep ordinary ES scoping and import what they use.

## Opt-in features

Opt-in features are bundled in `@mun/ui` and selected with static imports, with no
plugin registry and no initialization step. An import that is never used adds zero bytes.

| Feature | Import path | Contents |
| --- | --- | --- |
| Progressive blur | `@mun/ui/progressive-blur` | `ProgressiveBlur`, `progressiveBlur`, `BlurProfile`, `blurFocus`, `focus`, `planBlur` |
| Progressive blur planner | `@mun/ui/progressive-blur/plan` | `planBlur`, `BlurProfile`, `focus`, `strengthAt`, `layerAlphas`, `layerCount`, `effectiveRadius` (pure, DOM-free) |

```swift
import { BlurProfile, ProgressiveBlur, blurFocus, focus, progressiveBlur } from "@mun/ui/progressive-blur"

struct Feed: View {
  @State var menuOpen = false
  var body: some View {
    VStack {
      Text("Under a bar").modifier(progressiveBlur(BlurProfile.edge("bottom", 120), { radius: 14 }))
      Text("Clipped").modifier(progressiveBlur(BlurProfile.linear({ from: "center", to: "bottom" }).easing("smooth"), { radius: 16, in: RoundedRectangle(24) }))
      Text("Menu").modifier(blurFocus("menu"))
    }
    .modifier(progressiveBlur(BlurProfile.radial({ around: focus("menu"), inner: 120, outer: 360 }), { radius: 10, amount: menuOpen ? 1 : 0 }))
  }
}
```

Changing `amount` animates the effect. `pnpm demo:progressive-blur` serves an
SSR + hydration example of every profile ([`examples/progressive-blur`](../examples/progressive-blur/App.mun)).

### Adding an opt-in feature

1. Keep the implementation in an internal workspace module (`packages/<feature>`), with
   renderer-independent logic in its own DOM-free subpath (as `progressive-blur/plan` is).
2. Re-export it from `src/<feature>/index.ts` (and any pure subpath) in the root
   package, add the `exports` entries and the `tsconfig.build.json` files, and add the
   module to `@mun/ui`'s `dependencies`.
3. List its exports in `munOptInFeatures` so diagnostics and the editor point at the
   import path. `tests/builtins.test.mjs` checks the list against the module.
4. Keep `sideEffects: false`: importing the module must not register or initialize anything.

## Packages that stay separate

The compiler, renderers (`@mun/web`), framework adapters (`@mun/react`, `@mun/vue`,
`@mun/astro`), build integration (`@mun/vite`), the animation engine, the resident
execution backend and the scaffolder (`create-mun`) keep their package boundaries.
They have distinct dependency graphs, peers or runtime targets. `@mun/ui` depends on
them, so one install still provides everything. React and Vue are optional peers that
are only needed if you use their adapter.

# Mun rendering engine — performance audit

Scope: the web DOM renderer (`packages/web/src`), its prop/motion/transition helpers, and the reactive state layer it subscribes to (`packages/core/src/state.ts`). This is a static code review: each finding names the code path, the conditions that trigger it, and how much it costs. Nothing here has been profiled. Severity is my estimate of the impact on a realistic app.

Legend: **High** = visible jank or O(n²)/O(document) work on common paths · **Medium** = real cost under specific usage · **Low** = micro-cost or edge case.

---

## 1. Whole-tree root passes

### 1.1 Lazy-list scroll and geometry changes trigger full root re-renders — **High**
`dom.ts` `scheduleLazyMeasure` → `requestRootUpdate(undefined, true)`, and `updateGeometry` → `requestRootUpdate(undefined, true)`.

When a lazy (virtualized) range changes during scrolling, or a geometry reader's frame changes, the engine sets `forceAll = true` and runs `update()` for the **entire mount**. That pass re-runs `renderViewNode(value)` into a detached candidate DOM and reconciles all of it. With a large app around one list, every range shift on scroll costs about as much as the whole app's render. Expected effect: scroll jank that grows with app size, not with list size.

*Fix direction:* scope the update to the lazy/geometry boundary that owns the change. The boundary machinery (`updateBoundary`) already exists.

### 1.2 Every update builds a full candidate DOM, then diffs it — **High (structural)**
`update()` renders the full view into real (detached) DOM nodes, then runs `reconcileDomChildren(container, outputChildren)`. Even when one text node changed, a forced root pass allocates a DOM element for every view node. This costs O(tree) allocations plus GC per pass. Compiled templates, flat-host plans and boundary reuse (`reuseCandidates`) soften it, but any `forceAll` pass, and any view that falls off those fast paths, pays the full cost.

### 1.3 Post-commit work runs on every root pass — **Medium/High**
After each `update()`:
- `updateGeometry()` calls `getBoundingClientRect` and `getComputedStyle` on a probe for every `[data-mun-geometry]` element.
- `observeLazyItems()` calls **`lazyItemObserver.disconnect()`, then re-observes every `[data-mun-lazy-item]`** via `querySelectorAll`. Re-observing makes ResizeObserver deliver an initial entry for *every* item, so `measureLazyItem` runs on all of them after every pass, even when nothing resized.
- `observeLazyViewport()` and `refreshLazyRanges()` each run `container.querySelectorAll("[data-mun-lazy]")`, and `captureLazyScrollPositions()` runs it again before the pass.

These are document-scale queries and forced layouts, repeated per pass.

### 1.4 Feedback loops between measurement and re-render — **Medium**
Geometry reader → root update → layout change → new geometry → root update. Lazy measurement → range change → root update → ResizeObserver entries (see 1.3) → measurement… A microtask guard (`geometryScheduled`, `lazyMeasureScheduled`) only prevents re-entrancy, not repetition. Content whose size depends on its own geometry, such as rounding or a scrollbar appearing, can oscillate for several frames.

### 1.5 Failed hydration renders the tree up to three times — **Medium (first load)**
`update()` hydration path: (1) the fast reuse attempt, (2) a re-render for the identity-preserving hydrator if reuse fails, (3) a third render for a clean client candidate if structural hydration also fails. It then removes and re-appends the whole container. Mismatched SSR output therefore triples time-to-interactive work.

### 1.6 Non-DOM fallback `mount` replaces `innerHTML` on every change — **High where used**
The second `mount` (end of `dom.ts`, `container.innerHTML = renderToHTML(value)`) re-serializes and re-parses the entire tree on every state change. That also destroys focus, selection and scroll. It is fine as a fallback, but it must never be the path a real browser takes.

---

## 2. Layout thrashing (forced synchronous layout)

### 2.1 Layout capture is interleaved with DOM writes during reconciliation — **High (when animated)**
`captureLayoutNeighborhood` / `captureLayoutElement` → `readLayoutBox` → `getBoundingClientRect`, called from inside `reconcileDomNode` **between** `patchDomProps` writes on earlier siblings. Each read after a write forces a synchronous style and layout recalculation. In a transaction with an animation (`withAnimation`, `.animation(value:)`), one update over N siblings can cause up to N forced layouts.

The per-parent dedupe (`layoutNeighborhoodAnimations`) prevents the O(n²) *scan*. It does not prevent the read/write interleave: the first child that changes captures the neighborhood only after earlier children were already written.

*Fix direction:* collect "elements to capture" during reconcile, then read every box in one batch *before* the first write. That means a pre-pass over the dirty set, or capturing at the boundary level before the patch starts.

### 2.2 `captureLayoutChildren` reads every child box whenever a range changes length or is keyed — **Medium**
`reconcileDomChildren` / `reconcileDomRange`: `if (currentNodes.length !== nextChildren.length || keyedChildren) captureLayoutChildren(...)`. Under an animated transaction, each keyed list update calls `getBoundingClientRect` on every child, even a single in-place prop change in a 5 000-row keyed list. These reads come before that range's writes, but after writes elsewhere in the tree.

### 2.3 Text content transitions read layout mid-reconcile — **Medium**
`reconcileDomNode` (text branch) calls `readLayoutBox(host)` before mutating `nodeValue` whenever a content transition is registered. In a list of animated counters, each counter forces its own layout.

### 2.4 Continuous corners force layout during every patch — **High for styled UIs**
`props.ts` → `syncContinuousCorners` → `continuous-corners.ts update()` reads `offsetWidth`, `offsetHeight` and `getComputedStyle(element)` **synchronously**. This runs at the end of every `patchDomProps`, `applyDomProps` and `commitStagedDomProps` for elements with `--mun-corner-style: continuous`. It runs inside the reconcile loop, so every such element forces a layout after the preceding writes. A grid of cards with continuous corners turns into N forced layouts per update.

On top of that, the ResizeObserver callback rewrites `clip-path: path(...)`. A `path()` clip can't be composited, so a size animation (such as a width spring) causes a repaint and rasterization on every frame.

*Fix direction:* rely only on the ResizeObserver, which already batches reads after layout, and drop the synchronous `update()` in `syncContinuousCorners`. Alternatively, defer it to one rAF read phase.

### 2.5 `measureLazyItem` interleaves reads and scroll writes — **High during fast scroll**
Inside the ResizeObserver callback, each entry calls `getBoundingClientRect` on the item, `lazyScrollParent`, the item again and the parent. It then **writes `scrollTop += delta`** or calls `window.scrollBy`, and the next entry reads again. With many entries (always the case; see 1.3), this is a read→write→read loop with a forced layout per item.

*Fix direction:* do all measurements first, add up the deltas, and apply one scroll correction.

### 2.6 `lazyScrollParent` calls `getComputedStyle` on every ancestor — **Medium**
It walks from the lazy element up to the root and calls `getComputedStyle` at each level. It runs in `lazyViewportMetrics` (every scroll event, per lazy element), `observeLazyViewport`, `captureLazyScrollPositions` and `measureLazyItem` (per measured item). Nothing caches it, so a deeply nested list pays O(depth) style reads several times per scroll tick.

### 2.7 Geometry readers — **Medium**
`geometryFromElement` makes a rect read and a `getComputedStyle(probe)` per reader per pass. The persistent probe stops the append/remove churn, but the `safe-area-inset` padding is recomputed for every reader even though it's the same value for all of them.

---

## 3. Scroll handling

### 3.1 The scroll listener runs on microtasks, not rAF — **Medium**
`scroll` and `resize` → `scheduleLazyMeasure` → `queueMicrotask(refreshLazyRanges)`. Each scroll event therefore does a `querySelectorAll`, rect reads and the ancestor `getComputedStyle` walk right away, and can start a full root pass (1.1) inside the same event. Throttling to `requestAnimationFrame` would merge all scroll events in a frame into one measurement.

### 3.2 Saving and restoring scroll position on every root pass — **Low/Medium**
`captureLazyScrollPositions` reads `scrollTop` and `scrollLeft` (a forced layout if the tree is dirty) before every pass, and writes them back afterward. That write can itself fire `scroll`, which schedules another lazy measurement.

---

## 4. Reconciliation algorithms

### 4.1 Generic keyed fallback moves nodes one by one, without LIS — **Medium**
When neither `reconcileTailAppend` nor `reconcilePureKeyedPermutation` applies (for example a mix of insertion and reorder, or a keyed list with an unkeyed sibling), `reconcileDomChildren` and `reconcileDomRange` call `insertBefore` for each misplaced node and look up `parent.childNodes[index]` every iteration. Only the pure-permutation path uses the LIS. "Remove one row and move another" can relocate O(n) nodes, each one invalidating the live child list.

### 4.2 Removal in the generic path is one node at a time — **Low/Medium**
The trailing `removeDomNode` loop in the generic path removes nodes individually. Only `removeNodeBatch` has the `replaceChildren` fast path.

### 4.3 Repeated `[...childNodes]` / `Array.from` snapshots — **Low**
`reconcileDomChildren`, `outputNodes`, `removeNodeBatch` and others copy NodeLists on every visit. These copies are needed for correctness, but they allocate per parent per pass.

### 4.4 `flushLayoutMotion` ancestor walk — **Low/Medium**
For every changed element, the code walks `parentElement` all the way to the document root to look for a covering ancestor. That's O(changed × depth). Deep trees with wide animated updates pay for it, though the cost is still small compared with the layout reads.

### 4.5 `releaseDomSubtree` recursion on removal — **Low**
Each removed element runs several WeakMap lookups and cancellations (presentation, content transition, animations, corners, focus scope, events). Removing a 10 k-row list touches every descendant. Unavoidable for cleanup, but worth knowing.

---

## 5. Prop/style patching

### 5.1 Style objects never take the equality fast path — **Medium**
`sameDomProps` compares with `Object.is`. View code creates a new `style` object on every render, so any element with a style always falls through to the full per-key style diff. That diff runs `cssPropertyName`, `motionPolicy` lookups and `style.getPropertyValue` (a cheap read, but a CSSOM call) for each key. A shallow equality check on `style` before the full diff would let unchanged elements exit early.

### 5.2 Regex per prop key — **Low**
`/^on[A-Za-z]/.test(key)` runs several times per key per patch (`canFastPatchPrimitive`, both loops of `patchDomProps`). It's a hot loop, so `key.charCodeAt` checks or a cached key classification would be cheaper.

### 5.3 Non-object `style` replacement wipes all animations — **Low**
When `style` switches between string and object form, `cancelDomAnimations` runs, `removeAttribute("style")` is called and the style is rebuilt. That restarts every running motion channel on the element.

---

## 6. Animation & visual effects

### 6.1 Main-thread JS animation for style and layout motion — **Medium/High under load**
`motion.ts` animates through the JS spring/timeline engine, writing `style.setProperty` from JS (batched per microtask by `queueStyleWrite`). Native WAAPI (`element.animate`) is used only in some `element-motion.ts` paths. Effects:
- When the main thread is busy (for example a root pass from 1.1), animations stall. Compositor-only properties such as transform and opacity get none of the off-main-thread benefit.
- Animating layout properties such as `width`, `height`, `padding` and `gap` through `animateDomStyles` causes a full layout every frame. With 2.4 involved, it also re-rasterizes the `clip-path`.

### 6.2 FLIP uses `scale` without counter-scaling children — **Low (perf) / visual**
`animateDomLayout` animates `scale` on the parent. A changed child with the *same* animation is skipped (covered), but a child with a *different* animation gets its own FLIP, so two compositor layers animate. Each animated element is also promoted to its own layer for the duration. Animating hundreds of rows at once costs GPU memory.

### 6.3 Filter modifiers always apply the full 7-function filter chain — **Medium**
`shared.ts`: `.blur`, `.brightness`, `.contrast`, `.saturation`, `.grayscale`, `.hueRotation` and `.colorInvert` all set `filter: blur(var(...)) brightness(var(...)) contrast(...) saturate(...) grayscale(...) hue-rotate(...) invert(...)`. A single `.brightness(0.1)` creates a full filter stack, plus a stacking context and a compositing layer. Animating any of the custom properties re-evaluates every filter function each frame. `blur(0px)` is not free in every engine either. Emitting only the functions in use would avoid this.

### 6.4 Text content transitions — **Medium**
`content-transition.ts`:
- A fixed overlay is appended to `document.body` per transition, and `copyTextStyle` runs a `getComputedStyle` per transition.
- `measureGraphemeRow` creates one `<span>` per grapheme and reads `getBoundingClientRect` per span (a single layout, then N rect reads).
- Each glyph runs its own `munMotion.animate` with an `onUpdate` callback that writes inline styles every frame. A long numeric string that ticks often (a live counter) means dozens of JS-driven animations per change.
- Grapheme matching is an LCS table capped at `65 536` cells, which is quadratic in text length up to that cap.
- `reducedMotion()` calls `matchMedia` on every transition instead of caching the result.

### 6.5 Transition helpers — **Low**
`transition.ts` reads `getComputedStyle` per enter or exit. `presentation.ts` and `focus.ts` use `querySelectorAll` per activation. These are fine individually, but they become costly when a list transition triggers many of them in the same frame.

---

## 7. Canvas / GPU islands

### 7.1 Canvas fallback loops never stop — **High (battery/CPU)**
In `gpu-island.ts`, `runCanvasFallback` and `runLineChartCanvasFallback` run `requestAnimationFrame(tick)` forever. Nothing pauses them when the canvas is offscreen, hidden or `display:none`; only rAF's own background-tab throttling applies. No IntersectionObserver gates them either.

### 7.2 The particle fallback draw is very inefficient — **High when the fallback is used**
Every particle, every frame, builds a new `rgba(...)` string for `fillStyle` and runs `beginPath` / `arc` / `fill`. With thousands of particles that's thousands of string allocations and path submissions per frame. Better options: batch by colour into one path, use `fillRect` for small radii, or write to an `ImageData` buffer.

---

## 8. Reactive state layer (`core/src/state.ts`)

### 8.1 Synchronous dispatch for every mutation — **Medium**
`notify` → `dispatchNotification` runs synchronously on each write outside an explicit batch. Every write allocates and freezes a mutation snapshot (`snapshotMutation`, which also `unwrap`s each argument) and a batch object, then calls every listener. The DOM renderer coalesces into a microtask, but a loop of 10 000 property writes still causes 10 000 dispatches and about 30 000 frozen allocations.

### 8.2 `attachGraph` walks the whole assigned value — **Medium/High for large data**
Assigning a large nested object or array to State (or `push`ing non-shallow rows) walks every reachable container with `Reflect.ownKeys` and `getOwnPropertyDescriptor`. Replacing a 50 k-node JSON document costs O(document) before any render, and again each time it's reassigned.

### 8.3 Array mutators snapshot the whole array — **Medium**
Every proxied `splice`, `sort`, `reverse`, `fill` or `copyWithin` call copies the array (`Array.prototype.slice`) and then compares it element by element (`sameArraySnapshot` with `unwrap` per element). That's O(n) extra per call, even for `splice(i, 1)` on a long list.

### 8.4 `sort` comparator wraps both operands in proxies — **Medium**
`compare(wrap(left, record), wrap(right, record))` makes two proxy-cache lookups per comparison, which adds up to O(n log n) map hits. A sort over 100 k rows does several million extra map operations.

### 8.5 Listener set copied per notify — **Low**
`[...record.listeners]` runs on every dispatch.

---

## Hot spots, prioritized

| # | Issue | Where | Severity |
|---|-------|-------|----------|
| 1 | Lazy scroll and geometry changes force a full root pass | `dom.ts` `scheduleLazyMeasure`, `updateGeometry` | High |
| 2 | Layout reads interleaved with writes during reconcile | `captureLayout*`, `readLayoutBox` in `reconcileDomNode` | High |
| 3 | Continuous corners force layout inside every patch | `continuous-corners.ts update()` via `props.ts` | High |
| 4 | ResizeObserver re-observes all lazy items every pass, plus read/write-interleaved scroll correction | `observeLazyItems`, `measureLazyItem` | High |
| 5 | Endless canvas fallback rAF and per-particle string/path cost | `gpu-island.ts` | High |
| 6 | Full candidate DOM allocated per root pass | `update()` / `renderViewNode` | High (structural) |
| 7 | Scroll handling on microtasks, uncached `getComputedStyle` ancestor walk | `lazyScrollParent`, scroll listener | Medium |
| 8 | Full filter chain for any single filter modifier | `shared.ts` | Medium |
| 9 | JS main-thread animation of layout properties | `motion.ts` | Medium |
| 10 | Large-graph `attachGraph`, O(n) array mutator snapshots, sort wrapping | `core/state.ts` | Medium |
| 11 | Generic keyed path without LIS | `reconcileDomChildren` / `reconcileDomRange` | Medium |
| 12 | Hydration mismatch renders up to 3× | `update()` | Medium |

## Suggested verification
The existing benchmarks (`benchmarks/browser-performance.mjs`, `patch-ranges-browser.mjs`, `collection-runtime.mjs`) measure throughput but not layout counts. Two ways to confirm items 1–4:
- Run a Playwright trace with `--enable-blink-features` / the Chrome DevTools Performance panel and look for "Forced reflow" warnings.
- Count `getBoundingClientRect` calls per update by wrapping `Element.prototype.getBoundingClientRect` in a browser benchmark.

Good scenarios: a 5 k-row `LazyVStack` scrolled quickly, a 500-card grid with continuous corners updated under `withAnimation`, and a counter list using numeric text transitions.

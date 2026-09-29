import fs from 'node:fs'

const replace = (path, before, after) => {
  let source = fs.readFileSync(path, 'utf8')
  if (!source.includes(before)) throw new Error(`marker missing in ${path}: ${before.slice(0, 80)}`)
  source = source.replace(before, after)
  fs.writeFileSync(path, source)
}

fs.writeFileSync('packages/core/src/graph/arrays.ts', `const dataOnlySnapshots = new WeakSet<object>()

/** Check array identity without leaking revoked Proxy errors. */
export function arrayCheck(value: unknown): boolean | undefined {
  try { return Array.isArray(value) } catch { return undefined }
}

/** Strict descriptor-only snapshot used at collection boundaries. */
export function snapshotDataArrayValues(value: unknown): readonly unknown[] | undefined {
  if (arrayCheck(value) !== true) return undefined
  const values = value as readonly unknown[]
  try {
    const length = Object.getOwnPropertyDescriptor(values, "length")
    if (!length || !("value" in length) || !Number.isSafeInteger(length.value) || length.value < 0) return undefined
    const snapshot = new Array<unknown>(length.value)
    for (let index = 0; index < length.value; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(values, String(index))
      if (!descriptor) continue
      if (!("value" in descriptor)) return undefined
      snapshot[index] = descriptor.value
    }
    Object.freeze(snapshot)
    dataOnlySnapshots.add(snapshot)
    return snapshot
  } catch { return undefined }
}

/** Snapshot array indices without invoking iterators or indexed accessors. */
export function snapshotArrayValues(value: readonly unknown[]): readonly unknown[] {
  try {
    if (dataOnlySnapshots.has(value as object)) return value
    const length = Object.getOwnPropertyDescriptor(value, "length")
    if (!length || !("value" in length) || !Number.isSafeInteger(length.value) || length.value < 0) return Object.freeze([])
    const snapshot = new Array<unknown>(length.value)
    for (let index = 0; index < length.value; index += 1) {
      const descriptor = Object.getOwnPropertyDescriptor(value, String(index))
      snapshot[index] = descriptor && "value" in descriptor ? descriptor.value : undefined
    }
    return Object.freeze(snapshot)
  } catch { return Object.freeze([]) }
}
`)

replace('packages/core/src/graph/types.ts',
`  readonly indexIndependent: boolean
  readonly evaluate: (item: unknown, index: number) => CompiledCollectionRow
}`,
`  readonly indexIndependent: boolean
  /** Compiler-proven stable key evaluator. Required for collection-owned State invalidation. */
  readonly evaluateKey?: (item: unknown, index: number) => string | number
  readonly evaluate: (item: unknown, index: number) => CompiledCollectionRow
}`)
replace('packages/core/src/graph/types.ts',
`  readonly items: readonly unknown[]
  /** Original collection identity before the descriptor-only snapshot. */`,
`  readonly items: readonly unknown[]
  /** Deferred strict snapshot for a State-backed source. */
  readonly readItems?: () => readonly unknown[]
  /** Original collection identity before the descriptor-only snapshot. */`)

replace('packages/core/src/graph/nodes.ts',
`export function keyedCollectionEntries(node: KeyedCollectionViewNode): readonly KeyedCollectionEntry[] {
  const occurrences = new Map<string, number>()
  const entries = new Array<KeyedCollectionEntry>(node.items.length)
  for (let index = 0; index < node.items.length; index += 1) {
    const item = node.items[index]`,
`export function keyedCollectionEntries(node: KeyedCollectionViewNode, itemSnapshot?: readonly unknown[]): readonly KeyedCollectionEntry[] {
  const items = itemSnapshot ?? node.readItems?.() ?? node.items
  const occurrences = new Map<string, number>()
  const entries = new Array<KeyedCollectionEntry>(items.length)
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index]`)
replace('packages/core/src/graph/nodes.ts',
`    readonly indexIndependent?: boolean
    readonly compiled?: CompiledCollectionPlan
    readonly onDuplicateKey?: KeyedCollectionViewNode["onDuplicateKey"]`,
`    readonly indexIndependent?: boolean
    readonly compiled?: CompiledCollectionPlan
    readonly readItems?: KeyedCollectionViewNode["readItems"]
    readonly onDuplicateKey?: KeyedCollectionViewNode["onDuplicateKey"]`)
replace('packages/core/src/graph/nodes.ts',
`    indexIndependent: options.indexIndependent === true,
    ...(options.compiled ? { compiled: options.compiled } : {}),
    ...(options.onDuplicateKey ? { onDuplicateKey: options.onDuplicateKey } : {}),`,
`    indexIndependent: options.indexIndependent === true,
    ...(options.compiled ? { compiled: options.compiled } : {}),
    ...(options.readItems ? { readItems: options.readItems } : {}),
    ...(options.onDuplicateKey ? { onDuplicateKey: options.onDuplicateKey } : {}),`)

replace('packages/core/src/views.ts', 'import { arrayCheck } from "./graph/arrays.js"', 'import { arrayCheck, snapshotDataArrayValues } from "./graph/arrays.js"')
const viewsPath = 'packages/core/src/views.ts'
let views = fs.readFileSync(viewsPath, 'utf8')
const snapshotStart = views.indexOf('function snapshotCollectionItems(value: unknown): readonly unknown[] | undefined {')
const requireStart = views.indexOf('function requireCollectionItems(value: unknown): readonly unknown[] {', snapshotStart)
if (snapshotStart < 0 || requireStart < 0) throw new Error('collection snapshot helper markers missing')
views = views.slice(0, snapshotStart) + `function snapshotCollectionItems(value: unknown): readonly unknown[] | undefined {
  return snapshotDataArrayValues(value)
}

` + views.slice(requireStart)
views = views.replace('  return snapshot\n}\n\ninterface ForEachProps<Item> {', '  return snapshot\n}\n\nconst emptyCollectionItems = Object.freeze([]) as readonly unknown[]\n\ninterface ForEachProps<Item> {')
const foreachBefore = `  ({ items, key, content }) => {
    const source = isStateRef(items) ? items.value : items
    const collection = requireCollectionItems(source)
    const selector = key as CollectionKeySelector<unknown> | undefined
    return keyedCollectionView(
      collection,
      source,`
const foreachAfter = `  ({ items, key, content }) => {
    const stateSource = isStateRef(items) ? items as StateRef<readonly unknown[]> : undefined
    const source = stateSource ?? items
    const collection = stateSource ? emptyCollectionItems : requireCollectionItems(items)
    const compiled = compiledCollectionPlanOf(content)
    const selector = (compiled?.evaluateKey ?? key) as CollectionKeySelector<unknown> | undefined
    return keyedCollectionView(
      collection,
      source,`
if (!views.includes(foreachBefore)) throw new Error('ForEach source marker missing')
views = views.replace(foreachBefore, foreachAfter)
views = views.replace(`        indexIndependent: false,
        compiled: compiledCollectionPlanOf(content),
        onDuplicateKey:`, `        indexIndependent: false,
        compiled,
        ...(stateSource ? { readItems: () => requireCollectionItems(stateSource.value) } : {}),
        onDuplicateKey:`)
fs.writeFileSync(viewsPath, views)

const compilerPath = 'packages/compiler/src/collection-specialization.ts'
let compiler = fs.readFileSync(compilerPath, 'utf8')
compiler = compiler.replace(`interface CompiledForEachCall {
  readonly content: ts.Expression
  readonly items: ts.Expression
}`, `interface CompiledForEachCall {
  readonly initializerIndex: number
  readonly content: ts.Expression
  readonly items: ts.Expression
  readonly key?: ts.Expression
}`)
const parserStart = compiler.indexOf('function compiledForEachCall(')
const lowerStart = compiler.indexOf('export function lowerCompiledCollections', parserStart)
if (parserStart < 0 || lowerStart < 0) throw new Error('compiler parser markers missing')
const parser = `function collectionKeyPlan(closure: ts.Expression): { readonly source: string; readonly indexIndependent: boolean } | undefined {
  const value = unwrapExpression(closure)
  if (!ts.isArrowFunction(value) && !ts.isFunctionExpression(value)) return undefined
  if (value.parameters.length < 1 || value.parameters.length > 2) return undefined
  const item = value.parameters[0]
  const index = value.parameters[1]
  if (!ts.isIdentifier(item.name) || item.dotDotDotToken || item.initializer) return undefined
  if (index && (!ts.isIdentifier(index.name) || index.dotDotDotToken || index.initializer)) return undefined
  const result = closureResult(value)
  if (!result) return undefined
  const indexName = index && ts.isIdentifier(index.name) ? index.name.text : undefined
  const analysis = analyzeRowExpression(result, item.name.text, indexName)
  if (!analysis.pure) return undefined
  return { source: closure.getText(), indexIndependent: !analysis.indexDependent }
}

function compiledForEachCall(call: ts.CallExpression, foreachNames: ReadonlySet<string>): CompiledForEachCall | undefined {
  const callee = unwrapExpression(call.expression)
  if (!ts.isPropertyAccessExpression(callee) || callee.name.text !== "createNodeCompiled") return undefined
  const viewType = unwrapExpression(callee.expression)
  if (!ts.isPropertyAccessExpression(viewType) || viewType.name.text !== "viewType") return undefined
  const owner = unwrapExpression(viewType.expression)
  if (!ts.isIdentifier(owner) || !foreachNames.has(owner.text)) return undefined
  if (call.arguments.length !== 2 || !ts.isNumericLiteral(call.arguments[0]) || !ts.isArrayLiteralExpression(call.arguments[1])) return undefined
  const initializerIndex = Number(call.arguments[0].text)
  if (initializerIndex !== 0 && initializerIndex !== 1) return undefined
  const values = call.arguments[1].elements
  const items = values[0]
  const key = initializerIndex === 1 ? values[1] : undefined
  const content = values.at(-1)
  if (!items || !content || ts.isSpreadElement(items) || ts.isOmittedExpression(items)
    || (key && (ts.isSpreadElement(key) || ts.isOmittedExpression(key)))
    || ts.isSpreadElement(content) || ts.isOmittedExpression(content)) return undefined
  return { initializerIndex, items, ...(key ? { key } : {}), content }
}

`
compiler = compiler.slice(0, parserStart) + parser + compiler.slice(lowerStart)
const lowerOld = `      if (compiled) {
        const stateRef = provenStateRefSource(compiled.items, sourceFile, states)
        if (stateRef) {
          edits.push({
            start: compiled.items.getStart(sourceFile),
            end: compiled.items.end,
            replacement: stateRef.getText(sourceFile),
          })
        }
        if (elements.names.size > 0 || elements.namespaces.size > 0) {
          const plan = collectionRowPlan(compiled.content, sourceFile, elements)
          if (plan) {
            const parameters = plan.indexName ? \`${plan.itemName}, ${plan.indexName}\` : plan.itemName
            edits.push({
              start: compiled.content.getStart(sourceFile),
              end: compiled.content.end,
              replacement: \`compiledCollectionContent(${compiled.content.getText(sourceFile)}, { kind: "flat-text-host", indexIndependent: ${plan.indexIndependent}, evaluate: (${parameters}) => ({ type: ${plan.typeSource}, props: ${plan.propsSource}, text: ${plan.textSource} }) })\`,
            })
          }
        }
        return
      }`
const lowerNew = `      if (compiled) {
        const rowPlan = elements.names.size > 0 || elements.namespaces.size > 0
          ? collectionRowPlan(compiled.content, sourceFile, elements)
          : undefined
        const keyPlan = compiled.key ? collectionKeyPlan(compiled.key) : undefined
        const stateRef = rowPlan && keyPlan ? provenStateRefSource(compiled.items, sourceFile, states) : undefined
        if (stateRef) edits.push({ start: compiled.items.getStart(sourceFile), end: compiled.items.end, replacement: stateRef.getText(sourceFile) })
        if (rowPlan) {
          const parameters = rowPlan.indexName ? \`${rowPlan.itemName}, ${rowPlan.indexName}\` : rowPlan.itemName
          const compiledKey = keyPlan ? \`, evaluateKey: ${keyPlan.source}\` : ""
          edits.push({
            start: compiled.content.getStart(sourceFile),
            end: compiled.content.end,
            replacement: \`compiledCollectionContent(${compiled.content.getText(sourceFile)}, { kind: "flat-text-host", indexIndependent: ${rowPlan.indexIndependent}${compiledKey}, evaluate: (${parameters}) => ({ type: ${rowPlan.typeSource}, props: ${rowPlan.propsSource}, text: ${rowPlan.textSource} }) })\`,
          })
        }
        return
      }`
if (!compiler.includes(lowerOld)) throw new Error('compiler lowering marker missing')
compiler = compiler.replace(lowerOld, lowerNew)
fs.writeFileSync(compilerPath, compiler)

const domPath = 'packages/web/src/dom.ts'
let dom = fs.readFileSync(domPath, 'utf8')
dom = dom.replace('  keyedCollectionEntries,\n  reactiveIdentity,', '  keyedCollectionEntries,\n  isStateRef,\n  reactiveIdentity,')
dom = dom.replace(`  order: DomCollectionRow[]
}`, `  order: DomCollectionRow[]
  pendingTransaction?: Transaction
  readonly pendingMutations: StateMutation[]
  scheduled: boolean
  unsubscribe?: () => void
}`)
dom = dom.replace(`  materializeView?: (
    node: ViewHostNode,`, `  invalidateBoundary?: (key: string, transaction: Transaction | undefined, mutations: readonly StateMutation[]) => void
  materializeView?: (
    node: ViewHostNode,`)
const discardOld = `function discardDomCollections(runtime: DomViewRuntime, ownerKey: string): void {
  const keys = runtime.collectionKeysByOwner.get(ownerKey)
  if (!keys) return
  for (const key of keys) runtime.collections.delete(key)
  runtime.collectionKeysByOwner.delete(ownerKey)
}

function registerDomCollection(runtime: DomViewRuntime, instance: DomCollectionInstance): void {
  runtime.collections.set(instance.key, instance)
  const keys = runtime.collectionKeysByOwner.get(instance.ownerKey) ?? new Set<string>()
  keys.add(instance.key)
  runtime.collectionKeysByOwner.set(instance.ownerKey, keys)
}`
const discardNew = `function disposeDomCollection(runtime: DomViewRuntime, key: string): void {
  const instance = runtime.collections.get(key)
  if (!instance) return
  instance.unsubscribe?.()
  runtime.collections.delete(key)
  const keys = runtime.collectionKeysByOwner.get(instance.ownerKey)
  keys?.delete(key)
  if (keys?.size === 0) runtime.collectionKeysByOwner.delete(instance.ownerKey)
}

function discardDomCollections(runtime: DomViewRuntime, ownerKey: string): void {
  const keys = runtime.collectionKeysByOwner.get(ownerKey)
  if (!keys) return
  for (const key of [...keys]) disposeDomCollection(runtime, key)
}

function registerDomCollection(runtime: DomViewRuntime, instance: DomCollectionInstance): void {
  disposeDomCollection(runtime, instance.key)
  runtime.collections.set(instance.key, instance)
  const keys = runtime.collectionKeysByOwner.get(instance.ownerKey) ?? new Set<string>()
  keys.add(instance.key)
  runtime.collectionKeysByOwner.set(instance.ownerKey, keys)
}

function collectionEntries(node: KeyedCollectionViewNode, untrackedSource = false): readonly KeyedCollectionEntry[] {
  if (!untrackedSource || !node.readItems) return keyedCollectionEntries(node)
  const items = collectStateReads(() => node.readItems!(), () => undefined)
  return keyedCollectionEntries(node, items)
}

function collectionSourceIdentity(node: KeyedCollectionViewNode): unknown {
  const source = isStateRef(node.source)
    ? collectStateReads(() => (node.source as StateRef<unknown>).value, () => undefined)
    : node.source
  return reactiveIdentity(source)
}

function subscribeDomCollection(instance: DomCollectionInstance, context: DomRenderContext, runtime: DomViewRuntime): void {
  if (!isStateRef(instance.node.source) || !instance.node.compiled?.evaluateKey) return
  const source = instance.node.source as StateRef<unknown>
  instance.unsubscribe = subscribeState(source, (transaction, batch) => {
    if (runtime.collections.get(instance.key) !== instance) return
    instance.pendingTransaction = transaction
    instance.pendingMutations.push(...batch.mutations)
    if (instance.scheduled) return
    instance.scheduled = true
    queueMicrotask(() => {
      instance.scheduled = false
      if (runtime.collections.get(instance.key) !== instance) return
      const pending = instance.pendingMutations.splice(0)
      const renderTransaction = instance.pendingTransaction
      instance.pendingTransaction = undefined
      const parent = instance.order[0]?.element.parentNode
      const previousTransaction = context.activeTransaction
      context.activeTransaction = renderTransaction
      let patched = false
      try {
        if (parent) patched = withRenderTransaction(renderTransaction, () => patchPersistentCollection(instance, instance.node, parent, pending, context))
      } finally { context.activeTransaction = previousTransaction }
      if (patched) { flushLayoutMotion(context); return }
      runtime.invalidateBoundary?.(instance.ownerKey, renderTransaction, pending)
    })
  })
}`
if (!dom.includes(discardOld)) throw new Error('DOM collection registration marker missing')
dom = dom.replace(discardOld, discardNew)
dom = dom.replace('  const entries = keyedCollectionEntries(node)\n  // An empty runtime-inferred collection', '  const entries = collectionEntries(node, true)\n  // An empty runtime-inferred collection')
dom = dom.replace(`  registerDomCollection(runtime, {
    key,
    ownerKey,
    node,
    sourceIdentity: reactiveIdentity(node.source),
    rows,
    order,
  })`, `  const instance: DomCollectionInstance = {
    key,
    ownerKey,
    node,
    sourceIdentity: collectionSourceIdentity(node),
    rows,
    order,
    pendingMutations: [],
    scheduled: false,
  }
  registerDomCollection(runtime, instance)
  subscribeDomCollection(instance, context, runtime)`)
dom = dom.replace('  const nextSource = reactiveIdentity(node.source)', '  const nextSource = collectionSourceIdentity(node)')
dom = dom.replace('  instance.sourceIdentity = reactiveIdentity(node.source)', '  instance.sourceIdentity = collectionSourceIdentity(node)')
const updateStart = dom.indexOf('    updateBoundary = (boundary: DomViewBoundary): void => {')
const updateBoundaryEnd = dom.indexOf('\n    update = () => {', updateStart)
if (updateStart < 0 || updateBoundaryEnd < 0) throw new Error('updateBoundary markers missing')
const invalidate = `

    viewRuntime.invalidateBoundary = (key, transaction, mutations) => {
      const boundary = viewRuntime.boundaries.get(key)
      if (!boundary) { requestRootUpdate(transaction, true); return }
      boundary.pendingTransaction = transaction
      boundary.pendingMutations.push(...mutations)
      if (boundary.scheduled || stopped) return
      boundary.scheduled = true
      queueMicrotask(() => updateBoundary(boundary))
    }
`
dom = dom.slice(0, updateBoundaryEnd) + invalidate + dom.slice(updateBoundaryEnd)
dom = dom.replace('      viewRuntime.collections.clear()\n      viewRuntime.collectionKeysByOwner.clear()', '      for (const key of [...viewRuntime.collections.keys()]) cleanup(() => disposeDomCollection(viewRuntime, key))\n      viewRuntime.collections.clear()\n      viewRuntime.collectionKeysByOwner.clear()')
fs.writeFileSync(domPath, dom)

const testPath = 'tests/compiler-package.test.mjs'
let tests = fs.readFileSync(testPath, 'utf8')
const oldOwned = `test("compiler keeps proven top-level State collections owned by the ForEach boundary", () => {
  const source = \`import { State, Element, ForEach, defineView, initializer } from "@mun/core"
const items = State([{ id: "a", value: "A" }])
export const App = defineView("App", { initializers: [initializer("App()", args => args.length === 0)], body: () => Element("section", null, ForEach(items.value, item => Element("span", null, item.value))) })\`
  const output = transformMunSource(source, "StateOwnedCollection.mun.ts")
  assert.match(output, /ForEach\\.viewType\\.createNodeCompiled\\(0, \\[items, compiledCollectionContent/)
  assert.doesNotMatch(output, /createNodeCompiled\\(0, \\[items\\.value, compiledCollectionContent/)
})`
const newOwned = `test("compiler keeps proven keyed State collections owned by the collection executor", () => {
  const source = \`import { State, Element, ForEach, defineView, initializer } from "@mun/core"
const items = State([{ id: "a", value: "A" }])
export const App = defineView("App", { initializers: [initializer("App()", args => args.length === 0)], body: () => Element("section", null, ForEach(items.value, item => item.id, item => Element("span", null, item.value))) })\`
  const output = transformMunSource(source, "StateOwnedCollection.mun.ts")
  assert.match(output, /ForEach\\.viewType\\.createNodeCompiled\\(1, \\[items, item => item\\.id, compiledCollectionContent/)
  assert.match(output, /evaluateKey: item => item\\.id/)
})`
if (!tests.includes(oldOwned)) throw new Error('owned compiler test marker missing')
tests = tests.replace(oldOwned, newOwned)
const oldAlias = `test("compiler recognizes aliased State constructors for collection ownership", () => {
  const source = \`import { State as S, Element, ForEach, defineView, initializer } from "@mun/core"
const items = S([{ id: "a", value: "A" }])
export const App = defineView("App", { initializers: [initializer("App()", args => args.length === 0)], body: () => Element("section", null, ForEach(items.value, item => Element("span", null, item.value))) })\`
  const output = transformMunSource(source, "AliasedStateCollection.mun.ts")
  assert.match(output, /ForEach\\.viewType\\.createNodeCompiled\\(0, \\[items, compiledCollectionContent/)
})`
const newAlias = `test("compiler recognizes aliased State constructors for keyed collection ownership", () => {
  const source = \`import { State as S, Element, ForEach, defineView, initializer } from "@mun/core"
const items = S([{ id: "a", value: "A" }])
export const App = defineView("App", { initializers: [initializer("App()", args => args.length === 0)], body: () => Element("section", null, ForEach(items.value, item => item.id, item => Element("span", null, item.value))) })\`
  const output = transformMunSource(source, "AliasedStateCollection.mun.ts")
  assert.match(output, /ForEach\\.viewType\\.createNodeCompiled\\(1, \\[items, item => item\\.id, compiledCollectionContent/)
})`
if (!tests.includes(oldAlias)) throw new Error('alias compiler test marker missing')
tests = tests.replace(oldAlias, newAlias)
tests += `

test("compiler keeps implicit-key State collections on the conservative parent-owned path", () => {
  const source = \`import { State, Element, ForEach, defineView, initializer } from "@mun/core"
const items = State([{ id: "a", value: "A" }])
export const App = defineView("App", { initializers: [initializer("App()", args => args.length === 0)], body: () => Element("section", null, ForEach(items.value, item => Element("span", null, item.value))) })\`
  const output = transformMunSource(source, "ImplicitStateCollection.mun.ts")
  assert.match(output, /ForEach\\.viewType\\.createNodeCompiled\\(0, \\[items\\.value, compiledCollectionContent/)
})
`
fs.writeFileSync(testPath, tests)

const webTestPath = 'tests/web-package.test.mjs'
let webTests = fs.readFileSync(webTestPath, 'utf8')
webTests += `

test("@mun/web lets a compiled keyed collection own its State subscription", async () => {
  const dom = new JSDOM("<div id=app></div>")
  const container = dom.window.document.querySelector("#app")
  assert.ok(container)
  const items = State([{ id: "a", value: "A" }, { id: "b", value: "B" }, { id: "c", value: "C" }])
  let parentRuns = 0
  let rowRuns = 0
  const content = compiledCollectionContent(item => Element("span", { "data-row": item.id }, item.value), {
    kind: "flat-text-host",
    indexIndependent: true,
    evaluateKey: item => item.id,
    evaluate: item => { rowRuns += 1; return { type: "span", props: { "data-row": item.id }, text: item.value } },
  })
  const App = defineView("OwnedCompiledCollectionApp", {
    initializers: [initializer("OwnedCompiledCollectionApp()", args => args.length === 0)],
    body: () => { parentRuns += 1; return Element("section", null, ForEach.viewType.createNodeCompiled(1, [items, item => item.id, content])) },
  })
  const unmount = mount(App(), container)
  assert.equal(parentRuns, 1)
  assert.equal(rowRuns, 3)
  rowRuns = 0
  const before = container.querySelector("[data-row=b]")
  items.value[1] = { id: "b", value: "B1" }
  await Promise.resolve(); await Promise.resolve()
  assert.equal(parentRuns, 1)
  assert.equal(rowRuns, 1)
  assert.strictEqual(container.querySelector("[data-row=b]"), before)
  assert.equal(container.querySelector("[data-row=b]")?.textContent, "B1")
  unmount()
  dom.window.close()
})
`
fs.writeFileSync(webTestPath, webTests)

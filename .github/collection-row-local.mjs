import fs from 'node:fs'

const replace = (path, before, after) => {
  let source = fs.readFileSync(path, 'utf8')
  if (!source.includes(before)) throw new Error(`marker missing in ${path}: ${before.slice(0, 120)}`)
  source = source.replace(before, after)
  fs.writeFileSync(path, source)
}

const domPath = 'packages/web/src/dom.ts'

replace(domPath,
`interface DomCollectionRow {
  readonly entryKey: string
  readonly key: string | number
  readonly item: unknown
  readonly index: number`,
`interface DomCollectionRow {
  readonly entryKey: string
  readonly baseKey: string
  readonly displayKey: string
  readonly occurrence: number
  readonly key: string | number
  readonly item: unknown
  readonly index: number`)

replace(domPath,
`  rows: Map<string, DomCollectionRow>
  order: DomCollectionRow[]
  pendingTransaction?: Transaction`,
`  rows: Map<string, DomCollectionRow>
  order: DomCollectionRow[]
  rowsByItem: Map<object, Set<DomCollectionRow>>
  pendingTransaction?: Transaction`)

replace(domPath,
`function collectionSourceIdentity(node: KeyedCollectionViewNode): unknown {
  const source = isStateRef(node.source)
    ? collectStateReads(() => (node.source as StateRef<unknown>).value, () => undefined)
    : node.source
  return reactiveIdentity(source)
}

function subscribeDomCollection`,
`function collectionSourceIdentity(node: KeyedCollectionViewNode): unknown {
  const source = isStateRef(node.source)
    ? collectStateReads(() => (node.source as StateRef<unknown>).value, () => undefined)
    : node.source
  return reactiveIdentity(source)
}

function collectionRowItemIdentity(item: unknown): object | undefined {
  const identity = reactiveIdentity(item)
  return identity && typeof identity === "object" ? identity : undefined
}

function indexCollectionRowsByItem(rows: readonly DomCollectionRow[]): Map<object, Set<DomCollectionRow>> {
  const result = new Map<object, Set<DomCollectionRow>>()
  for (const row of rows) {
    const identity = collectionRowItemIdentity(row.item)
    if (!identity) continue
    const entries = result.get(identity) ?? new Set<DomCollectionRow>()
    entries.add(row)
    result.set(identity, entries)
  }
  return result
}

function replaceIndexedCollectionRow(instance: DomCollectionInstance, previous: DomCollectionRow, next: DomCollectionRow): void {
  const previousIdentity = collectionRowItemIdentity(previous.item)
  if (previousIdentity) {
    const rows = instance.rowsByItem.get(previousIdentity)
    rows?.delete(previous)
    if (rows?.size === 0) instance.rowsByItem.delete(previousIdentity)
  }
  const nextIdentity = collectionRowItemIdentity(next.item)
  if (nextIdentity) {
    const rows = instance.rowsByItem.get(nextIdentity) ?? new Set<DomCollectionRow>()
    rows.add(next)
    instance.rowsByItem.set(nextIdentity, rows)
  }
  instance.rows.set(next.entryKey, next)
  instance.order[next.index] = next
}

function collectionRawSourceArray(node: KeyedCollectionViewNode): readonly unknown[] | undefined {
  if (!isStateRef(node.source)) return undefined
  const current = collectStateReads(() => (node.source as StateRef<unknown>).value, () => undefined)
  const raw = reactiveIdentity(current)
  try { return Array.isArray(raw) ? raw as readonly unknown[] : undefined } catch { return undefined }
}

function dataArrayLength(source: readonly unknown[]): number | undefined {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(source, "length")
    return descriptor && "value" in descriptor && Number.isSafeInteger(descriptor.value) && descriptor.value >= 0
      ? descriptor.value as number
      : undefined
  } catch { return undefined }
}

function dataArrayItem(source: readonly unknown[], index: number): unknown | typeof missingCollectionItem {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(source, String(index))
    return descriptor && "value" in descriptor ? descriptor.value : missingCollectionItem
  } catch { return missingCollectionItem }
}

const missingCollectionItem = Symbol("mun.collection.missing-item")

function collectionArrayIndex(property: PropertyKey | undefined): number | undefined {
  if (typeof property === "number") return Number.isSafeInteger(property) && property >= 0 ? property : undefined
  if (typeof property !== "string" || property.length === 0) return undefined
  const index = Number(property)
  return Number.isSafeInteger(index) && index >= 0 && String(index) === property ? index : undefined
}

interface LocalCollectionPatch {
  readonly previous: DomCollectionRow
  readonly next: DomCollectionRow
  readonly plan: FlatKeyedHostRow
}

/**
 * Fast path for compiler-owned keyed collections. A non-structural array index
 * replacement or direct row-object mutation can be proven and committed
 * without snapshotting or keying the rest of the collection.
 *
 * undefined means the mutation needs the generic collection reconcile; false
 * means the direct DOM capability itself was lost and the owning View boundary
 * should take over.
 */
function patchLocalCompiledCollectionMutations(
  instance: DomCollectionInstance,
  node: KeyedCollectionViewNode,
  parent: Node,
  mutations: readonly StateMutation[],
  context: DomRenderContext,
): boolean | undefined {
  if (!node.compiled?.evaluateKey || !node.readItems || !isStateRef(node.source) || mutations.length === 0) return undefined
  const source = collectionRawSourceArray(node)
  const length = source ? dataArrayLength(source) : undefined
  if (!source || length !== instance.order.length) return undefined

  const candidates = new Map<string, { readonly row: DomCollectionRow; readonly item: unknown; readonly index: number }>()
  const sourceIdentity = instance.sourceIdentity
  for (const mutation of mutations) {
    const target = mutation.target ? reactiveIdentity(mutation.target) : undefined
    if (target && Object.is(target, sourceIdentity)) {
      if (mutation.kind !== "set" && mutation.kind !== "define") return undefined
      const index = collectionArrayIndex(mutation.property)
      if (index === undefined || index >= length) return undefined
      const item = dataArrayItem(source, index)
      const row = instance.order[index]
      if (item === missingCollectionItem || !row || row.index !== index) return undefined
      candidates.set(row.entryKey, { row, item, index })
      continue
    }
    if (target && typeof target === "object") {
      const rows = instance.rowsByItem.get(target)
      if (!rows || rows.size === 0) return undefined
      for (const row of rows) candidates.set(row.entryKey, { row, item: row.item, index: row.index })
      continue
    }
    return undefined
  }
  if (candidates.size === 0) return undefined

  const staged: LocalCollectionPatch[] = []
  for (const candidate of candidates.values()) {
    const { row, item, index } = candidate
    const resolved = node.key(item, index)
    if (!resolved || resolved.identity !== row.baseKey) return undefined
    const entry: KeyedCollectionEntry = {
      key: row.entryKey,
      baseKey: row.baseKey,
      displayKey: resolved.display,
      occurrence: row.occurrence,
      item,
      index,
    }
    const plan = directCollectionHostRow(node, entry)
    if (!plan || plan.key !== row.key || plan.type.toLowerCase() !== row.type.toLowerCase()) return false
    const content = domContentContainer(row.element)
    if (row.element.parentNode !== parent || row.element.namespaceURI !== HTML_NS
      || content?.childNodes.length !== 1 || content.firstChild !== row.textNode || row.textNode.nodeType !== 3) return false
    staged.push({
      previous: row,
      plan,
      next: {
        entryKey: row.entryKey,
        baseKey: row.baseKey,
        displayKey: resolved.display,
        occurrence: row.occurrence,
        key: plan.key,
        item,
        index,
        type: plan.type,
        props: plan.props,
        textValue: plan.text,
        element: row.element,
        textNode: row.textNode,
      },
    })
  }

  for (const patch of staged) {
    patchDomProps(patch.previous.element, patch.plan.props, context)
    if (patch.previous.textNode.nodeValue !== patch.plan.text) patch.previous.textNode.nodeValue = patch.plan.text
    replaceIndexedCollectionRow(instance, patch.previous, patch.next)
  }
  instance.node = node
  instance.sourceIdentity = sourceIdentity
  return true
}

function subscribeDomCollection`)

replace(domPath,
`        if (parent) patched = withRenderTransaction(renderTransaction, () => patchPersistentCollection(instance, instance.node, parent, pending, context))`,
`        if (parent) patched = withRenderTransaction(renderTransaction, () => {
          const local = patchLocalCompiledCollectionMutations(instance, instance.node, parent, pending, context)
          return local ?? patchPersistentCollection(instance, instance.node, parent, pending, context)
        })`)

replace(domPath,
`    const row: DomCollectionRow = {
      entryKey: entry.key,
      key: plan.key,`,
`    const row: DomCollectionRow = {
      entryKey: entry.key,
      baseKey: entry.baseKey,
      displayKey: entry.displayKey,
      occurrence: entry.occurrence,
      key: plan.key,`)

replace(domPath,
`    rows,
    order,
    pendingMutations: [],`,
`    rows,
    order,
    rowsByItem: indexCollectionRowsByItem(order),
    pendingMutations: [],`)

// The full reconcile builds the same richer row record and refreshes the
// identity index so later local mutations stay O(changed rows).
replace(domPath,
`    const row: DomCollectionRow = {
      entryKey: item.entry.key,
      key: item.plan.key,`,
`    const row: DomCollectionRow = {
      entryKey: item.entry.key,
      baseKey: item.entry.baseKey,
      displayKey: item.entry.displayKey,
      occurrence: item.entry.occurrence,
      key: item.plan.key,`)

replace(domPath,
`  instance.rows = nextRows
  instance.order = order
  return true`,
`  instance.rows = nextRows
  instance.order = order
  instance.rowsByItem = indexCollectionRowsByItem(order)
  return true`)

// Strengthen the ownership regression with evaluator/key counts for both a
// direct array replacement and a direct row-object mutation.
const testPath = 'tests/web-package.test.mjs'
let tests = fs.readFileSync(testPath, 'utf8')
const testName = 'test("@mun/web lets a compiled keyed collection own its State subscription", async () => {'
const start = tests.indexOf(testName)
if (start < 0) throw new Error('collection ownership regression not found')
const end = tests.indexOf('\n})', start)
if (end < 0) throw new Error('collection ownership regression end not found')
const old = tests.slice(start, end + 3)
const next = `test("@mun/web lets a compiled keyed collection own its State subscription", async () => {
  const dom = new JSDOM("<div id=app></div>")
  const container = dom.window.document.querySelector("#app")
  assert.ok(container)
  const items = State([{ id: "a", value: "A" }, { id: "b", value: "B" }, { id: "c", value: "C" }])
  let parentRuns = 0
  let rowRuns = 0
  let keyRuns = 0
  const content = compiledCollectionContent(item => Element("span", { "data-row": item.id }, item.value), {
    kind: "flat-text-host",
    indexIndependent: true,
    evaluateKey: item => { keyRuns += 1; return item.id },
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
  keyRuns = 0
  const before = container.querySelector("[data-row=b]")
  items.value[1] = { id: "b", value: "B1" }
  await Promise.resolve(); await Promise.resolve()
  assert.equal(parentRuns, 1)
  assert.equal(rowRuns, 1)
  assert.equal(keyRuns, 1)
  assert.strictEqual(container.querySelector("[data-row=b]"), before)
  assert.equal(container.querySelector("[data-row=b]")?.textContent, "B1")

  rowRuns = 0
  keyRuns = 0
  items.value[1].value = "B2"
  await Promise.resolve(); await Promise.resolve()
  assert.equal(parentRuns, 1)
  assert.equal(rowRuns, 1)
  assert.equal(keyRuns, 1)
  assert.strictEqual(container.querySelector("[data-row=b]"), before)
  assert.equal(container.querySelector("[data-row=b]")?.textContent, "B2")

  unmount()
  dom.window.close()
})`
tests = tests.slice(0, start) + next + tests.slice(end + 3)
fs.writeFileSync(testPath, tests)

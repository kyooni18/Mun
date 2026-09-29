import fs from 'node:fs'

const path = 'packages/web/src/dom.ts'
let source = fs.readFileSync(path, 'utf8')
const replace = (before, after) => {
  if (!source.includes(before)) throw new Error(`marker missing: ${before.slice(0, 100)}`)
  source = source.replace(before, after)
}

const localEnd = `  instance.node = node
  instance.sourceIdentity = sourceIdentity
  return true
}

function subscribeDomCollection`
const structural = `  instance.node = node
  instance.sourceIdentity = sourceIdentity
  return true
}

function removeCollectionRowFromItemIndex(instance: DomCollectionInstance, row: DomCollectionRow): void {
  const identity = collectionRowItemIdentity(row.item)
  if (!identity) return
  const rows = instance.rowsByItem.get(identity)
  rows?.delete(row)
  if (rows?.size === 0) instance.rowsByItem.delete(identity)
}

function appendCollectionRowToItemIndex(instance: DomCollectionInstance, row: DomCollectionRow): void {
  const identity = collectionRowItemIdentity(row.item)
  if (!identity) return
  const rows = instance.rowsByItem.get(identity) ?? new Set<DomCollectionRow>()
  rows.add(row)
  instance.rowsByItem.set(identity, rows)
}

/**
 * Structural fast paths for compiler-proven keyed collections. These handle
 * operations whose exact semantic effect is known from the State mutation
 * journal. Everything else falls through to the generic keyed reconcile.
 */
function patchStructuralCompiledCollectionMutation(
  instance: DomCollectionInstance,
  node: KeyedCollectionViewNode,
  parent: Node,
  mutations: readonly StateMutation[],
  context: DomRenderContext,
): boolean | undefined {
  if (!node.compiled?.evaluateKey || !node.readItems || !isStateRef(node.source) || mutations.length !== 1) return undefined
  const mutation = mutations[0]
  if (mutation.kind !== "array" || !mutation.target || !Object.is(reactiveIdentity(mutation.target), instance.sourceIdentity)) return undefined
  const source = collectionRawSourceArray(node)
  const length = source ? dataArrayLength(source) : undefined
  if (!source || length === undefined) return undefined

  if (mutation.method === "pop") {
    if (instance.order.length === 0 || length !== instance.order.length - 1) return undefined
    const row = instance.order[instance.order.length - 1]
    if (!row || row.element.parentNode !== parent) return false
    instance.order.pop()
    instance.rows.delete(row.entryKey)
    removeCollectionRowFromItemIndex(instance, row)
    removeNodeBatch(parent, [row.element], context)
    instance.node = node
    return true
  }

  if (mutation.method === "push") {
    const added = mutation.arguments ?? []
    if (added.length === 0) return true
    const start = instance.order.length
    if (start === 0 || length !== start + added.length) return undefined
    const occurrenceCounts = new Map<string, number>()
    for (const row of instance.order) occurrenceCounts.set(row.baseKey, Math.max(occurrenceCounts.get(row.baseKey) ?? 0, row.occurrence + 1))
    const staged: Array<{ readonly entry: KeyedCollectionEntry; readonly plan: FlatKeyedHostRow; readonly item: unknown }> = []
    const actualKeys = new Set(instance.order.map(row => row.key))
    for (let offset = 0; offset < added.length; offset += 1) {
      const index = start + offset
      const item = dataArrayItem(source, index)
      if (item === missingCollectionItem) return undefined
      const resolved = node.key(item, index)
      if (!resolved) return undefined
      const occurrence = occurrenceCounts.get(resolved.identity) ?? 0
      occurrenceCounts.set(resolved.identity, occurrence + 1)
      const entry: KeyedCollectionEntry = {
        key: keyedCollectionChildKey(resolved.identity, occurrence),
        baseKey: resolved.identity,
        displayKey: resolved.display,
        occurrence,
        item,
        index,
      }
      const plan = directCollectionHostRow(node, entry)
      if (!plan || actualKeys.has(plan.key)) return false
      actualKeys.add(plan.key)
      staged.push({ entry, plan, item })
    }
    for (const { entry, plan, item } of staged) {
      const element = createTaggedElement(context, plan.type)
      const textNode = context.document.createTextNode(plan.text)
      applyDomProps(element, plan.props, context)
      domContentContainer(element)?.appendChild(textNode)
      parent.appendChild(element)
      const row: DomCollectionRow = {
        entryKey: entry.key,
        baseKey: entry.baseKey,
        displayKey: entry.displayKey,
        occurrence: entry.occurrence,
        key: plan.key,
        item,
        index: entry.index,
        type: plan.type,
        props: plan.props,
        textValue: plan.text,
        element,
        textNode,
      }
      instance.order.push(row)
      instance.rows.set(row.entryKey, row)
      appendCollectionRowToItemIndex(instance, row)
      if (entry.occurrence > 0) node.onDuplicateKey?.(entry.displayKey, entry.occurrence)
    }
    instance.node = node
    return true
  }

  if (mutation.method === "reverse") {
    const count = instance.order.length
    if (!node.compiled.indexIndependent || length !== count || count < 2) return undefined
    const unique = new Set(instance.order.map(row => row.baseKey))
    if (unique.size !== count) return undefined
    for (let index = 0; index < count; index += 1) {
      const item = dataArrayItem(source, index)
      const expected = instance.order[count - index - 1]
      if (item === missingCollectionItem || !expected || !Object.is(collectionRowItemIdentity(item), collectionRowItemIdentity(expected.item))) return undefined
    }
    const nextOrder = new Array<DomCollectionRow>(count)
    const nextRows = new Map<string, DomCollectionRow>()
    for (let index = 0; index < count; index += 1) {
      const previous = instance.order[count - index - 1]
      const next: DomCollectionRow = { ...previous, index }
      nextOrder[index] = next
      nextRows.set(next.entryKey, next)
      parent.appendChild(next.element)
    }
    instance.order = nextOrder
    instance.rows = nextRows
    instance.rowsByItem = indexCollectionRowsByItem(nextOrder)
    instance.node = node
    return true
  }

  return undefined
}

function subscribeDomCollection`
replace(localEnd, structural)

const call = `          const local = patchLocalCompiledCollectionMutations(instance, instance.node, parent, pending, context)
          return local ?? patchPersistentCollection(instance, instance.node, parent, pending, context)`
replace(call, `          const local = patchLocalCompiledCollectionMutations(instance, instance.node, parent, pending, context)
          if (local !== undefined) return local
          const structural = patchStructuralCompiledCollectionMutation(instance, instance.node, parent, pending, context)
          return structural ?? patchPersistentCollection(instance, instance.node, parent, pending, context)`)

fs.writeFileSync(path, source)

const testPath = 'tests/web-package.test.mjs'
let tests = fs.readFileSync(testPath, 'utf8')
tests += `

test("@mun/web executes push pop and reverse without reevaluating stable compiled rows", async () => {
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
  const App = defineView("StructuralCompiledCollectionApp", {
    initializers: [initializer("StructuralCompiledCollectionApp()", args => args.length === 0)],
    body: () => { parentRuns += 1; return Element("section", null, ForEach.viewType.createNodeCompiled(1, [items, item => item.id, content])) },
  })
  const unmount = mount(App(), container)
  const a = container.querySelector("[data-row=a]")
  const b = container.querySelector("[data-row=b]")
  const c = container.querySelector("[data-row=c]")
  assert.equal(parentRuns, 1)

  rowRuns = 0
  keyRuns = 0
  items.value.push({ id: "d", value: "D" })
  await Promise.resolve(); await Promise.resolve()
  assert.equal(parentRuns, 1)
  assert.equal(rowRuns, 1)
  assert.equal(keyRuns, 1)
  assert.deepEqual([...container.querySelectorAll("span")].map(node => node.textContent), ["A", "B", "C", "D"])
  assert.strictEqual(container.querySelector("[data-row=a]"), a)

  rowRuns = 0
  keyRuns = 0
  items.value.pop()
  await Promise.resolve(); await Promise.resolve()
  assert.equal(parentRuns, 1)
  assert.equal(rowRuns, 0)
  assert.equal(keyRuns, 0)
  assert.equal(container.querySelector("[data-row=d]"), null)

  rowRuns = 0
  keyRuns = 0
  items.value.reverse()
  await Promise.resolve(); await Promise.resolve()
  assert.equal(parentRuns, 1)
  assert.equal(rowRuns, 0)
  assert.equal(keyRuns, 0)
  assert.deepEqual([...container.querySelectorAll("span")].map(node => node.textContent), ["C", "B", "A"])
  assert.strictEqual(container.querySelector("[data-row=a]"), a)
  assert.strictEqual(container.querySelector("[data-row=b]"), b)
  assert.strictEqual(container.querySelector("[data-row=c]"), c)

  unmount()
  dom.window.close()
})
`
fs.writeFileSync(testPath, tests)
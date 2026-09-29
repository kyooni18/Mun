import assert from 'node:assert/strict'
import test from 'node:test'
import { JSDOM } from 'jsdom'
import { act, createContext, createElement, createRef, useContext } from 'react'
import { createRoot, hydrateRoot } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import {
  Alert,
  Button,
  ElementRef,
  Menu,
  Sheet,
  State,
  Text,
  TextField,
  VStack,
  view,
} from '../dist/legacy.js'
import { GeometryReader, Text as CanonicalText, mount as canonicalMount, render as canonicalRender, useMunState, view as canonicalView } from '../packages/react/dist/index.js'
import { ForEach, State as CanonicalState, defineView, initializer, viewElement } from '../packages/core/dist/compat.js'
import { compiledCollectionContent } from '../packages/core/dist/internal-runtime.js'

function installDOM() {
  const dom = new JSDOM('<!doctype html><html><body><main id="root"></main></body></html>', {
    url: 'http://localhost/',
  })
  const previous = new Map()
  for (const name of ['window', 'document', 'HTMLElement', 'Node', 'MutationObserver', 'getComputedStyle']) {
    previous.set(name, globalThis[name])
    globalThis[name] = name === 'getComputedStyle' ? dom.window.getComputedStyle : dom.window[name]
  }
  previous.set('navigator', globalThis.navigator)
  Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator })
  previous.set('IS_REACT_ACT_ENVIRONMENT', globalThis.IS_REACT_ACT_ENVIRONMENT)
  globalThis.IS_REACT_ACT_ENVIRONMENT = true

  return () => {
    dom.window.close()
    for (const [name, value] of previous) {
      if (name === 'navigator') Object.defineProperty(globalThis, name, { configurable: true, value })
      else if (value === undefined) delete globalThis[name]
      else globalThis[name] = value
    }
  }
}

test('State-driven views rerender and controlled inputs update in JSDOM', async () => {
  const restore = installDOM()
  try {
    const App = view({
      state: () => ({ count: State(0), name: State('') }),
      body: ({ count, name }) => VStack(
        Text(() => `Count: ${count.value}`),
        Button('Increment', () => { count.value += 1 }),
        TextField(name, { 'aria-label': 'Name' }),
      ),
    })
    const root = createRoot(document.getElementById('root'))
    await act(async () => { root.render(createElement(App)) })
    assert.match(document.body.textContent, /Count: 0/)

    await act(async () => {
      document.querySelector('button').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    })
    assert.match(document.body.textContent, /Count: 1/)

    const input = document.querySelector('input')
    input.value = 'Mun'
    await act(async () => {
      input.dispatchEvent(new window.Event('input', { bubbles: true }))
    })
    assert.equal(input.value, 'Mun')

    await act(async () => { root.unmount() })
    assert.equal(document.getElementById('root').textContent, '')
  } finally {
    restore()
  }
})

test('React consumes core keyed View identity for reorder and remount State semantics', async () => {
  const restore = installDOM()
  try {
    const items = State([{ id: 'a' }, { id: 'b' }])
    const Row = defineView('ReactIdentityRow', {
      initializers: [initializer('Row(id)', args => args.length === 1, args => ({ id: args[0] }))],
      state: () => ({ count: State(0) }),
      body: ({ id, count }) => viewElement('button', { 'data-row': id, onClick: () => { count.value += 1 } }, [`${id}:${count.value}`]),
    })
    const App = defineView('ReactIdentityApp', {
      initializers: [initializer('App()', args => args.length === 0)],
      body: () => viewElement('section', null, [ForEach(items.value, item => item.id, item => Row(item.id))]),
    })
    const root = createRoot(document.getElementById('root'))
    await act(async () => { root.render(canonicalRender(App())) })
    await act(async () => { document.querySelector('[data-row="a"]').dispatchEvent(new window.MouseEvent('click', { bubbles: true })) })
    assert.equal(document.querySelector('[data-row="a"]').textContent, 'a:1')
    await act(async () => { items.value = [items.value[1], items.value[0]] })
    assert.deepEqual([...document.querySelectorAll('button')].map(button => button.textContent), ['b:0', 'a:1'])
    await act(async () => { items.value = items.value.filter(item => item.id !== 'a') })
    await act(async () => { items.value = [{ id: 'a' }, ...items.value] })
    assert.equal(document.querySelector('[data-row="a"]').textContent, 'a:0')
    await act(async () => { root.unmount() })
  } finally {
    restore()
  }
})

test('React owns compiler-planned State collections without rebuilding the parent View graph', async () => {
  const restore = installDOM()
  try {
    const items = CanonicalState([{ id: 'a', value: 'A' }, { id: 'b', value: 'B' }])
    let parentRuns = 0
    let genericRuns = 0
    let rowRuns = 0
    const content = compiledCollectionContent(item => {
      genericRuns += 1
      return viewElement('span', { 'data-row': item.id }, [item.value])
    }, {
      kind: 'flat-text-host',
      indexIndependent: true,
      evaluateKey: item => item.id,
      evaluate: item => {
        rowRuns += 1
        return { type: 'span', props: { 'data-row': item.id, class: item.value, style: { opacity: item.id === 'a' ? 0.5 : 1 } }, text: item.value }
      },
    })
    const App = canonicalView(() => {
      parentRuns += 1
      return viewElement('section', null, [ForEach.viewType.createNodeCompiled(1, [items, item => item.id, content])])
    })
    const root = createRoot(document.getElementById('root'))
    await act(async () => { root.render(createElement(App)) })
    assert.equal(parentRuns, 1)
    assert.equal(genericRuns, 0)
    assert.equal(rowRuns, 2)
    const a = document.querySelector('[data-row="a"]')

    rowRuns = 0
    await act(async () => { items.value[1] = { id: 'b', value: 'B1' } })
    assert.equal(parentRuns, 1)
    assert.equal(genericRuns, 0)
    assert.equal(rowRuns, 1)
    assert.equal(document.querySelector('[data-row="b"]').textContent, 'B1')

    rowRuns = 0
    await act(async () => {
      const next = [...items.value]
      next[1] = { id: 'b', value: 'B2' }
      items.value = next
    })
    assert.equal(parentRuns, 1)
    assert.equal(genericRuns, 0)
    assert.equal(rowRuns, 1)
    assert.equal(document.querySelector('[data-row="b"]').textContent, 'B2')

    rowRuns = 0
    await act(async () => { items.value[0].value = 'A1' })
    assert.equal(parentRuns, 1)
    assert.equal(genericRuns, 0)
    assert.equal(rowRuns, 1)
    assert.equal(document.querySelector('[data-row="a"]').textContent, 'A1')

    rowRuns = 0
    await act(async () => { items.value.reverse() })
    assert.equal(parentRuns, 1)
    assert.equal(genericRuns, 0)
    assert.equal(rowRuns, 0)
    assert.deepEqual([...document.querySelectorAll('span')].map(node => node.textContent), ['B2', 'A1'])
    assert.strictEqual(document.querySelector('[data-row="a"]'), a)

    rowRuns = 0
    await act(async () => { items.value.push({ id: 'c', value: 'C' }) })
    assert.equal(rowRuns, 1)
    assert.deepEqual([...document.querySelectorAll('span')].map(node => node.textContent), ['B2', 'A1', 'C'])

    rowRuns = 0
    await act(async () => { items.value.pop() })
    assert.equal(rowRuns, 0)
    assert.deepEqual([...document.querySelectorAll('span')].map(node => node.textContent), ['B2', 'A1'])
    await act(async () => { root.unmount() })
  } finally {
    restore()
  }
})

test('React prunes conservative declared State dependencies owned by compiled collections', async () => {
  const restore = installDOM()
  try {
    const items = CanonicalState([{ id: 'a', value: 'A' }, { id: 'b', value: 'B' }])
    let parentRuns = 0
    let rowRuns = 0
    const content = compiledCollectionContent(item => viewElement('span', { 'data-row': item.id }, [item.value]), {
      kind: 'flat-text-host',
      indexIndependent: true,
      evaluateKey: item => item.id,
      evaluate: item => { rowRuns += 1; return { type: 'span', props: { 'data-row': item.id }, text: item.value } },
    })
    const App = defineView('ReactDeclaredOwnedCollectionApp', {
      initializers: [initializer('App()', args => args.length === 0)],
      dependencies: () => [items],
      dependenciesComplete: true,
      body: () => {
        parentRuns += 1
        return viewElement('section', null, [ForEach.viewType.createNodeCompiled(1, [items, item => item.id, content])])
      },
    })
    const root = createRoot(document.getElementById('root'))
    await act(async () => { root.render(canonicalRender(App())) })
    rowRuns = 0
    await act(async () => { items.value[1].value = 'B2' })
    assert.equal(parentRuns, 1)
    assert.equal(rowRuns, 1)
    assert.equal(document.querySelector('[data-row="b"]').textContent, 'B2')
    await act(async () => { root.unmount() })
  } finally {
    restore()
  }
})

test('React collection fallback keeps source and row State dependencies below the parent View', async () => {
  const restore = installDOM()
  try {
    const items = CanonicalState([{ id: 'a' }])
    const suffix = CanonicalState('0')
    let parentRuns = 0
    let rowRuns = 0
    const App = canonicalView(() => {
      parentRuns += 1
      return viewElement('section', null, [ForEach(items, item => item.id, item => {
        rowRuns += 1
        return viewElement('span', { 'data-row': item.id }, [`${item.id}:${suffix.value}`])
      })])
    })
    const root = createRoot(document.getElementById('root'))
    await act(async () => { root.render(createElement(App)) })
    assert.equal(parentRuns, 1)
    assert.equal(rowRuns, 1)
    assert.equal(document.querySelector('[data-row="a"]').textContent, 'a:0')

    await act(async () => { suffix.value = '1' })
    assert.equal(parentRuns, 1)
    assert.equal(rowRuns, 2)
    assert.equal(document.querySelector('[data-row="a"]').textContent, 'a:1')

    await act(async () => { items.value.push({ id: 'b' }) })
    assert.equal(parentRuns, 1)
    assert.equal(rowRuns, 4)
    assert.deepEqual([...document.querySelectorAll('span')].map(node => node.textContent), ['a:1', 'b:1'])
    await act(async () => { root.unmount() })
  } finally {
    restore()
  }
})

test('GeometryReader feeds measured host geometry back into the React graph', async () => {
  const restore = installDOM()
  window.getComputedStyle = () => ({ paddingTop: '12px', paddingRight: '8px', paddingBottom: '4px', paddingLeft: '2px' })
  const previousResizeObserver = globalThis.ResizeObserver
  globalThis.ResizeObserver = class {
    constructor(callback) { this.callback = callback }
    observe(element) {
      element.getBoundingClientRect = () => ({ x: 4, y: 8, width: 320, height: 48, top: 8, right: 324, bottom: 56, left: 4 })
      this.callback([])
    }
    disconnect() {}
  }
  try {
    const App = canonicalView(() => GeometryReader(geometry => CanonicalText(`${geometry.frame.x}:${geometry.size.width}:${geometry.safeAreaInsets.top}`)))
    const root = createRoot(document.getElementById('root'))
    await act(async () => { root.render(createElement(App)) })
    await act(async () => {})
    assert.match(document.body.textContent, /4:320:12/)
    await act(async () => { root.unmount() })
  } finally {
    if (previousResizeObserver === undefined) delete globalThis.ResizeObserver
    else globalThis.ResizeObserver = previousResizeObserver
    restore()
  }
})

test('GeometryReader falls back to zero geometry when layout measurement throws', async () => {
  const restore = installDOM()
  const previousResizeObserver = globalThis.ResizeObserver
  globalThis.ResizeObserver = class { constructor() { throw new Error('observer unavailable') } }
  const originalRect = window.HTMLElement.prototype.getBoundingClientRect
  window.HTMLElement.prototype.getBoundingClientRect = () => { throw new Error('layout unavailable') }
  try {
    const App = canonicalView(() => GeometryReader(geometry => CanonicalText(`${geometry.size.width}:${geometry.safeAreaInsets.top}`)))
    const root = createRoot(document.getElementById('root'))
    await act(async () => { root.render(createElement(App)) })
    await act(async () => {})
    assert.match(document.body.textContent, /0:0/)
    await act(async () => { root.unmount() })
  } finally {
    window.HTMLElement.prototype.getBoundingClientRect = originalRect
    if (previousResizeObserver === undefined) delete globalThis.ResizeObserver
    else globalThis.ResizeObserver = previousResizeObserver
    restore()
  }
})

test('canonical @mun/react graph output hydrates through the standard React boundary', async () => {
  const restore = installDOM()
  try {
    const container = document.getElementById('root')
    const Counter = defineView('ReactHydratedCounter', {
      initializers: [initializer('ReactHydratedCounter()', args => args.length === 0)],
      state: () => ({ count: State(0) }),
      body: ({ count }) => viewElement('button', {
        'data-counter': 'react',
        onclick: () => { count.value += 1 },
      }, [CanonicalText(`Hydrated ${count.value}`)]),
    })
    const value = Counter()
    container.innerHTML = renderToString(canonicalRender(value))
    const serverButton = container.querySelector('button')
    const recoverableErrors = []
    const root = hydrateRoot(container, canonicalRender(value), {
      onRecoverableError(error) { recoverableErrors.push(error) },
    })
    await act(async () => {})
    assert.equal(recoverableErrors.length, 0)
    assert.equal(container.querySelector('button'), serverButton)
    assert.equal(container.textContent, 'Hydrated 0')
    await act(async () => {
      serverButton.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    })
    assert.equal(container.textContent, 'Hydrated 1')
    await act(async () => { root.unmount() })
  } finally {
    restore()
  }
})

test('@mun/react mount owns a root and hydrates its graph boundary', async () => {
  const restore = installDOM()
  try {
    const container = document.getElementById('root')
    const value = CanonicalText('Mounted React')
    container.innerHTML = renderToString(canonicalRender(value))
    const unmount = canonicalMount(value, container, { hydrate: true })
    await act(async () => {})
    assert.equal(container.textContent, 'Mounted React')
    await act(async () => { unmount() })
    assert.equal(container.textContent, '')
  } finally {
    restore()
  }
})

test('useMunState is an explicit live bridge from core State into React', async () => {
  const restore = installDOM()
  try {
    const state = State('before')
    function Bridge() { return createElement('span', null, useMunState(state)) }
    const root = createRoot(document.getElementById('root'))
    await act(async () => { root.render(createElement(Bridge)) })
    assert.equal(document.body.textContent, 'before')
    await act(async () => { state.value = 'after' })
    assert.equal(document.body.textContent, 'after')
    await act(async () => { root.unmount() })
  } finally {
    restore()
  }
})

test('SSR markup hydrates without layout, State, or useId mismatches', async () => {
  const restore = installDOM()
  try {
    const App = view({
      state: () => ({ count: State(1), alert: State(true) }),
      body: ({ count, alert }) => VStack(
        Text(() => `Count: ${count.value}`).padding(4),
        Menu('Actions', Button('Refresh', () => undefined)),
        Alert(alert, { title: 'Hydrated alert', message: 'Portal content' }),
      ),
    })
    const container = document.getElementById('root')
    const markup = renderToString(createElement(App))
    container.innerHTML = markup
    const recoverableErrors = []
    const root = hydrateRoot(container, createElement(App), {
      onRecoverableError(error) { recoverableErrors.push(error) },
    })
    await act(async () => {})
    assert.equal(recoverableErrors.length, 0)
    assert.match(container.textContent, /Count: 1/)
    assert.ok(container.querySelector('[data-mun-menu]'))
    assert.ok(container.querySelector('[data-mun-layout-host]'))
    assert.equal(document.querySelectorAll('[role="alertdialog"]').length, 1)
    await act(async () => { root.unmount() })
  } finally {
    restore()
  }
})

test('Sheet closes on Escape, traps focus, and restores the opener', async () => {
  const restore = installDOM()
  try {
    const App = view({
      state: () => ({ presented: State(false) }),
      body: ({ presented }) => VStack(
        Button('Open', () => { presented.value = true }),
        Sheet(presented, VStack(
          Button('First', () => undefined),
          Button('Close', () => { presented.value = false }),
        ), {
          placement: 'center',
          ariaLabel: 'Demo sheet',
        }),
      ),
    })
    const root = createRoot(document.getElementById('root'))
    await act(async () => { root.render(createElement(App)) })
    const opener = document.querySelector('button')
    opener.focus()

    await act(async () => {
      opener.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    })
    const panel = document.querySelector('[data-mun-sheet]')
    assert.ok(panel)
    assert.equal(panel.getAttribute('role'), 'dialog')
    assert.equal(document.activeElement?.textContent, 'First')
    const sheetButtons = panel.querySelectorAll('button')
    sheetButtons[1].focus()
    await act(async () => {
      sheetButtons[1].dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    })
    assert.equal(document.activeElement, sheetButtons[0])

    await act(async () => {
      panel.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    assert.equal(document.querySelector('[data-mun-sheet]'), null)
    assert.equal(document.activeElement, opener)

    await act(async () => { root.unmount() })
  } finally {
    restore()
  }
})

test('stacked presentations keep the newest portal on top and close it first', async () => {
  const restore = installDOM()
  try {
    let stateRefs
    const App = view({
      state: () => {
        stateRefs = { outer: State(true), inner: State(false), alert: State(false) }
        return stateRefs
      },
      body: ({ outer, inner, alert }) => VStack(
        Sheet(outer, VStack(
          Button('Open nested', () => { inner.value = true }),
          Sheet(inner, Button('Nested close', () => { inner.value = false }), { placement: 'center' }),
        ), { placement: 'center', ariaLabel: 'Outer sheet' }),
        Alert(alert, { title: 'Alert', message: 'Top-level alert' }),
      ),
    })
    const root = createRoot(document.getElementById('root'))
    await act(async () => { root.render(createElement(App)) })
    const outerPanel = document.querySelector('[data-mun-sheet]')
    assert.ok(outerPanel)
    const openNested = [...outerPanel.querySelectorAll('button')].find(button => button.textContent === 'Open nested')
    await act(async () => {
      openNested.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    })
    const panels = document.querySelectorAll('[data-mun-sheet]')
    assert.equal(panels.length, 2)
    const backdrops = document.querySelectorAll('[data-mun-sheet-backdrop]')
    assert.equal(backdrops[0].style.zIndex, '1000')
    assert.equal(backdrops[1].style.zIndex, '1001')

    await act(async () => {
      panels[1].dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    assert.equal(document.querySelectorAll('[data-mun-sheet]').length, 1)
    assert.equal(stateRefs.outer.value, true)

    await act(async () => { stateRefs.alert.value = true })
    assert.equal(document.querySelectorAll('[role="alertdialog"]').length, 1)
    await act(async () => {
      document.querySelector('[role="alertdialog"] button').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    })
    assert.equal(stateRefs.alert.value, false)
    assert.equal(document.querySelectorAll('[data-mun-sheet]').length, 1)

    await act(async () => { root.unmount() })
  } finally {
    restore()
  }
})

test('Alert uses unique labelled IDs for simultaneously mounted dialogs', async () => {
  const restore = installDOM()
  try {
    const first = State(true)
    const second = State(true)
    const App = view(() => VStack(
      Alert(first, { title: 'First', message: 'First message' }),
      Alert(second, { title: 'Second', message: 'Second message' }),
    ))
    const root = createRoot(document.getElementById('root'))
    await act(async () => { root.render(createElement(App)) })
    const dialogs = document.querySelectorAll('[role="alertdialog"]')
    assert.equal(dialogs.length, 2)
    const labelledBy = [...dialogs].map(dialog => dialog.getAttribute('aria-labelledby'))
    const describedBy = [...dialogs].map(dialog => dialog.getAttribute('aria-describedby'))
    assert.equal(new Set(labelledBy).size, 2)
    assert.equal(new Set(describedBy).size, 2)
    for (const [index, dialog] of [...dialogs].entries()) {
      assert.equal(dialog.querySelectorAll('[role="dialog"]').length, 0)
      assert.ok(dialog.querySelector(`#${labelledBy[index]}`))
      assert.ok(dialog.querySelector(`#${describedBy[index]}`))
    }
    await act(async () => { root.unmount() })
  } finally {
    restore()
  }
})

test('client views switch State dependencies and preserve refs, context, and modifiers', async () => {
  const restore = installDOM()
  try {
    const Theme = createContext('missing')
    function ContextValue() {
      return createElement('span', { 'data-context': true }, useContext(Theme))
    }
    const buttonRef = createRef()
    let stateRefs
    let renders = 0
    const App = view({
      state: () => {
        stateRefs = { mode: State(false), first: State('first'), second: State('second') }
        return stateRefs
      },
      body: ({ mode, first, second }) => {
        renders += 1
        return createElement(
          Theme.Provider,
          { value: 'provided' },
          VStack(
            Text(() => mode.value ? first.value : second.value),
            createElement(ContextValue),
            ElementRef(buttonRef, Button('Switch', () => { mode.value = true })).padding(4),
          ),
        )
      },
    })
    const root = createRoot(document.getElementById('root'))
    await act(async () => { root.render(createElement(App)) })
    assert.match(document.body.textContent, /second/)
    assert.equal(document.querySelector('[data-context]').textContent, 'provided')
    assert.ok(buttonRef.current)
    assert.equal(buttonRef.current.style.padding, '4px')

    await act(async () => {
      document.querySelector('button').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    })
    assert.match(document.body.textContent, /first/)
    const rendersAfterSwitch = renders
    await act(async () => { stateRefs.second.value = 'unused' })
    assert.equal(renders, rendersAfterSwitch)
    await act(async () => { stateRefs.first.value = 'updated' })
    assert.match(document.body.textContent, /updated/)

    await act(async () => { root.unmount() })
  } finally {
    restore()
  }
})

test('dynamic State dependencies clean up across repeated branch switches', async () => {
  const restore = installDOM()
  try {
    let stateRefs
    let renders = 0
    const App = view({
      state: () => {
        stateRefs = { condition: State(false), first: State('first'), second: State('second') }
        return stateRefs
      },
      body: ({ condition, first, second }) => {
        renders += 1
        return VStack(
          Text(() => condition.value ? first.value : second.value),
          Button('Switch', () => { condition.value = !condition.value }),
        )
      },
    })
    const root = createRoot(document.getElementById('root'))
    await act(async () => { root.render(createElement(App)) })

    for (let index = 0; index < 6; index += 1) {
      const inactive = stateRefs.condition.value ? stateRefs.second : stateRefs.first
      const beforeInactiveMutation = renders
      inactive.value = `${inactive.value}-stale-${index}`
      assert.equal(renders, beforeInactiveMutation)

      await act(async () => {
        document.querySelector('button').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
      })
      assert.ok(renders > beforeInactiveMutation)
    }

    const rendersBeforeUnmount = renders
    await act(async () => { root.unmount() })
    stateRefs.first.value = 'after-unmount'
    stateRefs.second.value = 'after-unmount'
    assert.equal(renders, rendersBeforeUnmount)
  } finally {
    restore()
  }
})

test('Menu exposes keyboard-navigable menuitems', async () => {
  const restore = installDOM()
  try {
    const App = view(() => Menu(
      'Actions',
      Button('Disabled', () => undefined, { disabled: true }),
      Button('Edit', () => undefined),
      Button('Delete', () => undefined),
    ))
    const root = createRoot(document.getElementById('root'))
    await act(async () => { root.render(createElement(App)) })
    const details = document.querySelector('details')
    details.setAttribute('open', '')
    details.dispatchEvent(new window.Event('toggle', { bubbles: false }))
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    const summary = details.querySelector('summary')
    assert.equal(document.activeElement?.textContent, 'Edit')
    await act(async () => {
      summary.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    })
    assert.equal(document.activeElement?.textContent, 'Delete')
    assert.equal(details.querySelectorAll('[role="menuitem"]').length, 3)
    await act(async () => {
      document.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'End', bubbles: true }))
    })
    assert.equal(document.activeElement?.textContent, 'Delete')
    await act(async () => {
      document.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Home', bubbles: true }))
    })
    assert.equal(document.activeElement?.textContent, 'Edit')
    await act(async () => {
      document.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'e', bubbles: true }))
    })
    assert.equal(document.activeElement?.textContent, 'Edit')

    await act(async () => {
      document.activeElement.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    })
    assert.equal(details.open, false)
    assert.equal(document.activeElement, summary)

    await act(async () => {
      details.setAttribute('open', '')
      details.dispatchEvent(new window.Event('toggle', { bubbles: false }))
    })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    assert.equal(document.activeElement?.textContent, 'Edit')
    await act(async () => {
      document.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Tab', bubbles: true }))
    })
    assert.equal(details.open, false)

    await act(async () => {
      details.setAttribute('open', '')
      details.dispatchEvent(new window.Event('toggle', { bubbles: false }))
    })
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)) })
    await act(async () => {
      document.activeElement.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    })
    assert.equal(details.open, false)
    assert.equal(document.activeElement, summary)

    await act(async () => { root.unmount() })
  } finally {
    restore()
  }
})

import assert from 'node:assert/strict'
import test from 'node:test'
import { Fragment, createElement, forwardRef, memo } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  Component,
  Group,
  HStack,
  Raw,
  Spacer,
  State,
  Text,
  VStack,
  view,
} from '../dist/legacy.js'
import { subscribeState } from '../dist/state.js'

function Badge({ label }) {
  return createElement('strong', null, label)
}

const MemoBadge = memo(Badge)
const ForwardBadge = forwardRef(function ForwardBadge({ label }, ref) {
  return createElement('strong', { ref }, label)
})

test('renders coordinate-free stack layout', () => {
  const html = renderToStaticMarkup(
    HStack(Text('Left'), Spacer(), Text('Right')).frame({ maxWidth: 'infinity' }),
  )
  assert.match(html, /display:flex/)
  assert.match(html, /width:100%/)
  assert.match(html, /flex-grow:1/)
})

test('VStack uses the available width when its dimensions are measured', () => {
  const html = renderToStaticMarkup(VStack(Text('Top'), Text('Bottom')))
  assert.match(html, /display:flex/)
  assert.match(html, /flex-direction:column/)
  assert.match(html, /width:100%/)
  assert.match(html, /box-sizing:border-box/)
  assert.match(html, /outline:none/)
})

test('Spacer preserves an explicit minimum length', () => {
  const html = renderToStaticMarkup(HStack(Text('Left'), Spacer(24), Text('Right')))
  assert.match(html, /flex-grow:1/)
  assert.match(html, /flex-shrink:0/)
  assert.match(html, /flex-basis:24px/)
})

test('hosts ordinary React components without passing layout styles into them', () => {
  const html = renderToStaticMarkup(
    HStack(Component(Badge, { label: 'React' }).padding(12)),
  )
  assert.match(html, /data-mun-layout-host/)
  assert.match(html, /padding:12px/)
  assert.match(html, /<strong>React<\/strong>/)
})

test('hosts memo, forwardRef, and direct React elements as first-class layout items', () => {
  const html = renderToStaticMarkup(
    HStack(
      createElement(MemoBadge, { label: 'Memo' }),
      createElement(ForwardBadge, { label: 'Forward' }),
      Raw(createElement(Badge, { label: 'Raw' })).padding(7),
    ),
  )

  assert.equal((html.match(/data-mun-layout-host/g) ?? []).length, 3)
  assert.match(html, /<strong>Memo<\/strong>/)
  assert.match(html, /<strong>Forward<\/strong>/)
  assert.match(html, /padding:7px/)
  assert.match(html, /<strong>Raw<\/strong>/)
})

test('normalizes transparent Group fragments before assigning layout hosts', () => {
  const html = renderToStaticMarkup(
    HStack(
      Group(
        Group(Component(Badge, { label: 'Grouped' }).padding(9)),
      ),
    ),
  )
  assert.equal((html.match(/data-mun-layout-host/g) ?? []).length, 1)
  assert.match(html, /padding:9px/)
  assert.match(html, /<strong>Grouped<\/strong>/)
})

test('normalizes nested keyed fragments, arrays, conditionals, and null children', () => {
  const html = renderToStaticMarkup(
    HStack(
      createElement(Fragment, { key: 'outer' },
        null,
        false,
        'prefix',
        createElement(Fragment, null,
          Component(Badge, { label: 'First' }),
          [null, Component(Badge, { label: 'Second' })],
        ),
        'suffix',
      ),
    ),
  )
  assert.equal((html.match(/data-mun-layout-host/g) ?? []).length, 2)
  assert.match(html, /prefix/)
  assert.match(html, /<strong>First<\/strong>/)
  assert.match(html, /<strong>Second<\/strong>/)
  assert.match(html, /suffix/)
})

test('composes simple class modifiers and conditional class values', () => {
  const html = renderToStaticMarkup(
    Text('Styled').className(['card', false && 'hidden']).className('featured'),
  )
  assert.match(html, /class="card featured"/)
})

test('supports CSS custom properties for advanced inline styling', () => {
  const html = renderToStaticMarkup(
    Text('Themed').style({ '--mun-accent': '#7c3aed', letterSpacing: '0.05em' }),
  )
  assert.match(html, /--mun-accent:#7c3aed/)
  assert.match(html, /letter-spacing:0\.05em/)
})

test('State subscriptions notify on changes, ignore identical values, and unsubscribe cleanly', () => {
  const count = State(0)
  let notifications = 0
  const unsubscribe = subscribeState(count, () => { notifications += 1 })

  count.value = 1
  count.value = 1
  assert.equal(notifications, 1)

  unsubscribe()
  count.value = 2
  assert.equal(notifications, 1)
})

test('State tracks array and nested plain-object mutations', () => {
  const todos = State([{ title: 'One', done: false }])
  let notifications = 0
  const unsubscribe = subscribeState(todos, () => { notifications += 1 })

  const stable = todos.value
  assert.equal(todos.value, stable)

  todos.value.push({ title: 'Two', done: false })
  const afterPush = notifications
  assert.ok(afterPush > 0)
  assert.equal(todos.value.length, 2)

  todos.value[0].done = true
  assert.ok(notifications > afterPush)
  const afterNestedChange = notifications

  todos.value[0].done = true
  assert.equal(notifications, afterNestedChange)

  delete todos.value[1].title
  assert.ok(notifications > afterNestedChange)

  const beforeSameRoot = notifications
  todos.value = stable
  assert.equal(notifications, beforeSameRoot)

  unsubscribe()
})

test('State observes array splice without coupling separate State containers', () => {
  const items = State([{ title: 'One' }, { title: 'Two' }])
  const other = State('stable')
  let itemNotifications = 0
  let otherNotifications = 0
  const unsubscribeItems = subscribeState(items, () => { itemNotifications += 1 })
  const unsubscribeOther = subscribeState(other, () => { otherNotifications += 1 })

  items.value.splice(0, 1)
  assert.equal(items.value.length, 1)
  assert.equal(items.value[0].title, 'Two')
  assert.ok(itemNotifications > 0)
  assert.equal(otherNotifications, 0)

  other.value = 'changed'
  assert.equal(otherNotifications, 1)
  assert.ok(itemNotifications > 0)

  unsubscribeItems()
  unsubscribeOther()
})

test('shared raw mutable objects notify every owning State container', () => {
  const raw = { count: 0, nested: { label: 'initial' } }
  const first = State(raw)
  const second = State(raw)
  let firstNotifications = 0
  let secondNotifications = 0
  const unsubscribeFirst = subscribeState(first, () => { firstNotifications += 1 })
  const unsubscribeSecond = subscribeState(second, () => { secondNotifications += 1 })

  first.value.count += 1
  assert.equal(first.value.count, 1)
  assert.equal(second.value.count, 1)
  assert.equal(firstNotifications, 1)
  assert.equal(secondNotifications, 1)

  second.value.nested.label = 'changed'
  assert.equal(first.value.nested.label, 'changed')
  assert.equal(firstNotifications, 2)
  assert.equal(secondNotifications, 2)

  unsubscribeFirst()
  unsubscribeSecond()
})

test('detaches stale nested owners when a State root is replaced', () => {
  const oldRaw = { nested: { count: 0 } }
  const state = State(oldRaw)
  let notifications = 0
  const unsubscribe = subscribeState(state, () => { notifications += 1 })
  const oldNested = state.value.nested

  state.value = { nested: { count: 10 } }
  const afterReplacement = notifications
  oldNested.count += 1
  oldRaw.nested.count += 1
  assert.equal(notifications, afterReplacement)

  state.value.nested.count += 1
  assert.equal(notifications, afterReplacement + 1)
  unsubscribe()
})

test('tracks shared nested objects across arrays and replacement cycles', () => {
  const shared = { label: 'initial' }
  const first = State({ shared })
  const second = State([shared])
  let firstNotifications = 0
  let secondNotifications = 0
  const unsubscribeFirst = subscribeState(first, () => { firstNotifications += 1 })
  const unsubscribeSecond = subscribeState(second, () => { secondNotifications += 1 })

  first.value.shared.label = 'changed'
  assert.equal(firstNotifications, 1)
  assert.equal(secondNotifications, 1)

  const oldObject = first.value.shared
  first.value = 0
  const afterPrimitive = firstNotifications
  oldObject.label = 'stale'
  assert.equal(firstNotifications, afterPrimitive)

  const replacement = { label: 'replacement' }
  first.value = replacement
  first.value.label = 'updated'
  assert.equal(firstNotifications, afterPrimitive + 2)

  first.value = { child: replacement }
  delete first.value.child
  replacement.label = 'detached'
  assert.equal(firstNotifications, afterPrimitive + 4)
  first.value = { child: replacement }
  first.value.child.label = 'reattached'
  assert.equal(firstNotifications, afterPrimitive + 6)

  unsubscribeFirst()
  unsubscribeSecond()
})

test('reconciles circular raw object graphs without recursive overflow', () => {
  const circular = { count: 0, self: null }
  circular.self = circular
  const state = State(circular)
  let notifications = 0
  const unsubscribe = subscribeState(state, () => { notifications += 1 })

  state.value.self.count = 1
  assert.equal(notifications, 1)
  unsubscribe()
})

test('view produces a renderable React component', () => {
  const App = view(() => VStack(Text('Hello Mun')))
  const html = renderToStaticMarkup(createElement(App))
  assert.match(html, /Hello Mun/)
})

test('view passes React props into its body', () => {
  const Greeting = view(({ name }) => Text(`Hello, ${name}`))
  const html = renderToStaticMarkup(createElement(Greeting, { name: 'Mun' }))
  assert.match(html, /Hello, Mun/)
})

test('view state factories are scoped to a component instance', () => {
  let factoryCalls = 0
  const App = view({
    state: () => {
      factoryCalls += 1
      return { count: State(2) }
    },
    body: ({ count }) => Text(`Count: ${count.value}`),
  })

  const html = renderToStaticMarkup(createElement(App))
  assert.match(html, /Count: 2/)
  assert.equal(factoryCalls, 1)
})

test('view state factories run independently for multiple instances', () => {
  let factoryCalls = 0
  const Counter = view({
    state: () => {
      factoryCalls += 1
      return { count: State(factoryCalls) }
    },
    body: ({ count }) => Text(`Count: ${count.value}`),
  })

  const html = renderToStaticMarkup(createElement('main', null,
    createElement(Counter),
    createElement(Counter),
  ))
  assert.equal(factoryCalls, 2)
  assert.match(html, /Count: 1/)
  assert.match(html, /Count: 2/)
})

test('view state factories can initialize from React props', () => {
  const Counter = view({
    state: ({ initial }) => ({ count: State(initial) }),
    body: ({ count }, { label }) => Text(`${label}: ${count.value}`),
  })

  const html = renderToStaticMarkup(createElement(Counter, { initial: 3, label: 'Count' }))
  assert.match(html, /Count: 3/)
})

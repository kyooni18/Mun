import { createElement } from 'react'
import {
  Button,
  createViewNode,
  Grid,
  Group,
  HStack,
  Spacer,
  State,
  Text,
  VStack,
  renderViewNode,
  type ModifiableViewNode,
  type MunRenderer,
} from '../packages/core/dist/compat.js'
import { Component, foreignComponent, reactComponent, view } from '../packages/react/src/index.js'

Text.viewType.name
VStack.viewType.name
Button.viewType.name
Group.viewType.name

function Badge(props: { label: string }) {
  return createElement('strong', null, props.label)
}

const count = State(0)
const custom: ModifiableViewNode = Component(Badge, { label: 'React' }).padding(8)
const AdaptedBadge = reactComponent(Badge)
const GenericBadge = foreignComponent(Badge)
AdaptedBadge({ label: 'React' })
GenericBadge({ label: 'React' })
// @ts-expect-error required React props must be supplied to Component()
Component(Badge)
// @ts-expect-error required React props must be supplied to an adapted component
AdaptedBadge({})
Text('Theme').style({ '--mun-accent': '#7c3aed' })
Text('Conditional').className(['card', false && 'featured'])

export const StaticView = view(() =>
  VStack(
    Text(`Count: ${count.value}`),
    Button('Add', () => { count.value += 1 }),
    HStack(Text('Left'), Spacer(), custom).frame({ maxWidth: 'infinity' }),
  ),
)

Grid(Text('One'), Text('Two'))
Grid({ columns: 2 }, () => Text('Builder'))
VStack({ spacing: 8 }, () => Text('Optioned builder'))
Group(() => [Text('Grouped one'), Text('Grouped two')])

// @ts-expect-error Text initializer accepts only string or number values
Text({ invalid: true })
// @ts-expect-error Button requires a declared action closure form
Button('Missing action')
// @ts-expect-error Button titles cannot be arbitrary objects
Button({ title: 'Invalid' }, () => undefined)

const graphRenderer: MunRenderer<{ kind: 'node'; type: unknown; children: unknown[] }> = {
  element(type, _props, ...children) { return { kind: 'node', type, children } },
  fragment(children) { return { kind: 'node', type: 'fragment', children: [...children] } },
  modifier(content) { return content },
}
renderViewNode(createViewNode(Text, ['typed graph']), graphRenderer)

export const ScopedView = view({
  state: () => ({ count: State(0) }),
  body: ({ count }) => VStack(
    Text(count.value),
    Button('Add', () => { count.value += 1 }),
  ),
})

export const GreetingView = view((props: { name: string }) =>
  Text(`Hello, ${props.name}`),
)

createElement(GreetingView, { name: 'Mun' })
// @ts-expect-error name is required
createElement(GreetingView, {})

type CounterProps = { initial: number; label: string }

export const PropScopedView = view({
  state: (props: CounterProps) => ({ count: State(props.initial) }),
  body: ({ count }, props) => Text(`${props.label}: ${count.value}`),
})

createElement(PropScopedView, { initial: 3, label: 'Count' })
// @ts-expect-error initial is required
createElement(PropScopedView, { label: 'Count' })

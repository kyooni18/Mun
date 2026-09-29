import {
  Button,
  Binding,
  Box,
  Circle,
  Alert,
  ContentTransition,
  Element,
  GeometryReader,
  Grid,
  HStack,
  Image,
  Link,
  Menu,
  NavigationLink,
  NavigationStack,
  Picker,
  ProgressView,
  Path,
  RoundedRectangle,
  SafeArea,
  Sheet,
  ScrollView,
  Slider,
  Spacer,
  State,
  SymbolEffect,
  Text,
  TextField,
  TextArea,
  Toggle,
  VStack,
  VectorSymbol,
  ZStack,
  namedArguments,
  type BindingRef,
  type ViewBuilderClosure,
  type ViewGraphValue,
} from '../packages/core/src/compat.js'
import { Svg } from '../packages/core/src/web-primitives.js'

const bigintLeaf: ViewGraphValue = 1n
// @ts-expect-error arbitrary objects are not renderer-neutral View graph leaves
const objectLeaf: ViewGraphValue = { invalid: true }
// @ts-expect-error functions must enter the graph through a declared View closure or adapter
const functionLeaf: ViewGraphValue = () => undefined
// @ts-expect-error symbols are not renderable View graph leaves
const symbolLeaf: ViewGraphValue = Symbol('invalid')

Text('Mun')
Text(1)
VStack(() => Text('Builder'))
VStack({ alignment: 'leading', spacing: 8 }, () => Text('Options'))
VStack({ alignment: 'stretch' }, () => Text('Stretch'))
VStack(Text('A'), Text('B'))
HStack({ alignment: 'bottom', spacing: 6 }, Text('A'), Spacer(12), Text('B'))
HStack({ alignment: 'stretch' }, Text('Stretch'))
ZStack({ alignment: 'topTrailing' }, Text('Overlay'))
ScrollView('both', () => Text('Scrollable'))
SafeArea(['top', 'left'], () => Text('Inset'))
GeometryReader(geometry => Text(geometry.size.width))
Text('Frame').frame({ minWidth: 120, maxWidth: 'infinity', height: '3rem', alignment: 'center' })
Text('Ideal frame').frame({ idealWidth: 100, idealHeight: 44 })
Text('Styled').foreground('CanvasText').background('Canvas').style({ borderRadius: 8, '--mun-accent': '#7c3aed' })
// @ts-expect-error inline style names are checked while CSS custom properties stay extensible
Text('Invalid style').style({ colro: 'tomato' })
Element('button', { onPointerMove: event => event.preventDefault?.(), onKeyDown: event => event.currentTarget?.key })
// @ts-expect-error standard HTML event names are checked
Element('button', { onClic: () => undefined })
Element('mun-chart', { onAnything: () => undefined, 'data-series': 'revenue', 'aria-label': 'Chart' })
Button('Save', () => undefined)
Button(namedArguments({ action: () => undefined, label: () => Text('Label') }))
const count = State(0)
const countBinding = Binding(count)
const enabled = State(false)
const name = State('Mun')
const selection = State<'one' | 'two'>('one')
Toggle('Enabled', Binding(enabled))
TextField(Binding(name), 'Name')
TextArea(Binding(name), 'Description')
Slider(countBinding, { min: 0, max: 10, step: 1 })
Image('/mun.png', { alt: 'Mun' })
const statusSymbol = new VectorSymbol({
  name: 'status',
  viewBox: '0 0 24 24',
  layers: [{ id: 'shape', d: 'M2 2 L22 2 L22 22 L2 22 Z', fill: 'currentColor' }],
})
Image(statusSymbol, { alt: 'Status' })
  .contentTransition(ContentTransition.symbolEffect(SymbolEffect.magicReplace()))
  .animation()
const svgNodeSymbol = VectorSymbol.fromSVGNodes([
  ['circle', { cx: 12, cy: 12, r: 8, stroke: 'currentColor', fill: 'none' }],
  ['line', { x1: 6, y1: 6, x2: 18, y2: 18, stroke: 'currentColor', 'stroke-width': 2 }],
], { name: 'svg-node-symbol', viewBox: '0 0 24 24' })
Image(svgNodeSymbol).contentTransition(ContentTransition.symbolEffect(SymbolEffect.automatic)).animation()
const lucideLikeSymbol = VectorSymbol.fromLucide({
  name: 'standard-icon',
  size: 24,
  node: [['path', { d: 'M4 12 L20 12' }]],
})
Image(lucideLikeSymbol)
Text('Saved').contentTransition(ContentTransition.interpolate).animation()
Text('Saved').contentTransition(ContentTransition.blurReplace()).animation()
Text('Saved').contentTransition(ContentTransition.push('trailing')).animation()
Text('Saved').contentTransition(ContentTransition.scale(0.84)).animation()
Text('10').contentTransition(ContentTransition.numericText(10)).animation()
Svg('0 0 24 24', () => Path('M2 2 L22 22').animation())
Link('Docs', () => '/docs')
Box(() => Text('Box'))
Grid({ columns: 2 }, () => [Text('A'), Text('B')])
Circle()
RoundedRectangle('1rem')
Picker(Binding(selection), [{ label: 'One', value: 'one' }, { label: 'Two', value: 'two' }])
ProgressView(countBinding, { label: 'Loading', max: 10 })
NavigationStack(() => NavigationLink('/settings', 'Settings'))
Menu('Actions', () => Button('Save', () => undefined))
Sheet(Binding(enabled), () => Text('Sheet'))
Alert(Binding(enabled), 'Notice', 'Message')
Element('button', {
  type: 'submit',
  disabled: false,
  class: 'primary',
  'aria-label': 'Save',
  'data-testid': 'save',
  onclick: event => event.currentTarget?.value,
}, 'Save')
Element('input', { type: 'checkbox', checked: true, onchange: event => event.target?.checked })
Element('img', { src: '/mun.png', alt: 'Mun', loading: 'lazy' })
Element('x-card', { value: count.value, theme: 'dark', 'aria-label': 'Card' }, Text('Custom'))
const requiresBinding = (_value: BindingRef<number>) => undefined
requiresBinding(countBinding)
count.value = 1
// @ts-expect-error State and Binding are distinct writable contracts
requiresBinding(count)
// @ts-expect-error Binding preserves its generic value type
countBinding.value = 'one'
// @ts-expect-error Toggle requires a boolean Binding
Toggle('Invalid', countBinding)
// @ts-expect-error TextField requires a string Binding
TextField(countBinding)
// @ts-expect-error Slider options are numeric
Slider(countBinding, { min: 'zero' })
// @ts-expect-error Image options reject unknown properties
Image('/mun.png', { title: 'Invalid' })
// @ts-expect-error Link href must resolve to a string
Link('Invalid', 42)
// @ts-expect-error Grid options reject unknown keys
Grid({ columnCount: 2 }, Text('Invalid'))
// @ts-expect-error Grid builders must produce Views
Grid(() => 'not a View')
// @ts-expect-error RoundedRectangle radius is a CSS length
RoundedRectangle({ radius: 8 })
// @ts-expect-error Picker options must preserve the Binding value type
Picker(Binding(selection), [{ label: 'Three', value: 'three' }])
// @ts-expect-error ProgressView options reject unknown keys
ProgressView(0.5, { title: 'Invalid' })
// @ts-expect-error presentation visibility requires a boolean Binding
Sheet(countBinding, () => Text('Invalid'))
// @ts-expect-error NavigationLink destination must be a string
NavigationLink(42, 'Invalid')
// @ts-expect-error Menu content must be a ViewBuilder
Menu('Invalid', () => 'not a View')
// @ts-expect-error button does not expose anchor-only attributes
Element('button', { href: '/invalid' })
// @ts-expect-error checkbox state is boolean
Element('input', { checked: 'yes' })
// @ts-expect-error images require accessible alt text
Element('img', { src: '/missing-alt.png' })
// @ts-expect-error event attributes require handlers
Element('button', { onclick: 'save' })
// @ts-expect-error aria values must be serializable primitives
Element('section', { 'aria-label': { text: 'Invalid' } })
// @ts-expect-error misspelled standard attributes fail before runtime
Element('button', { disabledd: true })
// @ts-expect-error unknown standard tags are not custom elements
Element('notarealtag', null)

// @ts-expect-error Text initializer accepts only string or number values
Text({ invalid: true })
// @ts-expect-error ViewBuilder closures cannot produce primitive strings
const invalidBuilder: ViewBuilderClosure = () => 'not a View'
// @ts-expect-error VStack ViewBuilder closures must produce Mün Views
VStack(() => 'not a View')
// @ts-expect-error VStack alignment is a closed layout semantic
VStack({ alignment: 'baseline' }, () => Text('Invalid'))
// @ts-expect-error HStack alignment is vertical, not horizontal
HStack({ alignment: 'leading' }, () => Text('Invalid'))
// @ts-expect-error ScrollView axis is a closed semantic
ScrollView('diagonal', () => Text('Invalid'))
// @ts-expect-error SafeArea accepts only declared edges
SafeArea('horizontal', () => Text('Invalid'))
// @ts-expect-error Spacer accepts only a CSS length
Spacer({ minLength: 12 })
// @ts-expect-error frame rejects unknown layout properties
Text('Invalid').frame({ preferredWidth: 100 })
// @ts-expect-error frame alignment is a closed semantic
Text('Invalid').frame({ alignment: 'baseline' })
// @ts-expect-error foreground colors are CSS strings
Text('Invalid').foreground({ color: 'red' })
// @ts-expect-error inline CSS values must be serializable CSS primitives
Text('Invalid').style({ transform: { scale: 2 } })
// @ts-expect-error Button requires a declared action closure form
Button('Missing action')
// @ts-expect-error Button titles cannot be arbitrary objects
Button({ title: 'Invalid' }, () => undefined)

export { bigintLeaf, functionLeaf, invalidBuilder, objectLeaf, symbolLeaf }

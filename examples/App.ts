import {
  Binding,
  Button,
  HStack,
  ProgressView,
  Slider,
  Spacer,
  State,
  Text,
  TextField,
  Toggle,
  VStack,
} from '@mun/core/compat'
import { view } from '@mun/react'
import moduleStyles from './demo.module.css'

const codeSample = `const count = State(0)

VStack(
  Text('Hello, Mun'),
  Button('Count: ' + count.value, ...),
)`

function ComponentRow(label: string, content: any) {
  return HStack(
    { spacing: 12 },
    Text(label).className('object-name'),
    Spacer(),
    content,
  ).className('object-row')
}

export default view({
  state: () => ({
    text: State('Mun'),
    value: State(60),
    checked: State(true),
  }),
  body: ({ text, value, checked }) => VStack(
    { alignment: 'leading', spacing: 24 },
    Text('DEMO').className([moduleStyles.demoTitleModule, 'demo-title', 'text-slate-900']),
    Text('SwiftUI-like declarative UI for React.').className('demo-description'),
    Text(codeSample).className('code-sample'),
    VStack(
      { alignment: 'leading', spacing: 10 },
      Text('TextField').className('field-label'),
      TextField(Binding(text), 'Type here').withProps({ 'aria-label': 'Demo text field' }).className('demo-input'),
    ),
    VStack(
      { alignment: 'leading', spacing: 10 },
      HStack(
        { spacing: 12 },
        Text('Slider').className('field-label'),
        Spacer(),
        Text(String(value.value)).className('field-value'),
      ),
      Slider(Binding(value), { min: 0, max: 100, step: 1 }).withProps({ 'aria-label': 'Demo slider' }).className('demo-slider'),
    ),
    HStack(
      { spacing: 12 },
      Text('Checkbox').className('field-label').frame({ maxWidth: 'infinity' }),
      Toggle('Demo checkbox', Binding(checked)),
    ),
    VStack(
      { alignment: 'leading', spacing: 10 },
      Text('Components').className('section-label'),
      ComponentRow('Text', Text('Hello, Mun').className('object-preview')),
      ComponentRow('Button', Button('Button', () => {}).className('demo-button')),
      ComponentRow('ProgressView', ProgressView(0.7, { max: 1 }).withProps({ 'aria-label': 'Demo progress' }).className('object-progress')),
      ComponentRow('Toggle', Toggle('Component toggle', Binding(checked))),
    ).className('component-list'),
  ).className('demo-page'),
})

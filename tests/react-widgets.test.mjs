import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import {
  Alert,
  Image,
  Label,
  LazyVStack,
  Link,
  List,
  Menu,
  NavigationLink,
  NavigationStack,
  Picker,
  ProgressView,
  Section,
  Sheet,
  Slider,
  State,
  Stepper,
  Text,
} from '../dist/legacy.js'

test('renders React controls with native semantics', () => {
  const selection = State('b')
  const slider = State(4)
  const stepper = State(2)

  const html = renderToStaticMarkup(
    List(
      Image('/cover.png', { alt: 'Cover', fit: 'cover' }),
      Label('Profile', Text('●')),
      Link('Open', '/next'),
      ProgressView(0.5, { max: 1, label: 'Loading' }),
      Picker(selection, [
        { label: 'A', value: 'a' },
        { label: 'B', value: 'b' },
      ]),
      Slider(slider, { min: 0, max: 10 }),
      Stepper(stepper, { min: 0, max: 5 }),
    ),
  )

  assert.match(html, /<img/)
  assert.match(html, /object-fit:cover/)
  assert.match(html, /href="\/next"/)
  assert.match(html, /<progress/)
  assert.match(html, /<select/)
  assert.match(html, /<input[^>]+type="range"/)
  assert.match(html, /role="list"/)
})

test('renders sections and lazy stacks', () => {
  const html = renderToStaticMarkup(
    Section(
      { header: 'Header', footer: 'Footer' },
      LazyVStack(
        { estimatedItemSize: 48 },
        Text('One'),
        Text('Two'),
      ),
    ),
  )

  assert.match(html, /Header/)
  assert.match(html, /Footer/)
  assert.match(html, /content-visibility:auto/)
})

test('renders navigation links inside a React context stack', () => {
  const router = { push() {} }
  const html = renderToStaticMarkup(
    NavigationStack(
      router,
      NavigationLink('/settings', 'Settings'),
    ),
  )

  assert.match(html, /data-mun-navigation-stack/)
  assert.match(html, /href="\/settings"/)
  assert.match(html, />Settings</)
})

test('renders menu with native details and menu roles', () => {
  const html = renderToStaticMarkup(
    Menu('Actions', Text('Edit'), Text('Delete')),
  )

  assert.match(html, /<details/)
  assert.match(html, /<summary/)
  assert.match(html, /role="menu"/)
  assert.equal((html.match(/role="menuitem"/g) ?? []).length, 2)
})

test('portal presentation primitives are SSR-safe', () => {
  const presented = State(true)
  assert.equal(renderToStaticMarkup(Sheet(presented, Text('Sheet'))), '')
  assert.equal(renderToStaticMarkup(Alert(presented, { title: 'Alert' })), '')
})

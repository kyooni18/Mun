import assert from 'node:assert/strict'
import test from 'node:test'
import { Binding, Path, State, TextEditor } from '../packages/core/dist/compat.js'
import { Canvas, ContentEditable, FilePicker, FocusScope, Popover, Svg, Video } from '../packages/core/dist/web-primitives.js'

function element(value) {
  assert.equal(value.kind, 'element')
  return value
}

test('native browser primitives stay graph-first and preserve bindings', () => {
  const text = State('hello')
  const editor = element(TextEditor(Binding(text), 'Write', 5))
  assert.equal(editor.type, 'textarea')
  assert.equal(editor.props['data-mun'], 'TextEditor')
  editor.props.onInput({ target: { value: 'updated' } })
  assert.equal(text.value, 'updated')

  const editable = element(ContentEditable(Binding(text)))
  editable.props.onInput({ currentTarget: { textContent: 'rich' } })
  assert.equal(text.value, 'rich')

  let picked = null
  const picker = element(FilePicker(files => { picked = files }, 'image/*', true))
  picker.props.onChange({ target: { files: ['a'] } })
  assert.deepEqual(picked, ['a'])
  assert.equal(element(Canvas(320, 180)).type, 'canvas')
  assert.equal(element(Video('/movie.mp4', true)).type, 'video')
})

test('SVG, focus and popover primitives avoid raw host escape hatches', () => {
  const svg = element(Svg('0 0 10 10', () => [Path('M0 0L10 10')]))
  assert.equal(svg.type, 'svg')
  assert.equal(svg.children[0].type, 'path')
  const focus = element(FocusScope(() => [Canvas(1, 1)]))
  assert.equal(focus.props['data-mun-focus-scope'], 'restore')
  const shown = State(true)
  const popover = element(Popover(Binding(shown), () => [Canvas(1, 1)]))
  assert.equal(popover.props.role, 'dialog')
  assert.equal(popover.props['data-mun-presentation'], 'popover')
  assert.equal(popover.props.popover, 'auto')
})

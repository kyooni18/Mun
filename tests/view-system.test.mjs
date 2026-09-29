import assert from 'node:assert/strict'
import test from 'node:test'
import { renderToStaticMarkup } from 'react-dom/server'
import ts from 'typescript'
import {
  Action,
  Binding,
  Button,
  Component,
  closureKindOf,
  createViewNode,
  createViewIdentityStore,
  defineView,
  Element,
  ForEach,
  Group,
  Alert,
  Menu,
  NavigationLink,
  NavigationStack,
  Picker,
  ProgressView,
  Rectangle,
  RoundedRectangle,
  initializerKinds,
  initializer,
  modifierGraphOf,
  namedArguments,
  overloadClosure,
  renderViewNode,
  resolveBuilderClosure,
  resolveInitializer,
  State,
  Text,
  Toggle,
  ViewBuilder,
  ViewType,
  view,
  viewBuilderClosure,
  valueClosure,
  VStack,
  viewElement,
  isViewNode,
  viewNodeOf,
} from '../dist/legacy.js'
import { createMunLanguageService, createMunTypeScriptLanguageService, diagnoseMunSource, formatMunSource, lowerMunBuilderAst, mapGeneratedPosition, mapOriginalPosition, parseMunBuilder, parseMunStructs, transformMunBuilderSyntax, transformMunStructSyntax } from '../dist/compiler/index.js'
import {
  Action as CoreAction,
  Binding as CoreBinding,
  ForEach as CoreForEach,
  State as CoreState,
  Text as CoreText,
  defineView as CoreDefineView,
  initializer as CoreInitializer,
  initializerKinds as CoreInitializerKinds,
  renderViewNode as CoreRenderViewNode,
  resolveBuilderClosure as CoreResolveBuilderClosure,
  resolveInitializer as CoreResolveInitializer,
  viewBuilderClosure as CoreViewBuilderClosure,
} from '../packages/core/dist/compat.js'

test('struct syntax lowers to initializer metadata, a body, and instance State', () => {
  const output = transformMunStructSyntax(`
    export struct Counter: View {
      @State var count = 0
      var body: some View {
        VStack(spacing: 12) {
          Text(String(count.value))
        }
      }
    }
  `)
  assert.match(output, /export const Counter = defineView\("Counter"/)
  assert.match(output, /state: \(_props: any\) => \(\{ count: State\(0\) \}\)/)
  assert.match(output, /VStack\(namedArguments\(\{ spacing: 12 \}\), \(\) =>/)
  assert.doesNotMatch(output, /DEFAULT_BUILDER_COMPONENTS/)
  assert.doesNotMatch(output, /\bstruct\b/)
})

test('legacy struct lowering keeps canonical imports separate from compatibility runtime helpers', () => {
  const output = transformMunStructSyntax(`
    import { Binding, Text } from '@mun/ui'
    struct Counter: View {
      @State var count = 0
      var body: some View { Toggle("Count", isOn: $count) }
    }
  `)
  const canonicalImports = output.match(/import \{[^}]+\} from '@mun\/ui'/g) ?? []
  const legacyImports = output.match(/import \{[^}]+\} from '@mun\/ui\/legacy'/g) ?? []
  assert.equal(canonicalImports.length, 1)
  assert.match(canonicalImports[0], /Binding/)
  assert.match(canonicalImports[0], /Text/)
  assert.equal(legacyImports.length, 1)
  assert.match(legacyImports[0], /State/)
  assert.match(legacyImports[0], /defineView/)
})

test('struct @Binding fields lower to writable View inputs without React hook syntax', () => {
  const output = transformMunStructSyntax(`
    struct ToggleRow: View {
      @Binding var isOn: Bool
      var body: some View { Toggle("Wi-Fi", isOn: $isOn) }
    }
  `)
  assert.match(output, /import \{ Binding, defineView/)
  assert.match(output, /Toggle\("Wi-Fi", namedArguments\(\{ isOn: Binding\(isOn\) \}\)\)/)
  assert.match(output, /ToggleRow\(isOn\)/)

  const state = State(false)
  assert.match(renderToStaticMarkup(Toggle('Wi-Fi', { isOn: Binding(state) })), /Wi-Fi.*checkbox/)
  state.value = true
  assert.equal(state.value, true)
})

test('compiled generic struct Card uses the same runtime init and builder boundary', () => {
  const source = `
    struct Card<Content: View>: View {
      let content: Content
      init(@ViewBuilder content: () => Content) { self.content = content() }
      var body: some View { VStack() { content } }
    }
  `
  const generated = transformMunStructSyntax(source)
    .replace(/^import [^\n]+\n/, '')
    .replace(/\s+as any\b/g, '')
    .replace(/: any\b/g, '')
  const Card = Function(
    'defineView',
    'initializer',
    'resolveBuilderClosure',
    'VStack',
    'Text',
    'namedArguments',
    `${generated}; return Card`,
  )(defineView, initializer, resolveBuilderClosure, VStack, Text, namedArguments)
  assert.match(renderToStaticMarkup(Card(() => Text('Compiled'))), /Compiled/)
  assert.match(renderToStaticMarkup(Card(namedArguments({ content: () => Text('Named compiled') }))), /Named compiled/)
})

test('each custom struct initializer keeps its own field assignments', () => {
  const output = transformMunStructSyntax(`
    struct Badge: View {
      let title: string
      init(_ title: string) { self.title = title }
      init(_ title: string, suffix: string) { self.title = title + suffix }
      var body: some View { Text(title) }
    }
  `)
  const matches = output.match(/args => \{[\s\S]*?return \{ title: [^}]+ \}/g) ?? []
  assert.equal(matches.length, 2)
  assert.match(matches[0], /title: title/)
  assert.match(matches[1], /title: title \+ suffix/)
})

test('struct initializer defaults participate in metadata and runtime construction', () => {
  const output = transformMunStructSyntax(`
    struct Greeting: View {
      let title: string
      init(title: string = "Hello") { self.title = title }
      var body: some View { Text(title) }
    }
  `)
  assert.match(output, /args => args.length >= 0 && args.length <= 1/)
  assert.match(output, /required: false, defaultValue: "\\\"Hello\\\""/)
  assert.match(output, /const title = \(args\[0\] === undefined \? \(\"Hello\"\) : args\[0\]\) as any/)
})

test('struct lowering ignores declaration words inside strings and comments', () => {
  const source = `
    const text = 'struct Fake: View {}'
    // struct Comment: View {}
    /* struct BlockComment: View {} */
    struct Real: View {
      var body: some View { Text(text) }
    }
  `
  const output = transformMunStructSyntax(source)
  assert.match(output, /const text = 'struct Fake: View \{\}'/)
  assert.match(output, /struct Comment: View/)
  assert.match(output, /const Real = defineView\("Real"/)
  assert.doesNotMatch(output, /const Fake = defineView/)
})

test('struct diagnostics point at the original declaration', () => {
  assert.deepEqual(diagnoseMunSource('struct Card: View {}'), [{
    severity: 'error',
    code: 'MUN_SYNTAX',
    message: 'struct Card must declare var body',
    line: 1,
    column: 1,
  }])
})

test('Mun struct parser retains generic and body source ranges before lowering', () => {
  const source = `const label = 'struct Fake: View {}'
struct Card<Content: View>: View {
  let content: Content
  var body: some View { VStack() { content } }
}`
  const declarations = parseMunStructs(source)
  assert.equal(declarations.length, 1)
  assert.equal(declarations[0].name, 'Card')
  assert.equal(declarations[0].genericParameters, 'Content: View')
  assert.equal(source.slice(declarations[0].range.start, declarations[0].range.end), declarations[0].source)
  assert.equal(source.slice(declarations[0].bodyExpressionRange.start, declarations[0].bodyExpressionRange.end).trim(), 'VStack() { content }')
})

test('custom View initializers resolve trailing builders and render the body', () => {
  const Card = defineView('Card', {
    initializers: [initializer(
      'Card(@ViewBuilder content)',
      args => args.length === 1 && typeof args[0] === 'function',
      args => ({ content: resolveBuilderClosure(args[0]) }),
      [{ kind: 'viewBuilder', label: 'content', required: true }],
    )],
    body: ({ content }) => VStack(() => [content]),
  })

  const html = renderToStaticMarkup(Card(() => [Text('CPU'), Text('72%')]))
  assert.match(html, /CPU/)
  assert.match(html, /72%/)
  assert.match(renderToStaticMarkup(Card({ content: () => [Text('named')] })), /named/)
  assert.throws(() => Card(Text('not a builder')), /No matching initializer for Card/)
})

test('Button overloads distinguish actions from label builders', () => {
  const html = renderToStaticMarkup(VStack(
    Button(() => undefined),
    Button('Save', () => undefined),
    Button({ action: () => undefined, label: () => [Text('Custom')] }),
  ))
  assert.match(html, /<button type="button"><\/button>/)
  assert.match(html, /Save/)
  assert.match(html, /Custom/)
  assert.throws(() => Text('Hello', () => Text('invalid')), /No matching initializer for Text/)
})

test('ViewBuilder conditionals and ForEach compose in the same graph', () => {
  const enabled = true
  const html = renderToStaticMarkup(VStack(() => [
    enabled ? [Text('B')] : [Text('C')],
    ForEach(['A', 'B'], item => Text(item)),
  ]))
  assert.match(html, /B/)
  assert.match(html, /A/)
  assert.match(html, /B/)
})

test('compiler language hooks preserve labeled closure overloads and diagnostics', () => {
  const output = formatMunSource('Button(label: { Text("Save") }, action: { const value = 1; save(value) })')
  assert.match(output, /Button\(namedArguments\(\{ label: \(\) => \[Text\("Save"\)\], action: overloadClosure\(\(\) => \[\], \(\) => \{/)
  assert.equal(formatMunSource(output), output)
  assert.deepEqual(diagnoseMunSource('VStack() { Text("missing")'), [{
    severity: 'error',
    code: 'MUN_SYNTAX',
    message: 'Unclosed { block in Mun builder source',
    line: 1,
    column: 10,
  }])
  assert.equal(transformMunBuilderSyntax('Text("Hello")'), 'Text("Hello")')
})

test('editor language service keeps source positions and source maps in one contract', () => {
  const service = createMunLanguageService()
  const source = 'VStack() {\n  Text("Hello")\n}'
  const offset = source.indexOf('Text')
  const position = service.positionAt(source, offset)
  assert.deepEqual(position, { line: 2, column: 3 })
  assert.equal(service.offsetAt(source, position), offset)
  const transformed = service.transform(source, '/src/View.ts')
  assert.equal(transformed.map.sources[0], '/src/View.ts')
  assert.equal(service.diagnose(source).length, 0)
})

test('source maps retain token-level positions through collapsed builder lines', () => {
  const source = 'VStack() {\n  Text("Hello")\n}'
  const service = createMunLanguageService()
  const transformed = service.transform(source, '/src/View.ts')
  const generatedOffset = transformed.code.indexOf('Text')
  const generatedPosition = service.positionAt(transformed.code, generatedOffset)
  assert.deepEqual(mapGeneratedPosition(transformed.map, generatedPosition), { line: 2, column: 3 })
  assert.deepEqual(mapOriginalPosition(transformed.map, { line: 2, column: 3 }), generatedPosition)
  assert.deepEqual(transformed.map.x_mun.segments[0].map(segment => segment.line), [0, 1, 1])
})

test('source maps align repeated View occurrences by token order', () => {
  const source = 'VStack() {\n  Text("A")\n  Text("B")\n}'
  const service = createMunLanguageService()
  const transformed = service.transform(source, '/src/Repeated.ts')
  const secondText = transformed.code.lastIndexOf('Text')
  const mapped = mapGeneratedPosition(transformed.map, service.positionAt(transformed.code, secondText))
  assert.deepEqual(mapped, { line: 3, column: 3 })
})

test('TypeScript language service host parses lowered Mun snapshots', () => {
  const fileName = '/src/Editor.ts'
  const source = `
import { Text, VStack } from '@mun/ui'
export const screen = VStack() { Text('Editor') }
`
  const host = {
    getScriptFileNames: () => [fileName],
    getScriptVersion: () => '1',
    getScriptSnapshot: (name) => name === fileName
      ? ts.ScriptSnapshot.fromString(source)
      : ts.sys.readFile(name) === undefined
        ? undefined
        : ts.ScriptSnapshot.fromString(ts.sys.readFile(name) ?? ''),
    getCurrentDirectory: () => '/',
    getCompilationSettings: () => ({ target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext }),
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
  }
  const languageService = createMunTypeScriptLanguageService(host)
  const file = languageService.getProgram()?.getSourceFile(fileName)
  assert.ok(file)
  assert.doesNotMatch(file.text, /VStack\(\) \{/)
  assert.equal(languageService.getSyntacticDiagnostics(fileName).length, 0)
})

test('TypeScript diagnostics from lowered snapshots return original Mun spans', () => {
  const fileName = '/src/Diagnostics.ts'
  const source = `declare function Text(value: string): string
const value: number = Text('bad')
`
  const host = {
    getScriptFileNames: () => [fileName],
    getScriptVersion: () => '1',
    getScriptSnapshot: (name) => name === fileName ? ts.ScriptSnapshot.fromString(source) : undefined,
    getCurrentDirectory: () => '/',
    getCompilationSettings: () => ({ target: ts.ScriptTarget.ES2022, skipLibCheck: true }),
    getDefaultLibFileName: (options) => ts.getDefaultLibFilePath(options),
    fileExists: () => false,
    readFile: () => undefined,
    readDirectory: () => [],
  }
  const languageService = createMunTypeScriptLanguageService(host)
  const diagnostic = languageService.getSemanticDiagnostics(fileName)
    .find(value => String(value.messageText).includes('not assignable'))
  assert.ok(diagnostic)
  assert.equal(diagnostic.start, source.indexOf('value', source.indexOf('\n') + 1))
})

test('labeled arguments lower without a component allow-list and resolve through metadata', () => {
  assert.equal(
    transformMunBuilderSyntax('VStack(alignment: .leading, spacing: 12) { Text("Header") }'),
    'VStack(namedArguments({ alignment: \'leading\', spacing: 12 }), () => [Text("Header")])',
  )
  assert.equal(
    transformMunBuilderSyntax('Toggle("Wi-Fi", isOn: $wifi)'),
    'Toggle("Wi-Fi", namedArguments({ isOn: Binding(wifi) }))',
  )
  assert.match(renderToStaticMarkup(VStack(
    { alignment: 'leading', spacing: 12 },
    () => Text('Header'),
  )), /align-items:flex-start.*gap:12px/)

  const wifi = State(false)
  assert.match(renderToStaticMarkup(Toggle('Wi-Fi', { isOn: Binding(wifi) })), /Wi-Fi.*checkbox/)
  assert.match(renderToStaticMarkup(Button('Save', { action: () => undefined })), /Save/)
})

test('ViewBuilder syntax lowers if/else and item closures with one normalization rule', () => {
  const output = transformMunBuilderSyntax(`
    VStack() {
      Text("Header")
      if (enabled) {
        EnabledView()
      } else {
        DisabledView()
      }
      ForEach(items) { item in
        Row(item)
      }
    }
  `)
  assert.match(output, /enabled \? \[EnabledView\(\)\] : \[DisabledView\(\)\]/)
  assert.match(output, /overloadClosure\(/)
  assert.match(output, /ForEach\(items, \(item\) => \[Row\(item\)\]\)/)

  const child = Text('child')
  assert.deepEqual(ViewBuilder.buildBlock(child, null, [child], false), [child, child])
  assert.deepEqual(ViewBuilder.buildOptional(undefined), [])
  assert.deepEqual(ViewBuilder.buildEither(null, child), [child])
  assert.deepEqual(ViewBuilder.buildArray([[child], null]), [child])
})

test('legacy renderer and ViewBuilder arrays do not execute accessors or leak revoked Proxy errors', () => {
  let getterCalls = 0
  const values = []
  Object.defineProperty(values, '0', {
    enumerable: true,
    get() {
      getterCalls += 1
      throw new Error('legacy array getter must not run')
    },
  })
  values.length = 1
  assert.deepEqual(ViewBuilder.buildArray(values), [])

  const renderer = {
    element() { return null },
    fragment(children) { return children },
    value(value) { return value },
    render(value) { return renderViewNode(value, this) },
  }
  assert.deepEqual(renderViewNode(values, renderer), [undefined])
  assert.equal(getterCalls, 0)

  const revoked = () => {
    const pair = Proxy.revocable([], {})
    pair.revoke()
    return pair.proxy
  }
  assert.throws(() => ViewBuilder.buildArray(revoked()), /Legacy ViewBuilder arrays must be inspectable/)
  assert.throws(() => renderViewNode(revoked(), renderer), /Legacy Mün View graph array inputs must be inspectable/)
})

test('Mun builder parser produces a source-ranged AST consumed by the lowering pass', () => {
  const source = `VStack(alignment: .leading, spacing: 12) {
    Text("Header")
    if (enabled) { EnabledView() } else { DisabledView() }
    ForEach(items) { item in Row(item) }
  }`
  const ast = parseMunBuilder(source)
  assert.equal(ast.kind, 'program')
  assert.equal(ast.statements.length, 1)
  const stack = ast.statements[0]
  assert.equal(stack.kind, 'call')
  if (stack.kind !== 'call') return
  assert.equal(stack.callee, 'VStack')
  assert.deepEqual(stack.arguments.map(argument => argument.label), ['alignment', 'spacing'])
  assert.equal(stack.trailing?.body.statements.length, 3)
  assert.equal(stack.trailing?.body.statements[1]?.kind, 'conditional')
  assert.equal(stack.trailing?.body.statements[2]?.kind, 'call')
  assert.equal(stack.trailing?.body.statements[2]?.kind === 'call' && stack.trailing.body.statements[2].trailing?.parameter, 'item')
  assert.equal(ast.range.start, 0)
  assert.equal(ast.range.end, source.length)
  const lower = program => lowerMunBuilderAst(program, {
    transformRaw: value => value,
    closure: (body, parameter) => `${parameter ? `(${parameter})` : '()'} => [${lower(parseMunBuilder(body)).join(', ')}]`,
  })
  const lowered = lowerMunBuilderAst(ast, {
    transformRaw: value => value,
    closure: (body, parameter) => `${parameter ? `(${parameter})` : '()'} => [${lower(parseMunBuilder(body)).join(', ')}]`,
  })
  assert.deepEqual(lowered, [
    "VStack(namedArguments({ alignment: .leading, spacing: 12 }), () => [Text(\"Header\"), (enabled ? [EnabledView()] : [DisabledView()]), ForEach(items, (item) => [Row(item)])])",
  ])
})

test('Button, VStack, and Card share the same trailing and labeled builder boundary', () => {
  const Card = defineView('Card', {
    initializers: [initializer(
      'Card(@ViewBuilder content)',
      args => args.length === 1 && typeof args[0] === 'function',
      args => ({ content: resolveBuilderClosure(args[0]) }),
      [{ kind: 'viewBuilder', label: 'content', required: true }],
    )],
    body: ({ content }) => VStack(() => [content]),
  })

  assert.equal(
    transformMunBuilderSyntax('Card(content: { Text("Card") })'),
    'Card(namedArguments({ content: () => [Text("Card")] }))',
  )
  assert.match(renderToStaticMarkup(Card({ content: () => Text('Card') })), /Card/)
  assert.match(renderToStaticMarkup(Button(() => undefined)), /<button/)
  assert.match(renderToStaticMarkup(Button('Save', () => undefined)), /Save/)
  assert.match(renderToStaticMarkup(Button(viewBuilderClosure(() => Text('Marked')), Action(() => undefined))), /Marked/)
  assert.match(renderToStaticMarkup(Button({ action: () => undefined, label: () => Text('Custom') })), /Custom/)
  assert.match(renderToStaticMarkup(Button({ action: () => undefined }, () => Text('Trailing'))), /Trailing/)
  const named = resolveInitializer(Button, [{ action: () => undefined, label: () => Text('Named') }])
  assert.match(named.initializer.signature, /@Action action, @ViewBuilder label/)
})

test('compiled Button forms resolve the same action and label overloads end to end', () => {
  const sources = [
    'Button() { save() }',
    'Button("Save") { save() }',
    'Button(label: { Text("Save") }, action: { save() })',
    'Button(action: { save() }) { Text("Save") }',
  ]
  let saves = 0
  for (const source of sources) {
    const generated = formatMunSource(source).replace(/^import [^\n]+\n/, '')
    const button = Function(
      'Button',
      'Text',
      'namedArguments',
      'overloadClosure',
      'save',
      `return ${generated}`,
    )(Button, Text, namedArguments, overloadClosure, () => { saves += 1 })
    const html = renderToStaticMarkup(button)
    if (source.includes('Save')) assert.match(html, /Save/)
    button.props.onClick({ defaultPrevented: false })
  }
  assert.equal(saves, sources.length)
})

test('initializer resolution preserves distinct ViewBuilder and Action closure roles', () => {
  const Card = defineView('RoleCard', {
    initializers: [initializer(
      'RoleCard(@ViewBuilder content)',
      args => args.length === 1 && typeof args[0] === 'function',
      args => ({ content: resolveBuilderClosure(args[0]) }),
      [{ kind: 'viewBuilder', label: 'content', required: true }],
    )],
    body: ({ content }) => VStack(() => [content]),
  })
  const builder = () => Text('builder')
  assert.equal(closureKindOf(resolveInitializer(Card, [builder]).args[0]), 'viewBuilder')
  assert.equal(closureKindOf(Action(() => undefined)), 'action')
  assert.throws(() => Card(Action(() => undefined)), /No matching initializer for RoleCard/)
  assert.equal(closureKindOf(resolveInitializer(Text, [valueClosure(() => 'value')]).args[0]), 'value')
})

test('closure role selection is declaration-driven for arbitrary labels', () => {
  let actionCalls = 0
  const closure = overloadClosure(
    () => Text('builder'),
    () => { actionCalls += 1 },
  )
  const RoleView = defineView('RoleView', {
    initializers: [initializer(
      'RoleView(@Action handler)',
      args => args.length === 1 && typeof args[0] === 'function',
      args => ({ handler: args[0] }),
      [initializerKinds.action(true, 'handler')],
    )],
    body: ({ handler }) => Button(handler),
  })
  const resolved = resolveInitializer(RoleView, [closure])
  assert.equal(closureKindOf(resolved.args[0]), 'action')
  resolved.args[0]()
  assert.equal(actionCalls, 1)
  assert.match(transformMunBuilderSyntax('RoleView(handler: { const value = 1; save(value) })'), /overloadClosure\(/)
  assert.match(formatMunSource('RoleView(handler: { const value = 1; save(value) })'), /import \{ namedArguments, overloadClosure \}/)
})

test('initializer resolution scores declared value types instead of using registration order', () => {
  const Overloaded = defineView('Overloaded', {
    initializers: [
      initializer('Overloaded(number)', args => args.length === 1, args => ({ value: args[0] }), [initializerKinds.value(true, 'value', undefined, 'number')]),
      initializer('Overloaded(string)', args => args.length === 1, args => ({ value: args[0] }), [initializerKinds.value(true, 'value', undefined, 'string')]),
    ],
    body: ({ value }) => Text(String(value)),
  })

  assert.equal(resolveInitializer(Overloaded, ['Mun']).initializer.signature, 'Overloaded(string)')
  assert.equal(resolveInitializer(Overloaded, [42]).initializer.signature, 'Overloaded(number)')
  assert.throws(() => resolveInitializer(Overloaded, [true]), /No matching initializer for Overloaded/)
  assert.equal(resolveInitializer(Text, [undefined]).args.length, 1)
})

test('the declared resolver handles State, Binding, generic Content, and Action roles', () => {
  const number = CoreState(3)
  const title = CoreState('before')
  const Probe = CoreDefineView('ResolverProbe', {
    genericParameters: 'Content: View',
    initializers: [
      CoreInitializer('ResolverProbe(State<number>)', () => false, args => ({ value: args[0] }), [CoreInitializerKinds.value(true, 'value', undefined, 'State<number>')]),
      CoreInitializer('ResolverProbe(Binding<string>)', () => false, args => ({ value: args[0] }), [CoreInitializerKinds.value(true, 'value', undefined, 'Binding<string>')]),
      CoreInitializer('ResolverProbe(@Action action)', () => false, args => ({ action: args[0] }), [CoreInitializerKinds.action(true, 'action', '() => void')]),
      CoreInitializer('ResolverProbe(@ViewBuilder content)', () => false, args => ({ content: CoreResolveBuilderClosure(args[0]) }), [CoreInitializerKinds.viewBuilder(true, 'content', '() => Content')]),
    ],
    body: props => props.content ?? CoreText(String(props.value?.value ?? 'action')),
  })

  assert.match(CoreResolveInitializer(Probe, [number]).initializer.signature, /State<number>/)
  assert.match(CoreResolveInitializer(Probe, [CoreBinding(title)]).initializer.signature, /Binding<string>/)
  assert.match(CoreResolveInitializer(Probe, [CoreAction(() => undefined)]).initializer.signature, /@Action/)
  assert.match(CoreResolveInitializer(Probe, [CoreViewBuilderClosure(() => CoreText('content'))]).initializer.signature, /@ViewBuilder/)
})

test('ForEach uses the same View initializer boundary for State-backed collections', () => {
  const items = CoreState([{ id: 'a' }, { id: 'b' }])
  assert.equal(CoreForEach.viewType.name, 'ForEach')
  const value = CoreForEach(items, item => CoreText(item.id))
  const rendered = CoreRenderViewNode(value, {
    element(type, props, ...children) { return { type, props, children } },
    fragment(children) { return { children } },
    value(value) { return value },
    modifier(content) { return content },
  })
  assert.deepEqual(rendered.children.map(child => child.children[0]), ['a', 'b'])
})

test('Binding is a writable lens and modifiers produce an immutable graph', () => {
  const state = State(1)
  const binding = Binding(state)
  binding.value = 2
  assert.equal(state.value, 2)

  const original = Text('Hello')
  const modified = original.padding(4).foreground('red')
  assert.notEqual(original, modified)
  assert.deepEqual(modifierGraphOf(modified).map(record => record.name), ['padding', 'foreground'])
  assert.equal(isViewNode(viewNodeOf(original)), true)
  assert.equal(viewNodeOf(original)?.kind, 'element')
  assert.equal(viewNodeOf(modified)?.kind, 'modified')
  assert.equal(viewNodeOf(modified)?.modifier.name, 'foreground')
})

test('modifier shorthand lowers to an immutable ModifiedContent graph', () => {
  assert.equal(
    transformMunBuilderSyntax('Text("Hello").font(.title).padding()'),
    'Text("Hello").font(\'title\').padding()',
  )
  const original = Text('Hello')
  const modified = original.font('title').padding(4)
  assert.notEqual(original, modified)
  assert.deepEqual(modifierGraphOf(modified).map(record => record.name), ['font', 'padding'])
})

test('custom renderer traversal consumes View graph nodes without React recursion', () => {
  const renderer = {
    element(type, props, ...children) { return { type, props, children } },
    fragment(children) { return { fragment: children } },
    modifier(content, modifier) { return { modifier: modifier.name, content } },
    render(value) { return renderViewNode(value, renderer) },
  }
  const rendered = renderViewNode(viewElement('span', null, ['Renderer']), renderer)
  assert.equal(rendered.type, 'span')
  assert.deepEqual(rendered.children, ['Renderer'])
  const modified = renderViewNode(viewNodeOf(Text('Modified').padding(2)), renderer)
  assert.equal(modified.modifier, 'padding')
  assert.equal(modified.content.type, 'span')
  const nested = renderViewNode(viewNodeOf(VStack(Text('Nested'))), renderer)
  assert.equal(nested.type, 'div')
  assert.equal(nested.children[0].type, 'span')
  const RendererCard = defineView('RendererCard', {
    initializers: [initializer(
      'RendererCard(value)',
      args => args.length === 1,
      args => ({ value: args[0] }),
      [initializerKinds.value(true, 'value')],
    )],
    body: ({ value }) => VStack(Text(String(value))),
  })
  const card = renderViewNode(createViewNode(RendererCard, ['Card graph']), renderer)
  assert.equal(card.type, 'div')
  assert.equal(card.children[0].children[0], 'Card graph')
  const collection = renderViewNode(viewNodeOf(ForEach(['A', 'B'], item => Text(item))), renderer)
  assert.equal(collection.fragment.length, 2)
  assert.equal(collection.fragment[1].children[0], 'B')

  const leafRenderer = {
    element(type, props, ...children) { return { type, props, children } },
    fragment(children) { return { fragment: children } },
    value(value) { return { leaf: value } },
    render(value) { return renderViewNode(value, leafRenderer) },
  }
  const leaf = renderViewNode(viewElement('span', null, ['text']), leafRenderer)
  assert.deepEqual(leaf.children, [{ leaf: 'text' }])
})

test('View constructors can build graph nodes before React materialization', () => {
  const node = createViewNode(Text, ['Graph first'])
  assert.equal(node.kind, 'element')
  assert.equal(node.type, 'span')
  assert.deepEqual(node.children, ['Graph first'])
  assert.equal(renderToStaticMarkup(Text('Graph first')), '<span>Graph first</span>')
  assert.equal(Text.viewType instanceof ViewType, true)
  assert.equal(Text.viewType.name, 'Text')
  assert.equal(Text.viewType.initializers[0].signature, 'Text(value)')
  assert.equal(Text.viewType.createNode(['Typed graph']).kind, 'element')
})

test('View identity storage is renderer-independent and stable per identity', () => {
  const store = createViewIdentityStore()
  const first = {}
  const second = {}
  let creations = 0
  assert.equal(store.getOrCreate(first, () => ++creations), 1)
  assert.equal(store.getOrCreate(first, () => ++creations), 1)
  assert.equal(store.getOrCreate(second, () => ++creations), 2)
  store.delete(first)
  assert.equal(store.getOrCreate(first, () => ++creations), 3)
})

test('legacy view factory uses the same ViewType boundary', () => {
  const Legacy = view(() => Text('Legacy'))
  assert.equal(Legacy.viewType instanceof ViewType, true)
  assert.equal(viewNodeOf(Legacy())?.kind, 'view')
  assert.equal(renderToStaticMarkup(Legacy()), '<span>Legacy</span>')
})

test('native Element and Component construction enter the same View graph', () => {
  const native = Element('section', { id: 'native' }, Text('Native'))
  const component = Component('article', { title: 'component' }, Text('Component'))
  assert.equal(viewNodeOf(native)?.kind, 'element')
  assert.equal(viewNodeOf(component)?.kind, 'element')
  assert.equal(Element.viewType instanceof ViewType, true)
  assert.equal(Component.viewType instanceof ViewType, true)
  assert.equal(Group.viewType instanceof ViewType, true)
  assert.equal(renderToStaticMarkup(native), '<section id="native"><span>Native</span></section>')
  assert.equal(renderToStaticMarkup(component), '<article title="component"><span>Component</span></article>')
})

test('builtin controls stay graph-first before React materialization', () => {
  const progress = viewNodeOf(ProgressView(0.5, { label: 'Load' }))
  assert.equal(progress?.kind, 'element')
  assert.equal(progress?.kind === 'element' && progress.children.some(child => isViewNode(child)), true)
  const picker = viewNodeOf(Picker(State('a'), [{ label: 'A', value: 'a' }]))
  assert.equal(picker?.kind, 'element')
  assert.equal(picker?.kind === 'element' && isViewNode(picker.children[0]), true)
})

test('shape primitives use the same initializer and graph boundary', () => {
  assert.equal(resolveInitializer(Rectangle, []).initializer.signature, 'Rectangle()')
  assert.equal(resolveInitializer(RoundedRectangle, [12]).initializer.signature, 'RoundedRectangle(radius?)')
  assert.match(renderToStaticMarkup(RoundedRectangle(12)), /border-radius:12px/)
  assert.equal(viewNodeOf(Rectangle())?.kind, 'element')
})

test('presentation hosts enter the View graph without losing React-owned behavior', () => {
  const router = { push() {} }
  const presented = State(true)
  const values = [
    NavigationStack(router, NavigationLink('/settings', 'Settings')),
    NavigationLink('/profile', 'Profile'),
    Alert(presented, { title: 'Notice' }),
    Menu('More', Text('Settings')),
  ]
  for (const value of values) {
    assert.equal(viewNodeOf(value)?.kind, 'view')
  }
})

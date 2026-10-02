import { parseMunStructs, diagnoseMunSource, compileMunUiProgram, nativeLanguageCatalog } from '@mun/compiler'
import { formatSource } from '../../bin/formatter.mjs'
import { offsetAt, positionAt, rangeAt, scan } from './source.mjs'

export const tokenTypes = ['class', 'function', 'parameter', 'property', 'keyword', 'decorator', 'type', 'variable']
const keywords = new Set(['struct', 'var', 'let', 'some', 'private', 'public', 'init', 'if', 'else', 'switch', 'case', 'default', 'in', 'true', 'false', 'self', 'return'])
const types = new Set(['String', 'Bool', 'Int', 'Double', 'View'])
const catalog = nativeLanguageCatalog()
const views = new Map(catalog.views.map(item => [item.name, item]))
const modifiers = new Map(catalog.modifiers.map(item => [item.name, item]))
const values = new Map(catalog.values.map(item => [item.name, item]))
function canonicalType(type) { return ({ string: 'String', boolean: 'Bool', number: 'Double', array: 'Array', function: '() -> Void', binding: 'Binding' })[type] ?? type ?? 'Value' }
function signature(name, initializer) {
  return `${name}(${initializer.parameters.map(p => `${p.label ?? '_'} ${p.name ?? 'value'}: ${p.kind === 'viewBuilder' ? '() -> some View' : p.kind === 'action' ? '() -> Void' : p.kind === 'binding' ? 'Binding' : canonicalType(p.type)}${p.required === false ? ' = …' : ''}`).join(', ')})`
}
function initials(item) { return item?.initializers ?? [] }
function tokenAt(snapshot, offset) { return snapshot.tokens.find(token => token.start <= offset && token.end >= offset && /^[A-Za-z_]/u.test(token.text)) }

export class LanguageService {
  constructor() { this.documents = new Map(); this.parseCount = 0 }
  update(uri, source, version = 0) {
    const prior = this.documents.get(uri)
    if (prior?.source === source) return prior
    const { tokens, scopes } = scan(source)
    let structs = []
    try { structs = parseMunStructs(source) } catch { /* Partial syntax still has lexical scopes. */ }
    const snapshot = { uri, source, version, tokens, scopes, structs, declarations: [], diagnostics: undefined }
    const add = (token, kind, extra = {}) => {
      if (token) snapshot.declarations.push({ id: `${uri}#${token.start}`, name: token.text, token, kind, scope: token.scope, ...extra })
    }
    function walk(struct) {
      const name = tokens.find(t => t.text === struct.name && t.start >= struct.range.start && t.end < struct.bodyRange.start)
      add(name, 'view', { struct, range: struct.range })
      for (const field of struct.fields) {
        const token = tokens.find(t => t.start === field.range.start)
        add(token, field.kind === 'state' || field.kind === 'binding' ? field.kind : 'property', { type: field.type, owner: struct.name })
      }
      for (const nested of struct.nested ?? []) walk(nested)
    }
    structs.forEach(walk)
    for (let i = 0; i < tokens.length; i++) {
      const token = tokens[i], previous = tokens[i - 1]
      if ((previous?.text === 'let' || previous?.text === 'var') && !snapshot.declarations.some(d => d.token.start === token.start)) {
        add(token, 'local', { type: tokens[i + 1]?.text === ':' ? tokens[i + 2]?.text : undefined })
      }
      // Closure parameters are declarations owned by the closure block.
      if (token.text === 'in') {
        let j = i - 1
        while (j >= 0 && tokens[j].scope === token.scope && !['{', ';', '}'].includes(tokens[j].text)) j--
        const candidates = tokens.slice(j + 1, i)
        if (candidates.every(t => /^[A-Za-z_][A-Za-z0-9_]*$/u.test(t.text) || [',', '(', ')'].includes(t.text))) {
          for (const parameter of candidates.filter(t => /^[A-Za-z_]/u.test(t.text))) add(parameter, 'parameter')
        }
      }
      // Explicit initializer parameters shadow fields inside that initializer.
      if (token.text === 'init' && tokens[i + 1]?.text === '(') {
        let j = i + 2, depth = 1
        const parameters = []
        while (j < tokens.length && depth) {
          if (tokens[j].text === '(') depth++
          if (tokens[j].text === ')') depth--
          if (depth === 1 && tokens[j + 1]?.text === ':' && /^[A-Za-z_]/u.test(tokens[j].text)) parameters.push({ token: tokens[j], type: tokens[j + 2]?.text })
          j++
        }
        const block = scopes.findIndex(s => s.start === tokens[j]?.start)
        for (const p of parameters) if (block >= 0) add(p.token, 'parameter', { scope: block, type: p.type })
      }
    }
    for (const document of this.documents.values()) document.diagnostics = undefined
    this.documents.set(uri, snapshot); this.parseCount++
    return snapshot
  }
  remove(uri) { this.documents.delete(uri); for (const document of this.documents.values()) document.diagnostics = undefined }
  snapshot(uri) { return this.documents.get(uri) }
  resolve(snapshot, token) {
    if (!token) return undefined
    const declared = snapshot.declarations.find(d => d.token.start === token.start)
    if (declared) return declared
    const index = snapshot.tokens.indexOf(token), previous = snapshot.tokens[index - 1], next = snapshot.tokens[index + 1]
    // A dotted member belongs to the receiver, not any equal local identifier.
    if (previous?.text === '.' && snapshot.tokens[index - 2]?.text !== 'self') return undefined
    // Argument labels resolve to a custom View's property, never to a caller's State.
    if (next?.text === ':') {
      const call = this.callContext(snapshot, token.start)
      const matches = [...this.documents.values()].flatMap(s => s.declarations).filter(d => d.owner === call?.name && d.name === token.text)
      return matches.length === 1 ? matches[0] : undefined
    }
    let scope = token.scope
    while (scope !== null) {
      const matches = snapshot.declarations.filter(d => d.scope === scope && d.name === token.text && (d.kind !== 'local' || d.token.start <= token.start))
      if (matches.length === 1) return matches[0]
      if (matches.length > 1) return undefined
      scope = snapshot.scopes[scope].parent
    }
    const matches = [...this.documents.values()].flatMap(s => s.declarations).filter(d => d.kind === 'view' && d.name === token.text && d.scope === 0)
    return matches.length === 1 ? matches[0] : undefined
  }
  references(uri, position, includeDeclaration = true) {
    const snapshot = this.snapshot(uri)
    if (!snapshot) return []
    const symbol = this.resolve(snapshot, tokenAt(snapshot, offsetAt(snapshot.source, position)))
    if (!symbol) return []
    const result = []
    for (const candidate of this.documents.values()) for (const token of candidate.tokens) {
      if (token.text !== symbol.name || (!includeDeclaration && candidate.uri === uri && token.start === symbol.token.start)) continue
      if (this.resolve(candidate, token)?.id === symbol.id) result.push({ uri: candidate.uri, range: rangeAt(candidate.source, token.start, token.end) })
    }
    return result
  }
  definition(uri, position) {
    const snapshot = this.snapshot(uri)
    const symbol = snapshot && this.resolve(snapshot, tokenAt(snapshot, offsetAt(snapshot.source, position)))
    if (!symbol) return null
    const owner = [...this.documents.values()].find(s => s.declarations.includes(symbol))
    return { uri: owner.uri, range: rangeAt(owner.source, symbol.token.start, symbol.token.end) }
  }
  prepareRename(uri, position) {
    const snapshot = this.snapshot(uri)
    const token = snapshot && tokenAt(snapshot, offsetAt(snapshot.source, position))
    return this.resolve(snapshot, token) ? { range: rangeAt(snapshot.source, token.start, token.end), placeholder: token.text } : null
  }
  rename(uri, position, newName) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/u.test(newName) || keywords.has(newName) || types.has(newName)) throw new Error('Rename requires a non-keyword Mün identifier.')
    const snapshot = this.snapshot(uri)
    const symbol = snapshot && this.resolve(snapshot, tokenAt(snapshot, offsetAt(snapshot.source, position)))
    if (!symbol) throw new Error('No unambiguous source symbol at this position.')
    if ([...this.documents.values()].some(s => s.declarations.some(d => d.name === newName && d.id !== symbol.id && (d.kind === 'view' || s === snapshot)))) throw new Error(`Rename would conflict with ${newName}.`)
    const changes = {}
    for (const location of this.references(uri, position)) (changes[location.uri] ??= []).push({ range: location.range, newText: newName })
    return { changes }
  }
  diagnostics(uri) {
    const snapshot = this.snapshot(uri)
    if (!snapshot) return []
    if (snapshot.diagnostics) return snapshot.diagnostics
    snapshot.diagnostics = diagnoseMunSource(snapshot.source, uri).map(d => {
      const start = d.index ?? offsetAt(snapshot.source, { line: (d.line ?? 1) - 1, character: (d.column ?? 1) - 1 })
      return { range: rangeAt(snapshot.source, start, Math.min(snapshot.source.length, start + 1)), severity: d.severity === 'warning' ? 2 : 1, code: d.code, source: 'mun', message: d.message }
    })
    // Native lowering is the validity contract, not the compatibility TS transform.
    if (!snapshot.diagnostics.some(d => d.severity === 1)) {
      const documents = [snapshot, ...[...this.documents.values()].filter(s => s !== snapshot)]
      try { compileMunUiProgram(documents.map(s => s.source).join('\n'), uri) }
      catch (error) {
        // Errors in another indexed file belong to that file, not this URI.
        if (typeof error.offset === 'number' && error.offset > snapshot.source.length) return snapshot.diagnostics
        const start = typeof error.offset === 'number' ? Math.max(0, error.offset) : 0
        snapshot.diagnostics.push({ range: rangeAt(snapshot.source, start, Math.min(snapshot.source.length, start + (error.length ?? 1))), severity: 1, code: 'MUN_NATIVE', source: 'mun', message: error.message })
      }
    }
    return snapshot.diagnostics
  }
  codeActions(uri, range, context = {}) {
    if (context.only && !context.only.some(kind => 'quickfix'.startsWith(kind))) return []
    const snapshot = this.snapshot(uri)
    if (!snapshot) return []
    const diagnostics = this.diagnostics(uri)
    const actions = []
    function fields(struct) { return [...struct.fields, ...(struct.nested ?? []).flatMap(fields)] }
    for (const field of snapshot.structs.flatMap(fields)) {
      const replacement = { string: 'String', boolean: 'Bool' }[field.type]
      // `number` is deliberately excluded: choosing Int versus Double requires
      // semantic evidence. Never rewrite matching strings or unrelated names.
      if (!replacement) continue
      const diagnostic = diagnostics.find(d => d.code === 'MUN_NATIVE' && offsetAt(snapshot.source, d.range.start) === field.range.start && d.message.includes(`'${field.type}' is a compatibility-only TypeScript type spelling`))
      if (!diagnostic) continue
      const start = snapshot.tokens.findIndex(t => t.start === field.range.start)
      const colon = snapshot.tokens[start + 1], type = snapshot.tokens[start + 2]
      if (colon?.text !== ':' || type?.text !== field.type) continue
      const editRange = rangeAt(snapshot.source, type.start, type.end)
      if (offsetAt(snapshot.source, range.end) < type.start || offsetAt(snapshot.source, range.start) > type.end) continue
      actions.push({ title: `Use canonical ${replacement}`, kind: 'quickfix', diagnostics: [diagnostic], edit: { changes: { [uri]: [{ range: editRange, newText: replacement }] } } })
    }
    return actions
  }
  customView(name) {
    const matches = [...this.documents.values()].flatMap(s => s.declarations).filter(d => d.kind === 'view' && d.name === name)
    if (matches.length !== 1) return undefined
    const struct = matches[0].struct
    return { name, initializers: struct.initializers.length ? struct.initializers.map(init => ({ signature: `init(${init.parametersSource})`, parameters: this.parameters(init.parametersSource) })) : [{ parameters: struct.fields.filter(f => f.kind !== 'state').map(f => ({ name: f.name, label: f.name, type: f.type, required: f.initializer === undefined, kind: f.kind === 'binding' ? 'binding' : 'value' })) }] }
  }
  parameters(source) {
    return source.split(',').map(item => {
      const match = /^\s*(?:([A-Za-z_]\w*|_)\s+)?([A-Za-z_]\w*)\s*:\s*([^=]+)(?:=(.*))?$/u.exec(item)
      return match ? { name: match[2], label: match[1] === '_' ? undefined : match[1] ?? match[2], type: match[3].trim(), required: match[4] === undefined, kind: 'value' } : null
    }).filter(Boolean)
  }
  callContext(snapshot, offset) {
    const stack = []
    const tokens = snapshot.tokens.filter(t => t.start < offset)
    for (let i = 0; i < tokens.length; i++) {
      const t = tokens[i]
      if (t.text === '(') stack.push({ name: tokens[i - 1]?.text, start: t.end, index: 0, argument: t.end, modifier: tokens[i - 2]?.text === '.' })
      else if (t.text === ')') stack.pop()
      else if (t.text === ',' && stack.length) { stack.at(-1).index++; stack.at(-1).argument = t.end }
    }
    return stack.at(-1)
  }
  callItem(call) { return call && (call.modifier ? modifiers.get(call.name) : views.get(call.name) ?? this.customView(call.name) ?? (values.has(call.name) ? { name: call.name, initializers: values.get(call.name).members.filter(m => m.signature.startsWith('init(')) } : undefined)) }
  completion(uri, position) {
    const snapshot = this.snapshot(uri)
    if (!snapshot) return []
    const offset = offsetAt(snapshot.source, position), prefix = snapshot.source.slice(0, offset)
    const call = this.callContext(snapshot, offset), item = this.callItem(call)
    const fragment = call ? snapshot.source.slice(call.argument, offset).trim() : ''
    const label = /^([A-Za-z_]\w*)\s*:/u.exec(fragment)?.[1]
    const parameters = initials(item).flatMap(i => i.parameters ?? [])
    const expected = label ? parameters.find(p => p.label === label) : parameters[call?.index ?? 0]
    const bindables = snapshot.declarations.filter(d => ['state', 'binding'].includes(d.kind))
    if (/\$[A-Za-z_0-9]*$/u.test(prefix)) return bindables.map(d => ({ label: d.name, kind: 10, detail: `Binding<${canonicalType(d.type)}>` }))
    if (/\.[A-Za-z_0-9]*$/u.test(prefix)) {
      const explicit = /([A-Za-z_]\w*)\.[A-Za-z_0-9]*$/u.exec(prefix)?.[1]
      const semanticType = explicit ?? (label === 'alignment' ? call?.name === 'VStack' ? 'HorizontalAlignment' : call?.name === 'HStack' ? 'VerticalAlignment' : 'Alignment' : label === 'axes' ? 'Axis.Set' : call?.name === 'padding' && !label ? 'Edge.Set' : ['startPoint', 'endPoint', 'anchor'].includes(label) ? 'UnitPoint' : /^max(Width|Height)$/u.test(label ?? '') ? 'CGFloat' : undefined)
      const members = catalog.implicitMembers[semanticType]
      if (members) return members.map(name => ({ label: name, kind: 12, detail: semanticType }))
      const owner = explicit && values.get(explicit)
      let value = owner
      if (!value && call?.name === 'animation') value = values.get('Animation')
      if (!value && call?.name === 'transition') value = values.get('AnyTransition')
      if (!value && ['foregroundStyle', 'fill', 'background'].includes(call?.name)) value = values.get('Color')
      if (value) return [...new Set(value.members.filter(m => !m.signature.startsWith('init(')).map(m => m.signature.split('(')[0]))].map(name => ({ label: name, kind: 12, detail: value.name }))
      // A dot inside unknown argument expressions must not advertise View modifiers.
      if (call) return []
      return catalog.modifiers.map(m => ({ label: m.name, kind: 2, detail: m.initializers.map(i => signature(`.${m.name}`, i)).join(' | ') }))
    }
    if (expected?.kind === 'binding') return bindables.map(d => ({ label: `$${d.name}`, kind: 10, detail: `Binding<${canonicalType(d.type)}>` }))
    const labels = parameters.filter(p => p.label && !p.trailing).map(p => ({ label: `${p.label}:`, kind: 5, detail: canonicalType(p.type), insertText: `${p.label}: ` }))
    if (call && !label) return [...new Map(labels.map(l => [l.label, l])).values()]
    if (expected?.type === 'boolean' || expected?.type === 'Bool') return ['true', 'false'].map(label => ({ label, kind: 12 }))
    const custom = [...this.documents.values()].flatMap(s => s.declarations).filter(d => d.kind === 'view' && d.scope === 0).map(d => this.customView(d.name)).filter(Boolean)
    return [...catalog.views, ...custom].map(v => ({ label: v.name, kind: 7, detail: v.initializers.map(i => signature(v.name, i)).join(' | ') })).concat(snapshot.declarations.filter(d => d.kind !== 'view').map(d => ({ label: d.name, kind: 10, detail: canonicalType(d.type) })))
  }
  hover(uri, position) {
    const snapshot = this.snapshot(uri), token = snapshot && tokenAt(snapshot, offsetAt(snapshot.source, position))
    if (!token) return null
    const symbol = this.resolve(snapshot, token)
    const item = views.get(token.text) ?? modifiers.get(token.text) ?? this.customView(token.text)
    const text = symbol && symbol.kind !== 'view' ? `${symbol.kind === 'state' ? '@State ' : symbol.kind === 'binding' ? '@Binding ' : ''}${symbol.name}: ${canonicalType(symbol.type)}` : item ? item.initializers.map(i => signature(token.text, i)).join('\n') : types.has(token.text) ? `type ${token.text}` : undefined
    return text ? { contents: { kind: 'markdown', value: `\`\`\`mun\n${text}\n\`\`\`${item?.documentation ? `\n\n${item.documentation}` : ''}` }, range: rangeAt(snapshot.source, token.start, token.end) } : null
  }
  signatureHelp(uri, position) {
    const snapshot = this.snapshot(uri)
    if (!snapshot) return null
    const call = this.callContext(snapshot, offsetAt(snapshot.source, position)), item = this.callItem(call)
    if (!item) return null
    return { signatures: initials(item).map(i => ({ label: signature(item.name, i), parameters: (i.parameters ?? []).map(p => ({ label: p.label ?? p.name ?? 'value' })) })), activeSignature: 0, activeParameter: call.index }
  }
  symbols(uri) {
    const s = this.snapshot(uri)
    return s ? s.declarations.filter(d => d.kind === 'view').map(d => ({ name: d.name, kind: 23, range: rangeAt(s.source, d.range.start, d.range.end), selectionRange: rangeAt(s.source, d.token.start, d.token.end), children: s.declarations.filter(f => f.owner === d.name).map(f => ({ name: f.name, kind: 7, detail: canonicalType(f.type), range: rangeAt(s.source, f.token.start, f.token.end), selectionRange: rangeAt(s.source, f.token.start, f.token.end) })) })) : []
  }
  workspaceSymbols(query) {
    return [...this.documents.values()].flatMap(s => s.declarations.filter(d => d.kind === 'view' && d.name.toLowerCase().includes(query.toLowerCase())).map(d => ({ name: d.name, kind: 23, location: { uri: s.uri, range: rangeAt(s.source, d.token.start, d.token.end) } })))
  }
  semanticTokens(uri) {
    const s = this.snapshot(uri)
    if (!s) return { data: [] }
    const data = []; let line = 0, character = 0
    for (const token of s.tokens) {
      if (!/^[A-Za-z_]/u.test(token.text)) continue
      const symbol = this.resolve(s, token), index = s.tokens.indexOf(token)
      const type = s.tokens[index - 1]?.text === '@' ? 'decorator' : keywords.has(token.text) ? 'keyword' : types.has(token.text) ? 'type' : symbol?.kind === 'view' || views.has(token.text) ? 'class' : ['state', 'binding', 'property'].includes(symbol?.kind) ? 'property' : symbol?.kind === 'parameter' ? 'parameter' : symbol?.kind === 'local' ? 'variable' : modifiers.has(token.text) && s.tokens[index - 1]?.text === '.' ? 'function' : undefined
      if (!type) continue
      const p = positionAt(s.source, token.start)
      data.push(p.line - line, p.line === line ? p.character - character : p.character, token.end - token.start, tokenTypes.indexOf(type), 0)
      line = p.line; character = p.character
    }
    return { data }
  }
  formatting(uri) {
    const s = this.snapshot(uri)
    return s ? [{ range: rangeAt(s.source, 0, s.source.length), newText: formatSource(s.source) }] : []
  }
  folding(uri) {
    const s = this.snapshot(uri)
    return s ? s.scopes.slice(1).flatMap(scope => {
      const start = positionAt(s.source, scope.start), end = positionAt(s.source, scope.end)
      return end.line > start.line ? [{ startLine: start.line, endLine: end.line - 1, kind: 'region' }] : []
    }) : []
  }
  selectionRanges(uri, positions) {
    const s = this.snapshot(uri)
    if (!s) return []
    return positions.map(position => {
      const offset = offsetAt(s.source, position), token = tokenAt(s, offset)
      let parent = { range: rangeAt(s.source, 0, s.source.length) }
      for (const scope of s.scopes.filter(sc => sc.parent !== null && sc.start <= offset && sc.end >= offset).sort((a, b) => (b.end - b.start) - (a.end - a.start))) parent = { range: rangeAt(s.source, scope.start, scope.end), parent }
      return token ? { range: rangeAt(s.source, token.start, token.end), parent } : parent
    })
  }
}

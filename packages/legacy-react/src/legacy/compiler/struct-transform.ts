/**
 * Low-level transform for Mun's small struct/View surface.
 *
 * It intentionally handles the declarative subset rather than pretending that
 * a JavaScript parser can understand Swift syntax. For example:
 *
 *   struct Card<Content: View>: View {
 *     let content: Content
 *     init(@ViewBuilder content: () => Content) { self.content = content() }
 *     var body: some View { VStack() { content } }
 *   }
 *
 * becomes a normal `defineView` declaration. TypeScript/JS remains the host
 * language for expressions inside the initializer and body.
 */

import { transformMunBuilderSyntax } from './builder-transform.js'
import { parseMunStructs, type MunStructDeclaration } from './ast.js'
import { munSyntaxError } from './errors.js'

function skipQuoted(source: string, index: number, quote: "'" | '"'): number {
  for (let i = index + 1; i < source.length; i += 1) {
    if (source[i] === '\\') { i += 1; continue }
    if (source[i] === quote) return i + 1
  }
  throw munSyntaxError(`Unclosed ${quote} string in Mun struct source`, index)
}

function skipTemplate(source: string, index: number): number {
  for (let i = index + 1; i < source.length; i += 1) {
    if (source[i] === '\\') { i += 1; continue }
    if (source[i] === '`') return i + 1
  }
  throw munSyntaxError('Unclosed template literal in Mun struct source', index)
}

function splitArguments(source: string): string[] {
  const values: string[] = []
  let start = 0
  let parens = 0
  let braces = 0
  for (let i = 0; i < source.length; i += 1) {
    const char = source[i]
    if (char === "'" || char === '"') { i = skipQuoted(source, i, char) - 1; continue }
    if (char === '`') { i = skipTemplate(source, i) - 1; continue }
    if (char === '(') parens += 1
    else if (char === ')') parens -= 1
    else if (char === '{') braces += 1
    else if (char === '}') braces -= 1
    else if (char === ',' && parens === 0 && braces === 0) {
      values.push(source.slice(start, i).trim())
      start = i + 1
    }
  }
  const last = source.slice(start).trim()
  if (last) values.push(last)
  return values
}

interface InitParameter {
  name: string
  kind: 'value' | 'viewBuilder' | 'action'
  label?: string
  type?: string
  required: boolean
  defaultValue?: string
}

function parseParameter(source: string, offset = 0): InitParameter {
  const kind = source.includes('@ViewBuilder') ? 'viewBuilder' : source.includes('@Action') ? 'action' : 'value'
  const withoutAnnotation = source.replace(/@(?:ViewBuilder|Action)\s*/g, '').trim()
  let defaultIndex = -1
  for (let index = 0; index < withoutAnnotation.length; index += 1) {
    if (withoutAnnotation[index] !== '=' || withoutAnnotation[index + 1] === '>' || withoutAnnotation[index - 1] === '=' || withoutAnnotation[index - 1] === '<' || withoutAnnotation[index - 1] === '!') continue
    defaultIndex = index
    break
  }
  const declaration = defaultIndex < 0 ? withoutAnnotation : withoutAnnotation.slice(0, defaultIndex).trim()
  const colon = declaration.indexOf(':')
  const head = (colon < 0 ? declaration : declaration.slice(0, colon)).trim()
  const names = head.split(/\s+/).filter(Boolean)
  const name = names[names.length - 1]?.replace(/^_+/, '')
  if (!name) throw munSyntaxError(`Invalid initializer parameter: ${source}`, offset)
  const type = colon < 0 ? undefined : declaration.slice(colon + 1).trim()
  const defaultValue = defaultIndex < 0 ? undefined : withoutAnnotation.slice(defaultIndex + 1).trim()
  return { name, kind, label: names[0] === '_' ? undefined : names[0], type, required: defaultIndex < 0, defaultValue }
}

function parameterMetadata(parameters: InitParameter[]): string {
  return `[${parameters.map(parameter => `{ kind: '${parameter.kind}', label: ${parameter.label ? `'${parameter.label}'` : 'undefined'}, type: ${parameter.type ? JSON.stringify(parameter.type) : 'undefined'}, required: ${parameter.required}${parameter.defaultValue ? `, defaultValue: ${JSON.stringify(parameter.defaultValue)}` : ''} }`).join(', ')}]`
}

function initializerAccepts(parameters: InitParameter[]): string {
  const checks = parameters.map((parameter, index) => {
    if (parameter.kind === 'viewBuilder' || parameter.kind === 'action') {
      return parameter.required
        ? `typeof args[${index}] === 'function'`
        : `(args[${index}] === undefined || typeof args[${index}] === 'function')`
    }
    return 'true'
  })
  const required = parameters.filter(parameter => parameter.required).length
  return `args.length >= ${required} && args.length <= ${parameters.length}${checks.length ? ` && ${checks.join(' && ')}` : ''}`
}

function buildBody(
  parameters: InitParameter[],
  fields: string[],
  assignments: Map<string, string>,
  stateFields: Set<string>,
  defaults: Map<string, string | undefined> = new Map(),
): string {
  const locals = parameters.map((parameter, index) => {
    const expression = parameter.defaultValue
      ? `(args[${index}] === undefined ? (${parameter.defaultValue}) : args[${index}])`
      : `args[${index}]`
    return `const ${parameter.name} = ${expression} as any`
  }).join('; ')
  const values = fields.filter(field => !stateFields.has(field)).map(field => {
    const assignment = assignments.get(field)
    if (assignment) {
      const parameter = parameters.find(item => item.name === assignment.replace(/\(\)$/, '').trim())
      if (parameter?.kind === 'viewBuilder' && assignment === `${parameter.name}()`) {
        return `${field}: resolveBuilderClosure(${parameter.name})`
      }
      return `${field}: ${assignment}`
    }
    const parameter = parameters.find(item => item.name === field)
    if (parameter?.kind === 'viewBuilder') return `${field}: resolveBuilderClosure(${field})`
    if (parameter) return `${field}: ${field}`
    const defaultValue = defaults.get(field)
    return `${field}: ${defaultValue ?? 'undefined'}`
  })
  return `args => { ${locals}; return { ${values.join(', ')} } }`
}

function findAssignments(initBody: string): Map<string, string> {
  const assignments = new Map<string, string>()
  const expression = /self\.([A-Za-z_$][A-Za-z0-9_$]*)\s*=\s*([\s\S]*?)(?=;|\n|$)/g
  for (const match of initBody.matchAll(expression)) assignments.set(match[1], match[2].trim())
  return assignments
}

function previousSignificant(source: string, index: number): string | undefined {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (!/\s/.test(source[cursor])) return source[cursor]
  }
  return undefined
}

function bindingShorthandContext(source: string, index: number): boolean {
  const previous = previousSignificant(source, index)
  if (previous !== undefined && '([{=,:;?'.includes(previous)) return true
  const prefix = source.slice(0, index).match(/([A-Za-z_$][A-Za-z0-9_$]*)\s*$/)?.[1]
  return prefix === 'return' || prefix === 'yield' || prefix === 'case'
}

function lowerBindingShorthand(source: string): string {
  const nonBindingDollarNames = new Set([
    'attrs', 'data', 'emit', 'el', 'forceUpdate', 'nextTick', 'options', 'parent', 'props', 'refs', 'root', 'slots', 'watch',
  ])
  let output = ''
  for (let index = 0; index < source.length;) {
    const char = source[index]
    if (char === "'" || char === '"') {
      const end = skipQuoted(source, index, char)
      output += source.slice(index, end)
      index = end
      continue
    }
    if (char === '`') {
      const end = skipTemplate(source, index)
      output += source.slice(index, end)
      index = end
      continue
    }
    if (char === '$' && bindingShorthandContext(source, index)) {
      const match = /^\$([A-Za-z_$][A-Za-z0-9_$]*)/.exec(source.slice(index))
      if (match && !nonBindingDollarNames.has(match[1])) {
        output += `Binding(${match[1]})`
        index += match[0].length
        continue
      }
    }
    output += char
    index += 1
  }
  return output
}

function transformOne(declaration: MunStructDeclaration): string {
  const { name, bodyExpressionSource: bodyExpression } = declaration
  const fields = declaration.fields.map(field => field.name)
  const stateValues = new Map(declaration.fields
    .filter(field => field.kind === 'state')
    .map(field => [field.name, field.initializer?.trim() ?? 'undefined'] as const))
  const stateFields = new Set(stateValues.keys())
  const defaults = new Map(declaration.fields.map(field => [field.name, field.initializer] as const))
  const initializers: string[] = []
  for (const syntax of declaration.initializers) {
    const parameters = splitArguments(syntax.parametersSource).map(parameter => parseParameter(parameter, syntax.parametersRange.start))
    const initializerBody = syntax.bodySource
    const assignments = findAssignments(initializerBody)
    const signature = `${name}(${parameters.map(parameter => `${parameter.kind === 'viewBuilder' ? '@ViewBuilder ' : parameter.kind === 'action' ? '@Action ' : ''}${parameter.label ?? parameter.name}`).join(', ')})`
    initializers.push(`initializer(${JSON.stringify(signature)}, args => ${initializerAccepts(parameters)}, ${buildBody(parameters, fields, assignments, stateFields, defaults)}, ${parameterMetadata(parameters)})`)
  }

  if (initializers.length === 0) {
    const parameters = fields.filter(field => !stateFields.has(field)).map(field => ({ name: field, kind: 'value' as const, label: field, required: true }))
    initializers.push(`initializer(${JSON.stringify(`${name}(${parameters.map(parameter => parameter.name).join(', ')})`)}, args => args.length === ${parameters.length}, ${buildBody(parameters, fields, new Map(), stateFields, defaults)}, ${parameterMetadata(parameters)})`)
  }

  const destructure = fields.length > 0 ? `const { ${fields.join(', ')} } = props; ` : ''
  const sourceBody = bodyExpression.trim()
  const result = /^return\b([\s\S]*)/.exec(sourceBody)
  const bodyCode = lowerBindingShorthand(result ? result[1].replace(/;\s*$/, '') : sourceBody)
  const state = stateValues.size > 0
    ? `, state: (_props: any) => ({ ${[...stateValues.entries()].map(([field, value]) => `${field}: State(${value})`).join(', ')} })`
    : ''
  return `defineView(${JSON.stringify(name)}, { name: ${JSON.stringify(name)}, initializers: [${initializers.join(', ')}]${state}, body: (props: any) => { ${destructure} return ${bodyCode}; } })`
}

/** Transform `struct Name: View { ... }` declarations into defineView calls. */
export function transformMunStructSyntax(source: string): string {
  const declarations = parseMunStructs(source)
  if (declarations.length === 0) return source
  let output = ''
  let cursor = 0
  for (const declaration of declarations) {
    const transformedBody = transformOne({
      ...declaration,
      bodyExpressionSource: transformMunBuilderSyntax(declaration.bodyExpressionSource),
    })
    let prefix = source.slice(cursor, declaration.range.start)
    const exported = /export\s*$/.test(prefix)
    if (exported) prefix = prefix.replace(/export\s*$/, '') + 'export '
    output += prefix + `const ${declaration.name} = ${transformedBody}`
    cursor = declaration.range.end
  }
  output += source.slice(cursor)
  const runtimeImports = stateValuesInSource(output)
    ? (output.includes('Binding(')
      ? 'Binding, State, defineView, initializer, resolveBuilderClosure'
      : 'State, defineView, initializer, resolveBuilderClosure')
    : (output.includes('Binding(')
      ? 'Binding, defineView, initializer, resolveBuilderClosure'
      : 'defineView, initializer, resolveBuilderClosure')
  const names = runtimeImports.split(',').map(name => name.trim()).filter(Boolean)
  if (output.includes('namedArguments(') && !names.includes('namedArguments')) names.push('namedArguments')
  if (output.includes('overloadClosure(') && !names.includes('overloadClosure')) names.push('overloadClosure')
  return injectRuntimeImports(output, names.join(', '))
}

function stateValuesInSource(source: string): boolean {
  return /\bstate:\s*\(/.test(source)
}

function injectRuntimeImports(source: string, names: string): string {
  const required = names.split(',').map(name => name.trim()).filter(Boolean)
  const existing = /import\s*\{([\s\S]*?)\}\s*from\s*(['"])@mun\/ui\/legacy\2[\t ]*;?/.exec(source)
  if (!existing) return `import { ${required.join(', ')} } from '@mun/ui/legacy'\n${source}`

  const imported = existing[1].split(',').map(name => name.trim()).filter(Boolean)
  const merged = [...imported]
  for (const name of required) if (!merged.includes(name)) merged.push(name)
  const replacement = `import { ${merged.join(', ')} } from '@mun/ui/legacy'`
  return source.slice(0, existing.index) + replacement + source.slice(existing.index + existing[0].length)
}

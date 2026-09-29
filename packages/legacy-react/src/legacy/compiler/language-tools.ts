import { transformMunBuilderSyntax } from './builder-transform.js'
import { transformMunStructSyntax } from './struct-transform.js'

export interface MunDiagnostic {
  severity: 'error'
  code: 'MUN_SYNTAX'
  message: string
  line: number
  column: number
}

function ensureRuntimeImport(source: string, name: string): string {
  const existing = /import\s*\{([\s\S]*?)\}\s*from\s*(['"])@mun\/ui\/legacy\2[\t ]*;?/.exec(source)
  if (!existing) return `import { ${name} } from '@mun/ui/legacy'\n${source}`
  const imported = existing[1].split(',').map(value => value.trim()).filter(Boolean)
  if (imported.includes(name)) return source
  imported.push(name)
  const replacement = `import { ${imported.join(', ')} } from '@mun/ui/legacy'`
  return source.slice(0, existing.index) + replacement + source.slice(existing.index + existing[0].length)
}

/** The canonical formatter/compiler entry used by editor integrations. */
export function formatMunSource(source: string): string {
  const transformed = transformMunBuilderSyntax(transformMunStructSyntax(source))
  return [
    ...(transformed.includes('namedArguments(') ? ['namedArguments'] : []),
    ...(transformed.includes('overloadClosure(') ? ['overloadClosure'] : []),
  ].reduce((value, name) => ensureRuntimeImport(value, name), transformed)
}

/** Return structured diagnostics without making an editor parse exceptions. */
export function diagnoseMunSource(source: string): readonly MunDiagnostic[] {
  try {
    formatMunSource(source)
    return []
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    const offset = typeof error === 'object' && error !== null && 'offset' in error && typeof error.offset === 'number'
      ? error.offset
      : undefined
    if (offset === undefined) {
      const lineMatch = /line\s+(\d+)/i.exec(message)
      const line = lineMatch ? Number(lineMatch[1]) : 1
      return [{ severity: 'error', code: 'MUN_SYNTAX', message, line, column: 1 }]
    }
    const before = source.slice(0, offset)
    const line = before.split('\n').length
    const lineStart = before.lastIndexOf('\n') + 1
    return [{ severity: 'error', code: 'MUN_SYNTAX', message, line, column: offset - lineStart + 1 }]
  }
}

import { transformMunBuilderSyntax } from './builder-transform.js'
import { transformMunStructSyntax } from './struct-transform.js'
import { createLegacyMunSourceMap } from './source-map.js'

export interface MunViteBuilderOptions {}

function containsMunSyntax(source: string): boolean {
  return /\bstruct\s+[A-Z][A-Za-z0-9_$]*(?:\s*<[^>{}]*>)?\s*:\s*View\b/.test(source)
    || /\b[A-Z][A-Za-z0-9_$]*\s*\([^\n]*\)\s*\{/.test(source)
    || /\b[A-Za-z_$][A-Za-z0-9_$]*\s*:\s*(?:\.|\$|\{)/.test(source)
    || /\.font\s*\(\s*\./.test(source)
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

export function createMunVitePlugin(_options: MunViteBuilderOptions = {}) {
  return {
    name: 'mun-builder-transform',
    enforce: 'pre' as const,
    transform(code: string, id: string) {
      if (!/\.[cm]?[jt]sx?$/.test(id.split('?', 1)[0])) return null
      if (!containsMunSyntax(code)) return null
      const structCode = transformMunStructSyntax(code)
      const lowered = transformMunBuilderSyntax(structCode)
      const result = [
        ...(lowered.includes('namedArguments(') ? ['namedArguments'] : []),
        ...(lowered.includes('overloadClosure(') ? ['overloadClosure'] : []),
      ].reduce((value, name) => ensureRuntimeImport(value, name), lowered)
      return result === code ? null : { code: result, map: createLegacyMunSourceMap(code, result, id.split('?', 1)[0]) }
    }
  }
}

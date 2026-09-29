/**
 * SWC-compatible transform helpers.
 *
 * This module exposes a dependency-free transform adapter. SWC/Babel hosts can
 * pass the source through this adapter before their own AST pipeline without
 * forcing Mun to depend on a specific compiler.
 */
import { transformMunBuilderSyntax } from './builder-transform.js'
import { transformMunStructSyntax } from './struct-transform.js'

export interface MunTransformOptions {}

export function createMunSwcVisitor(_options: MunTransformOptions = {}) {

  return {
    name: 'mun-builder-transform',
    transform(code: string) {
      const lowered = transformMunBuilderSyntax(transformMunStructSyntax(code))
      return [
        ...(lowered.includes('namedArguments(') ? ['namedArguments'] : []),
        ...(lowered.includes('overloadClosure(') ? ['overloadClosure'] : []),
      ].reduce((value, name) => ensureRuntimeImport(value, name), lowered)
    },
  }
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

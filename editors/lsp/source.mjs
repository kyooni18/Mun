// UTF-16 source offsets: JavaScript string indices and LSP character positions
// share the same unit. Never use Buffer byte offsets for language positions.
export function positionAt(source, offset) {
  const before = source.slice(0, Math.max(0, Math.min(source.length, offset)))
  return { line: before.split('\n').length - 1, character: before.length - before.lastIndexOf('\n') - 1 }
}
export function offsetAt(source, position) {
  const lines = source.split('\n')
  const line = Math.max(0, Math.min(lines.length - 1, position?.line ?? 0))
  return lines.slice(0, line).reduce((sum, text) => sum + text.length + 1, 0) + Math.max(0, Math.min(lines[line].replace(/\r$/u, '').length, position?.character ?? 0))
}
export function rangeAt(source, start, end) { return { start: positionAt(source, start), end: positionAt(source, end) } }

// Strings/comments are excluded from identifier indexing. Swift interpolation
// re-enters the code scanner so rename edits expression symbols, not literal text.
export function scan(source) {
  const tokens = [], scopes = [{ start: 0, end: source.length, parent: null }]
  let scope = 0
  function code(start, stopAtParen = false) {
    let depth = 0
    for (let i = start; i < source.length;) {
      const c = source[i]
      if (stopAtParen && c === ')' && depth === 0) return i + 1
      if (source.startsWith('//', i)) { const end = source.indexOf('\n', i); i = end < 0 ? source.length : end; continue }
      if (source.startsWith('/*', i)) {
        let nesting = 1; i += 2
        while (i < source.length && nesting) { if (source.startsWith('/*', i)) { nesting++; i += 2 } else if (source.startsWith('*/', i)) { nesting--; i += 2 } else i++ }
        continue
      }
      if (c === '"' || c === "'" || c === '`') {
        const quote = c; i++
        while (i < source.length) {
          if (source[i] === quote) { i++; break }
          if (source[i] === '\\') {
            if (quote === '"' && source[i + 1] === '(') i = code(i + 2, true)
            else i += 2
          } else i++
        }
        continue
      }
      if (/[A-Za-z_]/u.test(c)) {
        const start = i++
        while (/[A-Za-z0-9_]/u.test(source[i] ?? '')) i++
        tokens.push({ text: source.slice(start, i), start, end: i, scope })
        continue
      }
      if (c === '{') { const parent = scope; scope = scopes.length; scopes.push({ start: i, end: source.length, parent }) }
      if (c === '}') { scopes[scope].end = i + 1; scope = scopes[scope].parent ?? 0 }
      if (c === '(') depth++
      if (c === ')') depth--
      if (!/\s/u.test(c)) tokens.push({ text: c, start: i, end: i + 1, scope })
      i++
    }
    return source.length
  }
  code(0)
  return { tokens, scopes }
}

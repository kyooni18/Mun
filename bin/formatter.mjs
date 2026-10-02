// Canonical structural formatter. Literal and comment tokens remain opaque;
// whitespace decisions operate only on source syntax, never on literal contents.
function stringEnd(source, start) {
  const quote = source[start]
  let i = start + 1
  while (i < source.length) {
    if (source[i] === '\\') {
      if (quote === '"' && source[i + 1] === '(') {
        i += 2; let depth = 1
        while (i < source.length && depth) {
          if (source[i] === '"' || source[i] === "'") i = stringEnd(source, i)
          else if (source.startsWith('/*', i)) { const end = source.indexOf('*/', i + 2); i = end < 0 ? source.length : end + 2 }
          else { if (source[i] === '(') depth++; if (source[i] === ')') depth--; i++ }
        }
      } else i += 2
    } else if (source[i++] === quote) return i
  }
  return i
}
function tokenize(source) {
  const tokens = []
  let newline = false, breaks = 0
  for (let i = 0; i < source.length;) {
    if (/\s/u.test(source[i])) { if (source[i] === '\n') { newline = true; breaks++ } i++; continue }
    const start = i
    let kind = 'punctuation'
    if (source.startsWith('//', i)) {
      kind = 'lineComment'; const end = source.indexOf('\n', i); i = end < 0 ? source.length : end
    } else if (source.startsWith('/*', i)) {
      kind = 'comment'; i += 2; let depth = 1
      while (i < source.length && depth) {
        if (source.startsWith('/*', i)) { depth++; i += 2 }
        else if (source.startsWith('*/', i)) { depth--; i += 2 }
        else i++
      }
    } else if (source[i] === '"' || source[i] === "'") {
      kind = 'literal'; i = stringEnd(source, i)
    } else if (/[0-9]/u.test(source[i])) {
      kind = 'literal'
      const number = /^(?:[0-9]+(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?)/u.exec(source.slice(i))[0]
      i += number.length
    } else if (/[A-Za-z_]/u.test(source[i])) {
      kind = 'word'; i++
      while (/[A-Za-z_0-9]/u.test(source[i] ?? '')) i++
    } else {
      const operator = /^(?:\.\.\.|\.\.<|->|\+=|-=|\*=|\/=|==|!=|<=|>=|&&|\|\||\?\?)/u.exec(source.slice(i))?.[0]
      i += operator?.length ?? 1
    }
    tokens.push({ text: source.slice(start, i), kind, newline, blank: breaks > 1 }); newline = false; breaks = 0
  }
  return tokens
}

export function formatSource(source) {
  // Raw/multiline literals are not reformatted until their indentation contract
  // can be preserved. This is deliberate, not a lossy best-effort transformation.
  if (source.includes('"""') || source.includes('`') || source.includes('#"')) return source
  const tokens = tokenize(source.replace(/\r\n/gu, '\n'))
  const lines = [], stack = []
  let line = '', previous
  const indent = () => stack.filter(item => item.multiline).length
  const flush = () => { if (line.trim()) lines.push(`${'  '.repeat(indent())}${line.trim()}`); line = '' }
  const write = (text, space = false) => { if (space && line && !line.endsWith(' ')) line += ' '; line += text }
  const binary = new Set(['=', '+=', '-=', '*=', '/=', '==', '!=', '<=', '>=', '&&', '||', '??', '->', '+', '*', '/'])
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index], next = tokens[index + 1], text = token.text
    if (token.newline && line && !['.', ',', ')', ']'].includes(text) && previous?.text !== '@') flush()
    if (token.blank) { flush(); if (lines.length && lines.at(-1) !== '') lines.push('') }
    if (text === '}') {
      flush(); const block = stack.pop(); write('}')
      if (block?.block && next?.text !== 'else' && ![')', ']', ',', ';', '.'].includes(next?.text)) flush()
    } else if (text === '{') {
      write('{', !!line)
      flush(); stack.push({ block: true, multiline: true })
    } else if (text === '(' || text === '[') {
      const multiline = !!next?.newline
      write(text, text === '[' && ['return', 'in'].includes(previous?.text))
      if (multiline) flush()
      stack.push({ block: false, multiline })
    } else if (text === ')' || text === ']') {
      const delimiter = stack.at(-1)
      if (delimiter?.multiline) flush()
      stack.pop(); write(text)
    } else if (text === ',') {
      write(','); if (next?.newline) flush(); else write(' ')
    } else if (text === ':') {
      write(':'); write(' ')
    } else if (text === ';') {
      write(';'); flush()
    } else if (text === '.') {
      if (token.newline && line) flush()
      write('.')
    } else if (text === '@' || text === '$') {
      write(text, previous?.kind === 'word')
    } else if (token.kind === 'lineComment') {
      write(text, !!line); flush()
    } else if (token.kind === 'comment') {
      write(text, !!line); if (next?.newline) flush()
    } else if (binary.has(text)) {
      write(text, true); write(' ')
    } else {
      const space = line && previous && (previous.kind === 'word' || previous.kind === 'literal' || previous.kind === 'comment' || [')', ']', '}'].includes(previous.text))
      write(text, !!space)
    }
    previous = token
  }
  flush()
  return `${lines.join('\n')}\n`
}

const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

function vlq(value: number): string {
  let current = value < 0 ? ((-value) << 1) | 1 : value << 1
  let output = ''
  do {
    let digit = current & 31
    current >>>= 5
    if (current > 0) digit |= 32
    output += alphabet[digit]
  } while (current > 0)
  return output
}

export interface MunSourceMapAnchor {
  readonly line: number
  readonly column: number
  readonly generatedColumn: number
}

export interface MunSourcePosition {
  readonly line: number
  readonly column: number
}

export interface MunSourceMap {
  readonly version: 3
  readonly file: string
  readonly sources: readonly string[]
  readonly sourcesContent: readonly string[]
  readonly names: readonly string[]
  readonly mappings: string
  /** Line anchors are intentionally retained for editor/TypeScript adapters. */
  readonly x_mun: {
    readonly lineMappings: readonly MunSourceMapAnchor[]
    readonly segments: readonly (readonly MunSourceMapAnchor[])[]
  }
}

function tokens(line: string): Array<{ value: string; column: number }> {
  return [...line.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)].map(match => ({
    value: match[0],
    column: match.index ?? 0,
  }))
}

interface SourceToken {
  readonly value: string
  readonly line: number
  readonly column: number
}

function allTokens(source: string): SourceToken[] {
  return source.split('\n').flatMap((line, lineIndex) => tokens(line).map(token => ({
    value: token.value,
    line: lineIndex,
    column: token.column,
  })))
}

function tokenKey(line: number, column: number): string {
  return `${line}:${column}`
}

/** Match generated occurrences to source occurrences in order, not by name alone. */
function alignTokenAnchors(source: string, generated: string): Map<string, { line: number; column: number }> {
  const original = allTokens(source)
  const output = allTokens(generated)
  const anchors = new Map<string, { line: number; column: number }>()
  let cursor = 0
  let previous = { line: 0, column: 0 }
  for (const token of output) {
    while (cursor < original.length && original[cursor].value !== token.value) cursor += 1
    const anchor = original[cursor]
    if (anchor) {
      previous = { line: anchor.line, column: anchor.column }
      cursor += 1
    }
    anchors.set(tokenKey(token.line, token.column), previous)
  }
  return anchors
}

function sourceAnchorForToken(
  token: string,
  sourceTokens: ReadonlyMap<string, readonly { line: number; column: number }[]>,
  fallbackLine: number,
): { line: number; column: number } | undefined {
  const candidates = sourceTokens.get(token) ?? []
  let best: { score: number; distance: number; line: number; column: number } | undefined
  for (const candidate of candidates) {
    const distance = Math.abs(candidate.line - fallbackLine)
    const score = token.length - distance
    if (!best || score > best.score || (score === best.score && distance < best.distance)) {
      best = { score, distance, line: candidate.line, column: candidate.column }
    }
  }
  return best ? { line: best.line, column: best.column } : undefined
}

function anchorsForGeneratedLine(
  generatedLine: string,
  generatedLineIndex: number,
  sourceLines: readonly string[],
  sourceTokens: ReadonlyMap<string, readonly { line: number; column: number }[]>,
  alignedAnchors: ReadonlyMap<string, { line: number; column: number }>,
  fallbackLine: number,
): MunSourceMapAnchor[] {
  const generatedTokens = tokens(generatedLine)
  if (generatedTokens.length === 0) {
    return [{ line: Math.min(fallbackLine, sourceLines.length - 1), column: 0, generatedColumn: 0 }]
  }
  return generatedTokens.map(token => {
    const source = alignedAnchors.get(tokenKey(generatedLineIndex, token.column))
      ?? sourceAnchorForToken(token.value, sourceTokens, fallbackLine)
      ?? { line: Math.min(fallbackLine, sourceLines.length - 1), column: 0 }
    return { ...source, generatedColumn: token.column }
  })
}

/**
 * Produce a line-preserving source map for lexical transforms. The transform
 * keeps original expression text wherever possible, so line anchors are more
 * useful than returning `null`; generated columns that are synthesized by a
 * builder are intentionally anchored at the beginning of their source line.
 */
export function createMunSourceMap(source: string, generated: string, id: string): MunSourceMap {
  const sourceLineValues = source.split('\n')
  const sourceLines = Math.max(1, sourceLineValues.length)
  const sourceTokens = new Map<string, Array<{ line: number; column: number }>>()
  sourceLineValues.forEach((line, lineIndex) => {
    for (const token of tokens(line)) {
      const values = sourceTokens.get(token.value) ?? []
      values.push({ line: lineIndex, column: token.column })
      sourceTokens.set(token.value, values)
    }
  })
  if (source === generated) {
    const identitySegments = sourceLineValues.map((_, line) => [{ line, column: 0, generatedColumn: 0 }])
    let previousLine = 0
    const mappings = identitySegments.map(([anchor]) => {
      const value = `${vlq(0)}${vlq(0)}${vlq(anchor.line - previousLine)}${vlq(0)}`
      previousLine = anchor.line
      return value
    }).join(';')
    return {
      version: 3,
      file: id,
      sources: [id],
      sourcesContent: [source],
      names: [],
      mappings,
      x_mun: { lineMappings: identitySegments.map(value => value[0]), segments: identitySegments },
    }
  }
  const alignedAnchors = alignTokenAnchors(source, generated)
  let previousOriginalLine = 0
  let previousOriginalColumn = 0
  const segments = generated.split('\n').map((generatedLine, line) => anchorsForGeneratedLine(
    generatedLine,
    line,
    sourceLineValues,
    sourceTokens,
    alignedAnchors,
    Math.min(line, sourceLines - 1),
  ))
  const lineMappings = segments.map(value => value[0])
  const mappings = segments.map(lineSegments => {
    let previousGeneratedColumn = 0
    return lineSegments.map(anchor => {
      const mapping = `${vlq(anchor.generatedColumn - previousGeneratedColumn)}${vlq(0)}${vlq(anchor.line - previousOriginalLine)}${vlq(anchor.column - previousOriginalColumn)}`
      previousGeneratedColumn = anchor.generatedColumn
      previousOriginalLine = anchor.line
      previousOriginalColumn = anchor.column
      return mapping
    }).join(',')
  }).join(';')
  return {
    version: 3,
    file: id,
    sources: [id],
    sourcesContent: [source],
    names: [],
    mappings,
    x_mun: { lineMappings, segments },
  }
}

/** Standard-only compatibility map for Vite callers that do not consume Mun anchors. */
export function createLegacyMunSourceMap(
  source: string,
  generated: string,
  id: string,
): Omit<MunSourceMap, 'x_mun'> {
  const rich = createMunSourceMap(source, generated, id)
  let previousOriginalLine = 0
  let previousOriginalColumn = 0
  const mappings = rich.x_mun.lineMappings.map(anchor => {
    const value = `${vlq(0)}${vlq(0)}${vlq(anchor.line - previousOriginalLine)}${vlq(anchor.column - previousOriginalColumn)}`
    previousOriginalLine = anchor.line
    previousOriginalColumn = anchor.column
    return value
  }).join(';')
  const { x_mun: _xMun, ...standard } = rich
  return { ...standard, mappings }
}

/** Map a generated TypeScript position back to its original Mun position. */
export function mapGeneratedPosition(map: MunSourceMap, position: MunSourcePosition): MunSourcePosition {
  const line = Math.max(1, Math.trunc(position.line))
  const column = Math.max(1, Math.trunc(position.column))
  const anchors = map.x_mun.segments[Math.min(line - 1, Math.max(0, map.x_mun.segments.length - 1))]
    ?? map.x_mun.lineMappings
  const generatedColumn = column - 1
  const anchor = [...anchors].reverse().find(value => value.generatedColumn <= generatedColumn)
    ?? anchors[0]
    ?? { line: 0, column: 0, generatedColumn: 0 }
  return {
    line: anchor.line + 1,
    column: anchor.column + Math.max(0, generatedColumn - anchor.generatedColumn) + 1,
  }
}

/** Map an original Mun position to the nearest generated position. */
export function mapOriginalPosition(map: MunSourceMap, position: MunSourcePosition): MunSourcePosition {
  const line = Math.max(1, Math.trunc(position.line)) - 1
  const column = Math.max(1, Math.trunc(position.column)) - 1
  const segments = map.x_mun.segments
  if (segments.length === 0) return { line: 1, column: 1 }

  let bestLine = 0
  let bestAnchor = map.x_mun.lineMappings[0]
  let bestDistance = Number.POSITIVE_INFINITY
  for (let lineIndex = 0; lineIndex < segments.length; lineIndex += 1) {
    for (const candidate of segments[lineIndex]) {
      const distance = Math.abs(candidate.line - line) * 10000 + Math.abs(candidate.column - column)
      if (distance >= bestDistance) continue
      bestDistance = distance
      bestLine = lineIndex
      bestAnchor = candidate
    }
  }
  const anchor = bestAnchor ?? { line: 0, column: 0, generatedColumn: 0 }
  return {
    line: bestLine + 1,
    column: Math.max(1, anchor.generatedColumn + column - anchor.column + 1),
  }
}

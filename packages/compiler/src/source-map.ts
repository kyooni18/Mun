const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"

function vlq(value: number): string {
  let current = value < 0 ? ((-value) << 1) | 1 : value << 1
  let output = ""
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

export interface MunSourceMap {
  readonly version: 3
  readonly file?: string
  readonly sources: readonly string[]
  readonly sourcesContent: readonly string[]
  readonly names: readonly string[]
  readonly mappings: string
  readonly x_mun: {
    readonly lineMappings: readonly MunSourceMapAnchor[]
    readonly segments: readonly (readonly MunSourceMapAnchor[])[]
  }
}

interface Token {
  readonly value: string
  readonly line: number
  readonly column: number
  readonly order: number
}

const maximumTokenCacheEntries = 64
const lineTokenCache = new Map<string, readonly { value: string; column: number }[]>()
const sourceTokenCache = new Map<string, readonly Token[]>()

function rememberTokenCache<T>(cache: Map<string, T>, value: string, tokens_: T): T {
  cache.delete(value)
  cache.set(value, tokens_)
  while (cache.size > maximumTokenCacheEntries) {
    const oldest = cache.keys().next().value as string | undefined
    if (oldest === undefined) break
    cache.delete(oldest)
  }
  return tokens_
}

function tokens(line: string): readonly { value: string; column: number }[] {
  const cached = lineTokenCache.get(line)
  if (cached) {
    lineTokenCache.delete(line)
    lineTokenCache.set(line, cached)
    return cached
  }
  return rememberTokenCache(lineTokenCache, line, Object.freeze([...line.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/g)].map(match => ({
    value: match[0],
    column: match.index ?? 0,
  }))))
}

function allTokens(source: string): readonly Token[] {
  const cached = sourceTokenCache.get(source)
  if (cached) {
    sourceTokenCache.delete(source)
    sourceTokenCache.set(source, cached)
    return cached
  }
  let order = 0
  const result = source.split("\n").flatMap((line, lineIndex) => tokens(line).map(token => ({
    value: token.value,
    line: lineIndex,
    column: token.column,
    order: order++,
  })))
  return rememberTokenCache(sourceTokenCache, source, Object.freeze(result))
}

function key(line: number, column: number): string {
  return `${line}:${column}`
}

function tokensByValue(values: readonly Token[]): Map<string, Token[]> {
  const result = new Map<string, Token[]>()
  for (const token of values) {
    const bucket = result.get(token.value) ?? []
    bucket.push(token)
    result.set(token.value, bucket)
  }
  return result
}

/**
 * Score an original occurrence by its lexical neighbourhood. Mun lowering can
 * move code (notably top-level State declarations), so monotonic token matching
 * is not sufficient: `count` in a generated State factory must map back to the
 * declaration, while `count` in the body must map to its original use.
 */
function contextualScore(generated: readonly Token[], generatedIndex: number, original: readonly Token[], originalIndex: number): number {
  let score = 0
  const generatedToken = generated[generatedIndex]
  const originalToken = original[originalIndex]
  if (generatedToken.value !== originalToken.value) return Number.NEGATIVE_INFINITY

  // Immediate neighbours are the strongest signal; wider neighbours tolerate
  // synthetic helper identifiers inserted by the lowering passes.
  for (let distance = 1; distance <= 5; distance += 1) {
    const weight = 18 / distance
    if (generated[generatedIndex - distance]?.value === original[originalIndex - distance]?.value) score += weight
    if (generated[generatedIndex + distance]?.value === original[originalIndex + distance]?.value) score += weight
  }

  const generatedWindow = generated.slice(Math.max(0, generatedIndex - 5), generatedIndex + 6)
  const originalWindow = original.slice(Math.max(0, originalIndex - 5), originalIndex + 6)
  for (const neighbour of generatedWindow) {
    if (neighbour === generatedToken) continue
    const match = originalWindow.find(candidate => candidate.value === neighbour.value)
    if (match) score += 2
  }

  // Same-line companions are useful for moved declarations and calls.
  const generatedLineValues = new Set(generatedWindow.filter(token => token.line === generatedToken.line).map(token => token.value))
  const originalLineValues = new Set(originalWindow.filter(token => token.line === originalToken.line).map(token => token.value))
  for (const value of generatedLineValues) if (originalLineValues.has(value)) score += 1
  return score
}

const maximumContextCandidates = 128

function candidateWindow(candidates: readonly Token[], cursor: number): readonly Token[] {
  if (candidates.length <= maximumContextCandidates) return candidates
  let low = 0
  let high = candidates.length
  while (low < high) {
    const middle = (low + high) >>> 1
    if (candidates[middle].order < cursor) low = middle + 1
    else high = middle
  }
  const start = Math.max(0, Math.min(low - maximumContextCandidates / 2, candidates.length - maximumContextCandidates))
  return candidates.slice(start, start + maximumContextCandidates)
}

function alignTokens(original: readonly Token[], generatedTokens: readonly Token[]): Map<string, { line: number; column: number }> {
  const originalByValue = tokensByValue(original)
  const originalIndex = new Map<number, number>(original.map((token, index) => [token.order, index]))
  const anchors = new Map<string, { line: number; column: number }>()
  let monotonicCursor = 0
  let previous = { line: 0, column: 0 }

  for (let generatedIndex = 0; generatedIndex < generatedTokens.length; generatedIndex += 1) {
    const token = generatedTokens[generatedIndex]
    const candidates = candidateWindow(originalByValue.get(token.value) ?? [], monotonicCursor)
    let best: Token | undefined
    let bestScore = Number.NEGATIVE_INFINITY
    for (const candidate of candidates) {
      const index = originalIndex.get(candidate.order) ?? 0
      const context = contextualScore(generatedTokens, generatedIndex, original, index)
      // Preserve source order only as a weak tie breaker. This keeps ordinary
      // unchanged code stable without defeating genuinely moved spans.
      const orderBonus = candidate.order >= monotonicCursor ? 0.25 : 0
      const lineBonus = candidate.line === token.line ? 0.1 : 0
      const score = context + orderBonus + lineBonus
      if (score > bestScore) {
        best = candidate
        bestScore = score
      } else if (score === bestScore && best) {
        const bestDistance = Math.abs(best.order - monotonicCursor)
        const nextDistance = Math.abs(candidate.order - monotonicCursor)
        if (nextDistance < bestDistance) best = candidate
      }
    }
    if (best) {
      previous = { line: best.line, column: best.column }
      if (best.order >= monotonicCursor) monotonicCursor = best.order + 1
    }
    anchors.set(key(token.line, token.column), previous)
  }
  return anchors
}

function fallbackAnchor(sourceLines: number, line: number): { line: number; column: number } {
  return { line: Math.min(Math.max(0, line), sourceLines - 1), column: 0 }
}

function lineAnchors(
  generatedLine: string,
  line: number,
  sourceLines: number,
  sourceTokens: ReadonlyMap<string, readonly Token[]>,
  aligned: ReadonlyMap<string, { line: number; column: number }>,
): MunSourceMapAnchor[] {
  const generatedTokens = tokens(generatedLine)
  if (generatedTokens.length === 0) return [{ ...fallbackAnchor(sourceLines, line), generatedColumn: 0 }]
  return generatedTokens.map(token => {
    const anchor = aligned.get(key(line, token.column)) ?? sourceTokens.get(token.value)?.[0] ?? fallbackAnchor(sourceLines, line)
    return { line: anchor.line, column: anchor.column, generatedColumn: token.column }
  })
}

/** Create a context-anchored VLQ map for the Mun lowering pipeline. */
export function createMunSourceMap(source: string, generated: string, id: string): MunSourceMap {
  const sourceLines = Math.max(1, source.split("\n").length)
  const originalTokens = allTokens(source)
  const generatedTokens = allTokens(generated)
  const aligned = alignTokens(originalTokens, generatedTokens)
  const sourceByValue = tokensByValue(originalTokens)
  const segments = generated.split("\n").map((line, index) => lineAnchors(line, index, sourceLines, sourceByValue, aligned))
  let previousLine = 0
  let previousColumn = 0
  const mappings = segments.map(line => {
    let previousGeneratedColumn = 0
    return line.map(anchor => {
      const value = `${vlq(anchor.generatedColumn - previousGeneratedColumn)}${vlq(0)}${vlq(anchor.line - previousLine)}${vlq(anchor.column - previousColumn)}`
      previousGeneratedColumn = anchor.generatedColumn
      previousLine = anchor.line
      previousColumn = anchor.column
      return value
    }).join(",")
  }).join(";")
  return {
    version: 3,
    file: id,
    sources: [id],
    sourcesContent: [source],
    names: [],
    mappings,
    x_mun: { lineMappings: segments.map(line => line[0]), segments },
  }
}

export interface MunSourcePosition {
  readonly line: number
  readonly column: number
}

export function mapGeneratedPosition(map: MunSourceMap, position: MunSourcePosition): MunSourcePosition {
  const line = Math.max(1, Math.trunc(position.line))
  const column = Math.max(1, Math.trunc(position.column)) - 1
  const anchors = map.x_mun.segments[Math.min(line - 1, map.x_mun.segments.length - 1)] ?? []
  const anchor = [...anchors].reverse().find(item => item.generatedColumn <= column) ?? anchors[0] ?? { line: 0, column: 0, generatedColumn: 0 }
  return { line: anchor.line + 1, column: anchor.column + Math.max(0, column - anchor.generatedColumn) + 1 }
}

export function mapOriginalPosition(map: MunSourceMap, position: MunSourcePosition): MunSourcePosition {
  const line = Math.max(1, Math.trunc(position.line)) - 1
  const column = Math.max(1, Math.trunc(position.column)) - 1
  let bestLine = 0
  let best = map.x_mun.lineMappings[0] ?? { line: 0, column: 0, generatedColumn: 0 }
  let distance = Number.POSITIVE_INFINITY
  for (let generatedLine = 0; generatedLine < map.x_mun.segments.length; generatedLine += 1) {
    for (const candidate of map.x_mun.segments[generatedLine]) {
      const nextDistance = Math.abs(candidate.line - line) * 10000 + Math.abs(candidate.column - column)
      if (nextDistance >= distance) continue
      distance = nextDistance
      bestLine = generatedLine
      best = candidate
    }
  }
  return { line: bestLine + 1, column: Math.max(1, best.generatedColumn + column - best.column + 1) }
}

import type { InterpolatorOptions } from "@mun/animation"
import { createPathMorpher, parsePath, type ParsedPathSegment } from "@mun/animation/path"

interface PathGeometry {
  readonly centroidX: number
  readonly centroidY: number
  readonly width: number
  readonly height: number
  readonly length: number
  readonly area: number
  readonly closedRatio: number
  readonly subpathCount: number
}

export interface SvgPathMatchInput {
  readonly id?: string
  readonly d: string
  readonly fill?: string
  readonly stroke?: string
  readonly strokeWidth?: string | number
}

export interface SvgPathMatch {
  readonly sourceIndex: number
  readonly targetIndex: number
  readonly cost: number
  readonly confidence: number
}

function cubicPoint(segment: ParsedPathSegment, t: number): { x: number; y: number } {
  const mt = 1 - t
  const mt2 = mt * mt
  const t2 = t * t
  return {
    x: segment.p0.x * mt2 * mt + 3 * segment.p1.x * mt2 * t + 3 * segment.p2.x * mt * t2 + segment.p3.x * t2 * t,
    y: segment.p0.y * mt2 * mt + 3 * segment.p1.y * mt2 * t + 3 * segment.p2.y * mt * t2 + segment.p3.y * t2 * t,
  }
}

function distance(a: { x: number; y: number }, b: { x: number; y: number }): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function geometryFromParsed(parsed: ReturnType<typeof parsePath>): PathGeometry {
  const points: Array<{ x: number; y: number }> = []
  let length = 0
  let closed = 0
  let area = 0
  for (const subpath of parsed.subpaths) {
    if (subpath.closed) closed += 1
    const contour: Array<{ x: number; y: number }> = []
    for (const segment of subpath.segments) {
      let previous = segment.p0
      if (contour.length === 0) contour.push(previous)
      points.push(segment.p0, segment.p1, segment.p2, segment.p3)
      for (const t of [0.25, 0.5, 0.75, 1]) {
        const next = cubicPoint(segment, t)
        length += distance(previous, next)
        previous = next
        contour.push(next)
      }
    }
    if (subpath.closed && contour.length > 2) {
      let signed = 0
      for (let index = 0; index < contour.length; index += 1) {
        const a = contour[index]
        const b = contour[(index + 1) % contour.length]
        signed += a.x * b.y - b.x * a.y
      }
      area += signed * 0.5
    }
  }
  if (points.length === 0) return { centroidX: 0, centroidY: 0, width: 0, height: 0, length: 0, area: 0, closedRatio: 0, subpathCount: 0 }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  let sumX = 0
  let sumY = 0
  for (const point of points) {
    minX = Math.min(minX, point.x)
    minY = Math.min(minY, point.y)
    maxX = Math.max(maxX, point.x)
    maxY = Math.max(maxY, point.y)
    sumX += point.x
    sumY += point.y
  }
  return {
    centroidX: sumX / points.length,
    centroidY: sumY / points.length,
    width: Math.max(0, maxX - minX),
    height: Math.max(0, maxY - minY),
    length,
    area,
    closedRatio: parsed.subpaths.length > 0 ? closed / parsed.subpaths.length : 0,
    subpathCount: parsed.subpaths.length,
  }
}

function pathGeometry(path: string): PathGeometry {
  try { return geometryFromParsed(parsePath(path)) }
  catch { return { centroidX: 0, centroidY: 0, width: 0, height: 0, length: 0, area: 0, closedRatio: 0, subpathCount: 0 } }
}

function ratioPenalty(a: number, b: number): number {
  if (a <= 1e-6 && b <= 1e-6) return 0
  return Math.abs(Math.log((Math.max(a, 1e-6)) / Math.max(b, 1e-6)))
}

function presentationKind(input: SvgPathMatchInput): "stroke" | "fill" | "mixed" {
  const hasStroke = Boolean(input.stroke && input.stroke !== "none")
  const hasFill = Boolean(input.fill && input.fill !== "none")
  if (hasStroke && hasFill) return "mixed"
  return hasStroke ? "stroke" : "fill"
}

function geometryCost(left: PathGeometry, right: PathGeometry, leftInput?: SvgPathMatchInput, rightInput?: SvgPathMatchInput): number {
  const scale = Math.max(2, (Math.hypot(left.width, left.height) + Math.hypot(right.width, right.height)) * 0.5)
  const position = Math.hypot(left.centroidX - right.centroidX, left.centroidY - right.centroidY) / scale
  const size = (ratioPenalty(left.width, right.width) + ratioPenalty(left.height, right.height)) * 0.35
  const length = ratioPenalty(left.length, right.length) * 0.3
  const topology = Math.abs(left.closedRatio - right.closedRatio) * 1.4 + Math.abs(left.subpathCount - right.subpathCount) * 0.28
  const area = ratioPenalty(Math.abs(left.area), Math.abs(right.area)) * 0.12
  const style = leftInput && rightInput && presentationKind(leftInput) !== presentationKind(rightInput) ? 0.75 : 0
  return position + size + length + topology + area + style
}

/** Minimum-cost one-to-one assignment for the smaller side of a path set. */
function minimumAssignment(costs: readonly (readonly number[])[]): Array<[number, number]> {
  if (costs.length === 0 || costs[0]?.length === 0) return []
  const rows = costs.length
  const columns = costs[0].length
  if (rows > columns) {
    const transposed = Array.from({ length: columns }, (_value, column) => Array.from({ length: rows }, (_unused, row) => costs[row][column]))
    return minimumAssignment(transposed).map(([column, row]) => [row, column])
  }
  // Rectangular Hungarian algorithm (rows <= columns), O(n^2 m). Icon layers
  // are normally single-digit counts, so this is comfortably preprocessing-only.
  const u = new Float64Array(rows + 1)
  const v = new Float64Array(columns + 1)
  const p = new Int32Array(columns + 1)
  const way = new Int32Array(columns + 1)
  for (let row = 1; row <= rows; row += 1) {
    p[0] = row
    let column0 = 0
    const minv = new Float64Array(columns + 1)
    minv.fill(Infinity)
    const used = new Uint8Array(columns + 1)
    do {
      used[column0] = 1
      const row0 = p[column0]
      let delta = Infinity
      let column1 = 0
      for (let column = 1; column <= columns; column += 1) {
        if (used[column]) continue
        const current = costs[row0 - 1][column - 1] - u[row0] - v[column]
        if (current < minv[column]) { minv[column] = current; way[column] = column0 }
        if (minv[column] < delta) { delta = minv[column]; column1 = column }
      }
      for (let column = 0; column <= columns; column += 1) {
        if (used[column]) { u[p[column]] += delta; v[column] -= delta }
        else minv[column] -= delta
      }
      column0 = column1
    } while (p[column0] !== 0)
    do {
      const column1 = way[column0]
      p[column0] = p[column1]
      column0 = column1
    } while (column0 !== 0)
  }
  const result: Array<[number, number]> = []
  for (let column = 1; column <= columns; column += 1) if (p[column] !== 0) result.push([p[column] - 1, column - 1])
  return result
}

/** Geometry/style-aware layer correspondence for icon packs without semantic IDs. */
export function matchSvgPathLayers(sources: readonly SvgPathMatchInput[], targets: readonly SvgPathMatchInput[]): SvgPathMatch[] {
  if (sources.length === 0 || targets.length === 0) return []
  const sourceGeometry = sources.map(source => pathGeometry(source.d))
  const targetGeometry = targets.map(target => pathGeometry(target.d))
  const costs = sourceGeometry.map((left, sourceIndex) => targetGeometry.map((right, targetIndex) => geometryCost(left, right, sources[sourceIndex], targets[targetIndex])))
  const assignment = minimumAssignment(costs)
  return assignment.map(([sourceIndex, targetIndex]) => {
    const cost = costs[sourceIndex][targetIndex]
    return { sourceIndex, targetIndex, cost, confidence: Math.exp(-cost / 2.2) }
  }).sort((a, b) => a.sourceIndex - b.sourceIndex)
}

function formatNumber(value: number): string {
  const normalized = Math.abs(value) < 1e-9 ? 0 : Math.round(value * 10000) / 10000
  return String(normalized)
}

function formatSubpath(subpath: ReturnType<typeof parsePath>["subpaths"][number], transform?: (point: { x: number; y: number }) => { x: number; y: number }): string {
  if (subpath.segments.length === 0) return ""
  const map = transform ?? (point => point)
  const first = map(subpath.segments[0].p0)
  const parts = [`M${formatNumber(first.x)} ${formatNumber(first.y)}`]
  for (const segment of subpath.segments) {
    const p1 = map(segment.p1)
    const p2 = map(segment.p2)
    const p3 = map(segment.p3)
    parts.push(`C${formatNumber(p1.x)} ${formatNumber(p1.y)} ${formatNumber(p2.x)} ${formatNumber(p2.y)} ${formatNumber(p3.x)} ${formatNumber(p3.y)}`)
  }
  if (subpath.closed) parts.push("Z")
  return parts.join(" ")
}

function canonicalSubpaths(path: string): Array<{ d: string; geometry: PathGeometry }> {
  let parsed: ReturnType<typeof parsePath>
  try { parsed = parsePath(path) }
  catch { return [] }
  return parsed.subpaths.map(subpath => {
    const single = { subpaths: [subpath] }
    return { d: formatSubpath(subpath), geometry: geometryFromParsed(single) }
  })
}

/**
 * Equalize compound-path topology using contour geometry rather than source
 * order. Extra contours duplicate the closest matched contour, so holes and
 * outer boundaries split/merge from perceptually related geometry.
 */
export function equalizeSvgPathSubpaths(from: string, to: string): readonly [string, string] {
  const left = canonicalSubpaths(from)
  const right = canonicalSubpaths(to)
  if (left.length === 0 || right.length === 0) return [from, to]
  if (left.length === 1 && right.length === 1) return [from, to]
  const costs = left.map(a => right.map(b => geometryCost(a.geometry, b.geometry)))
  const assignment = minimumAssignment(costs)
  const pairedLeft: string[] = []
  const pairedRight: string[] = []
  const usedLeft = new Set<number>()
  const usedRight = new Set<number>()
  for (const [leftIndex, rightIndex] of assignment) {
    pairedLeft.push(left[leftIndex].d)
    pairedRight.push(right[rightIndex].d)
    usedLeft.add(leftIndex)
    usedRight.add(rightIndex)
  }
  for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
    if (usedRight.has(rightIndex)) continue
    let bestLeft = 0
    let bestCost = Infinity
    for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
      const cost = costs[leftIndex][rightIndex]
      if (cost < bestCost) { bestCost = cost; bestLeft = leftIndex }
    }
    pairedLeft.push(left[bestLeft].d)
    pairedRight.push(right[rightIndex].d)
  }
  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    if (usedLeft.has(leftIndex)) continue
    let bestRight = 0
    let bestCost = Infinity
    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      const cost = costs[leftIndex][rightIndex]
      if (cost < bestCost) { bestCost = cost; bestRight = rightIndex }
    }
    pairedLeft.push(left[leftIndex].d)
    pairedRight.push(right[bestRight].d)
  }
  return [pairedLeft.join(" "), pairedRight.join(" ")]
}

function parseViewBox(value: string | undefined): readonly [number, number, number, number] | undefined {
  if (!value) return undefined
  const values = value.trim().split(/[\s,]+/).map(Number)
  return values.length === 4 && values.every(Number.isFinite) && values[2] > 0 && values[3] > 0
    ? [values[0], values[1], values[2], values[3]]
    : undefined
}

/** Map path coordinates into another symbol's viewBox before overlay morphing. */
export function mapSvgPathBetweenViewBoxes(path: string, pathViewBox: string | undefined, destinationViewBox: string | undefined): string {
  const source = parseViewBox(pathViewBox)
  const destination = parseViewBox(destinationViewBox)
  if (!source || !destination || source.every((value, index) => value === destination[index])) return path
  const scaleX = destination[2] / source[2]
  const scaleY = destination[3] / source[3]
  const transform = (point: { x: number; y: number }) => ({
    x: destination[0] + (point.x - source[0]) * scaleX,
    y: destination[1] + (point.y - source[1]) * scaleY,
  })
  try { return parsePath(path).subpaths.map(subpath => formatSubpath(subpath, transform)).join(" ") }
  catch { return path }
}

export function svgPathLength(path: string): number {
  return pathGeometry(path).length
}

export function createSvgPathInterpolator(from: string, to: string): (progress: number) => string {
  const [normalizedFrom, normalizedTo] = equalizeSvgPathSubpaths(from, to)
  const morpher = createPathMorpher(normalizedFrom, normalizedTo)
  return progress => {
    if (progress === 0) return from
    if (progress === 1) return to
    if (!Number.isFinite(progress)) return progress > 0 ? to : from
    const output = morpher.buffer
    for (let index = 0; index < morpher.from.length; index += 1) {
      output[index] = morpher.from[index] + (morpher.to[index] - morpher.from[index]) * progress
    }
    return morpher.format(output)
  }
}

/** @mun/animation custom interpolation option that retains exact authored endpoints. */
export function svgPathInterpolatorOptions(from: string, to: string): InterpolatorOptions {
  const interpolate = createSvgPathInterpolator(from, to)
  return { interpolate: (_from, _to, progress) => interpolate(progress) }
}

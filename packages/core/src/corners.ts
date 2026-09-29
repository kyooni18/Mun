/**
 * Continuous-corner path generation based on the Figma/Lisse squircle
 * construction. The math stays DOM-free so every Mun renderer can share it.
 */
export interface CornerRadii {
  readonly topLeft: number
  readonly topRight: number
  readonly bottomRight: number
  readonly bottomLeft: number
}

export interface CornerRadiusStrings {
  readonly topLeft: string
  readonly topRight: string
  readonly bottomRight: string
  readonly bottomLeft: string
}

export const APPLE_CONTINUOUS_CORNER_SMOOTHING = 0.65
export const FIGMA_CONTINUOUS_CORNER_SMOOTHING = 0.6

const toRadians = (degrees: number): number => degrees * Math.PI / 180
const round4 = (value: number): number => Math.round(value * 1e4) / 1e4
const finiteNonNegative = (value: number): number => Number.isFinite(value) ? Math.max(0, value) : 0
const clampedSmoothing = (value: number): number => Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : APPLE_CONTINUOUS_CORNER_SMOOTHING

/** Expand the horizontal half of CSS `border-radius` shorthand. */
export function expandCornerRadiusShorthand(value: string): CornerRadiusStrings {
  const horizontal = value.split("/", 1)[0]?.trim() ?? ""
  const tokens = horizontal ? horizontal.split(/\s+/).slice(0, 4) : []
  const topLeft = tokens[0] ?? "0"
  const topRight = tokens[1] ?? topLeft
  const bottomRight = tokens[2] ?? topLeft
  const bottomLeft = tokens[3] ?? topRight
  return { topLeft, topRight, bottomRight, bottomLeft }
}

interface NormalizedCorner {
  readonly radius: number
  readonly budget: number
}

interface NormalizedCorners {
  readonly topLeft: NormalizedCorner
  readonly topRight: NormalizedCorner
  readonly bottomRight: NormalizedCorner
  readonly bottomLeft: NormalizedCorner
}

interface CornerPathParameters {
  readonly a: number
  readonly b: number
  readonly c: number
  readonly d: number
  readonly p: number
  readonly arcSectionLength: number
  readonly radius: number
}

interface CapsuleEndParameters {
  readonly a: number
  readonly b: number
  readonly c: number
  readonly d: number
  readonly e: number
  readonly p: number
  readonly ax: number
  readonly ay: number
  readonly radius: number
}

function cornerBudget(
  radius: number,
  horizontalRadius: number,
  horizontalBudget: number,
  width: number,
  verticalRadius: number,
  verticalBudget: number,
  height: number,
): number {
  const horizontal = radius === 0 && horizontalRadius === 0
    ? 0
    : horizontalBudget >= 0
      ? width - horizontalBudget
      : radius / (radius + horizontalRadius) * width
  const vertical = radius === 0 && verticalRadius === 0
    ? 0
    : verticalBudget >= 0
      ? height - verticalBudget
      : radius / (radius + verticalRadius) * height
  return Math.max(0, Math.min(horizontal, vertical))
}

/**
 * Allocate edge space between adjacent corners. Larger radii are processed
 * first so asymmetric rounded rectangles keep the requested visual priority.
 */
function normalizeCorners(width: number, height: number, input: CornerRadii): NormalizedCorners {
  const topLeft = finiteNonNegative(input.topLeft)
  const topRight = finiteNonNegative(input.topRight)
  const bottomRight = finiteNonNegative(input.bottomRight)
  const bottomLeft = finiteNonNegative(input.bottomLeft)

  if (topLeft === topRight && topRight === bottomRight && bottomRight === bottomLeft && topLeft > 0) {
    const budget = Math.min(width, height) / 2
    const corner = { radius: Math.min(topLeft, budget), budget }
    return { topLeft: corner, topRight: corner, bottomRight: corner, bottomLeft: corner }
  }

  const radii = [topLeft, topRight, bottomLeft, bottomRight]
  const ranks = radii.map((radius, index) => radii.reduce((rank, other, otherIndex) =>
    rank + (other > radius || (other === radius && otherIndex < index) ? 1 : 0), 0))
  const current = [...radii]
  const budgets = [-1, -1, -1, -1]

  for (let step = 0; step < 4; step += 1) {
    const corner = ranks.indexOf(step)
    if (corner === 0) {
      budgets[0] = cornerBudget(radii[0], current[1], budgets[1], width, current[2], budgets[2], height)
    } else if (corner === 1) {
      budgets[1] = cornerBudget(radii[1], current[0], budgets[0], width, current[3], budgets[3], height)
    } else if (corner === 2) {
      budgets[2] = cornerBudget(radii[2], current[3], budgets[3], width, current[0], budgets[0], height)
    } else {
      budgets[3] = cornerBudget(radii[3], current[2], budgets[2], width, current[1], budgets[1], height)
    }
    current[corner] = Math.min(radii[corner], budgets[corner])
  }

  return {
    topLeft: { radius: current[0], budget: budgets[0] },
    topRight: { radius: current[1], budget: budgets[1] },
    bottomLeft: { radius: current[2], budget: budgets[2] },
    bottomRight: { radius: current[3], budget: budgets[3] },
  }
}

function cornerPathParameters(radius: number, smoothing: number, budget: number, preserveSmoothing: boolean): CornerPathParameters {
  if (radius <= 0 || budget <= 0) return { a: 0, b: 0, c: 0, d: 0, p: 0, arcSectionLength: 0, radius: 0 }

  const safeRadius = Math.min(radius, budget)
  let safeSmoothing = clampedSmoothing(smoothing)
  let p = (1 + safeSmoothing) * safeRadius

  if (!preserveSmoothing) {
    safeSmoothing = Math.max(0, Math.min(safeSmoothing, budget / safeRadius - 1))
    p = Math.min(p, budget)
  }

  const arcMeasure = 90 * (1 - safeSmoothing)
  const arcSectionLength = Math.sin(toRadians(arcMeasure / 2)) * safeRadius * Math.sqrt(2)
  const angleAlpha = (90 - arcMeasure) / 2
  const p3ToP4Distance = safeRadius * Math.tan(toRadians(angleAlpha / 2))
  const angleBeta = 45 * safeSmoothing
  const c = p3ToP4Distance * Math.cos(toRadians(angleBeta))
  const d = c * Math.tan(toRadians(angleBeta))

  let b = (p - arcSectionLength - c - d) / 3
  let a = 2 * b

  if (preserveSmoothing && p > budget) {
    const availableShoulder = Math.max(0, budget - d - arcSectionLength - c)
    const minA = availableShoulder / 6
    const maxB = availableShoulder - minA
    b = Math.min(b, maxB)
    a = availableShoulder - b
    p = budget
  }

  return { a, b, c, d, p, arcSectionLength, radius: safeRadius }
}

function topRightPath({ radius, a, b, c, d, arcSectionLength }: CornerPathParameters): string {
  if (radius === 0) return ""
  return `c ${round4(a)} 0 ${round4(a + b)} 0 ${round4(a + b + c)} ${round4(d)} a ${round4(radius)} ${round4(radius)} 0 0 1 ${round4(arcSectionLength)} ${round4(arcSectionLength)} c ${round4(d)} ${round4(c)} ${round4(d)} ${round4(b + c)} ${round4(d)} ${round4(a + b + c)}`
}

function bottomRightPath({ radius, a, b, c, d, arcSectionLength }: CornerPathParameters): string {
  if (radius === 0) return ""
  return `c 0 ${round4(a)} 0 ${round4(a + b)} ${round4(-d)} ${round4(a + b + c)} a ${round4(radius)} ${round4(radius)} 0 0 1 ${round4(-arcSectionLength)} ${round4(arcSectionLength)} c ${round4(-c)} ${round4(d)} ${round4(-(b + c))} ${round4(d)} ${round4(-(a + b + c))} ${round4(d)}`
}

function bottomLeftPath({ radius, a, b, c, d, arcSectionLength }: CornerPathParameters): string {
  if (radius === 0) return ""
  return `c ${round4(-a)} 0 ${round4(-(a + b))} 0 ${round4(-(a + b + c))} ${round4(-d)} a ${round4(radius)} ${round4(radius)} 0 0 1 ${round4(-arcSectionLength)} ${round4(-arcSectionLength)} c ${round4(-d)} ${round4(-c)} ${round4(-d)} ${round4(-(b + c))} ${round4(-d)} ${round4(-(a + b + c))}`
}

function topLeftPath({ radius, a, b, c, d, arcSectionLength }: CornerPathParameters): string {
  if (radius === 0) return ""
  return `c 0 ${round4(-a)} 0 ${round4(-(a + b))} ${round4(d)} ${round4(-(a + b + c))} a ${round4(radius)} ${round4(radius)} 0 0 1 ${round4(arcSectionLength)} ${round4(-arcSectionLength)} c ${round4(c)} ${round4(-d)} ${round4(b + c)} ${round4(-d)} ${round4(a + b + c)} ${round4(-d)}`
}

function capsuleEndParameters(radius: number, smoothing: number, preserveSmoothing: boolean, longHalf: number): CapsuleEndParameters {
  const effectiveSmoothing = radius > 0 ? Math.max(0, Math.min(clampedSmoothing(smoothing), longHalf / radius - 1)) : 0
  const corner = cornerPathParameters(radius, effectiveSmoothing, longHalf, preserveSmoothing)
  const e = corner.a + corner.b + corner.c
  return {
    a: corner.a,
    b: corner.b,
    c: corner.c,
    d: corner.d,
    e,
    p: corner.p,
    ax: corner.p - e,
    ay: radius - corner.d,
    radius,
  }
}

function rightCap(p: CapsuleEndParameters): string {
  return `c ${round4(p.a)} 0 ${round4(p.a + p.b)} 0 ${round4(p.e)} ${round4(p.d)} a ${round4(p.radius)} ${round4(p.radius)} 0 0 1 ${round4(p.ax)} ${round4(p.ay)} a ${round4(p.radius)} ${round4(p.radius)} 0 0 1 ${round4(-p.ax)} ${round4(p.ay)} c ${round4(-p.c)} ${round4(p.d)} ${round4(-(p.b + p.c))} ${round4(p.d)} ${round4(-p.e)} ${round4(p.d)}`
}

function leftCap(p: CapsuleEndParameters): string {
  return `c ${round4(-p.a)} 0 ${round4(-(p.a + p.b))} 0 ${round4(-p.e)} ${round4(-p.d)} a ${round4(p.radius)} ${round4(p.radius)} 0 0 1 ${round4(-p.ax)} ${round4(-p.ay)} a ${round4(p.radius)} ${round4(p.radius)} 0 0 1 ${round4(p.ax)} ${round4(-p.ay)} c ${round4(p.c)} ${round4(-p.d)} ${round4(p.b + p.c)} ${round4(-p.d)} ${round4(p.e)} ${round4(-p.d)}`
}

function topCap(p: CapsuleEndParameters): string {
  return `c 0 ${round4(-p.a)} 0 ${round4(-(p.a + p.b))} ${round4(p.d)} ${round4(-p.e)} a ${round4(p.radius)} ${round4(p.radius)} 0 0 1 ${round4(p.ay)} ${round4(-p.ax)} a ${round4(p.radius)} ${round4(p.radius)} 0 0 1 ${round4(p.ay)} ${round4(p.ax)} c ${round4(p.d)} ${round4(p.c)} ${round4(p.d)} ${round4(p.b + p.c)} ${round4(p.d)} ${round4(p.e)}`
}

function bottomCap(p: CapsuleEndParameters): string {
  return `c 0 ${round4(p.a)} 0 ${round4(p.a + p.b)} ${round4(-p.d)} ${round4(p.e)} a ${round4(p.radius)} ${round4(p.radius)} 0 0 1 ${round4(-p.ay)} ${round4(p.ax)} a ${round4(p.radius)} ${round4(p.radius)} 0 0 1 ${round4(-p.ay)} ${round4(-p.ax)} c ${round4(-p.d)} ${round4(-p.c)} ${round4(-p.d)} ${round4(-(p.b + p.c))} ${round4(-p.d)} ${round4(-p.e)}`
}

interface EdgeShoulder {
  readonly a: number
  readonly b: number
  readonly p: number
  readonly sin: number
  readonly cos: number
}

function edgeShoulder(radius: number, smoothing: number, preserveSmoothing: boolean, room: number): EdgeShoulder {
  const parameters = cornerPathParameters(radius, smoothing, room, preserveSmoothing)
  const beta = toRadians(45 * smoothing)
  return {
    a: parameters.a,
    b: parameters.b,
    p: parameters.p,
    sin: Math.sin(beta),
    cos: Math.cos(beta),
  }
}

function edgeSmoothing(room: number, radius: number, smoothing: number): number {
  return Math.max(0, Math.min(room / radius - 1, smoothing))
}

/**
 * Transition between a four-corner squircle and a full capsule. Horizontal
 * and vertical shoulders give up smoothing independently, avoiding a visible
 * jump while the short edge approaches 2R.
 */
function blendCornerPath(width: number, height: number, radius: number, smoothing: number, preserveSmoothing: boolean): string {
  const horizontal = edgeShoulder(radius, edgeSmoothing(width / 2, radius, smoothing), preserveSmoothing, width / 2)
  const vertical = edgeShoulder(radius, edgeSmoothing(height / 2, radius, smoothing), preserveSmoothing, height / 2)

  const draw = (cornerX: number, cornerY: number, ux: number, uy: number, vx: number, vy: number): string => {
    const arrival = uy === 0 ? horizontal : vertical
    const departure = vy === 0 ? horizontal : vertical
    const centerX = cornerX + (ux + vx) * radius
    const centerY = cornerY + (uy + vy) * radius
    const junction1X = centerX - vx * radius * arrival.cos - ux * radius * arrival.sin
    const junction1Y = centerY - vy * radius * arrival.cos - uy * radius * arrival.sin
    const junction2X = centerX - ux * radius * departure.cos - vx * radius * departure.sin
    const junction2Y = centerY - uy * radius * departure.cos - vy * radius * departure.sin
    const startX = cornerX + ux * arrival.p
    const startY = cornerY + uy * arrival.p
    const hasArc = Math.hypot(junction2X - junction1X, junction2Y - junction1Y) > 1e-6
    const arcEndX = hasArc ? junction2X : junction1X
    const arcEndY = hasArc ? junction2Y : junction1Y
    const endX = cornerX + vx * departure.p
    const endY = cornerY + vy * departure.p

    let path = `L ${round4(startX)} ${round4(startY)} `
    path += `c ${round4(-ux * arrival.a)} ${round4(-uy * arrival.a)} ${round4(-ux * (arrival.a + arrival.b))} ${round4(-uy * (arrival.a + arrival.b))} ${round4(junction1X - startX)} ${round4(junction1Y - startY)} `
    if (hasArc) path += `a ${round4(radius)} ${round4(radius)} 0 0 1 ${round4(junction2X - junction1X)} ${round4(junction2Y - junction1Y)} `
    path += `c ${round4(endX - vx * (departure.a + departure.b) - arcEndX)} ${round4(endY - vy * (departure.a + departure.b) - arcEndY)} ${round4(endX - vx * departure.a - arcEndX)} ${round4(endY - vy * departure.a - arcEndY)} ${round4(endX - arcEndX)} ${round4(endY - arcEndY)}`
    return path
  }

  const topRight = draw(width, 0, -1, 0, 0, 1)
  const bottomRight = draw(width, height, 0, -1, -1, 0)
  const bottomLeft = draw(0, height, 1, 0, 0, -1)
  const topLeft = draw(0, 0, 0, 1, 1, 0)
  return `M ${round4(horizontal.p)} 0 ${topRight} ${bottomRight} ${bottomLeft} ${topLeft} Z`
}

const segment = (value: string): string => value ? ` ${value}` : ""
const capEpsilon = 1e-9

function isCapEnd(a: NormalizedCorner, b: NormalizedCorner, capRadius: number): boolean {
  return Math.abs(a.radius - capRadius) < capEpsilon && Math.abs(b.radius - capRadius) < capEpsilon
}

/** Build a Lisse/Figma-style smooth outline for a measured rounded rectangle. */
export function continuousCornerPath(
  width: number,
  height: number,
  radii: CornerRadii,
  smoothing = APPLE_CONTINUOUS_CORNER_SMOOTHING,
  preserveSmoothing = true,
): string {
  const safeWidth = finiteNonNegative(width)
  const safeHeight = finiteNonNegative(height)
  if (safeWidth <= 0 || safeHeight <= 0) return "M 0 0 H 0 V 0 H 0 Z"

  const safeSmoothing = clampedSmoothing(smoothing)
  const normalized = normalizeCorners(safeWidth, safeHeight, radii)
  if (normalized.topLeft.radius === 0 && normalized.topRight.radius === 0 && normalized.bottomRight.radius === 0 && normalized.bottomLeft.radius === 0) {
    return `M 0 0 H ${round4(safeWidth)} V ${round4(safeHeight)} H 0 Z`
  }

  const rawTopLeft = finiteNonNegative(radii.topLeft)
  const uniformRadius = rawTopLeft === finiteNonNegative(radii.topRight)
    && rawTopLeft === finiteNonNegative(radii.bottomRight)
    && rawTopLeft === finiteNonNegative(radii.bottomLeft)
  if (uniformRadius && rawTopLeft > 0) {
    const radius = Math.min(rawTopLeft, safeWidth / 2, safeHeight / 2)
    const shortHalf = Math.min(safeWidth, safeHeight) / 2
    const epsilon = 1e-9
    if (shortHalf > radius + epsilon && shortHalf < (1 + safeSmoothing) * radius - epsilon) {
      return blendCornerPath(safeWidth, safeHeight, radius, safeSmoothing, preserveSmoothing)
    }
  }

  const horizontal = safeWidth >= safeHeight
  const capRadius = (horizontal ? safeHeight : safeWidth) / 2

  if (horizontal) {
    const rightIsCap = isCapEnd(normalized.topRight, normalized.bottomRight, capRadius)
    const leftIsCap = isCapEnd(normalized.topLeft, normalized.bottomLeft, capRadius)
    if (rightIsCap || leftIsCap) {
      const right = rightIsCap ? capsuleEndParameters(capRadius, safeSmoothing, preserveSmoothing, safeWidth / 2) : undefined
      const left = leftIsCap ? capsuleEndParameters(capRadius, safeSmoothing, preserveSmoothing, safeWidth / 2) : undefined
      const topLeft = left ? undefined : cornerPathParameters(normalized.topLeft.radius, safeSmoothing, normalized.topLeft.budget, preserveSmoothing)
      const topRight = right ? undefined : cornerPathParameters(normalized.topRight.radius, safeSmoothing, normalized.topRight.budget, preserveSmoothing)
      const bottomRight = right ? undefined : cornerPathParameters(normalized.bottomRight.radius, safeSmoothing, normalized.bottomRight.budget, preserveSmoothing)
      const bottomLeft = left ? undefined : cornerPathParameters(normalized.bottomLeft.radius, safeSmoothing, normalized.bottomLeft.budget, preserveSmoothing)
      let path = `M ${round4(left?.p ?? topLeft!.p)} 0 L ${round4(safeWidth - (right?.p ?? topRight!.p))} 0`
      if (right) path += ` ${rightCap(right)}`
      else path += `${segment(topRightPath(topRight!))} L ${round4(safeWidth)} ${round4(bottomRight!.p)} L ${round4(safeWidth)} ${round4(safeHeight - bottomRight!.p)}${segment(bottomRightPath(bottomRight!))}`
      if (left) path += ` L ${round4(left.p)} ${round4(safeHeight)} ${leftCap(left)}`
      else path += ` L ${round4(safeWidth - bottomLeft!.p)} ${round4(safeHeight)} L ${round4(bottomLeft!.p)} ${round4(safeHeight)}${segment(bottomLeftPath(bottomLeft!))} L 0 ${round4(safeHeight - topLeft!.p)} L 0 ${round4(topLeft!.p)}${segment(topLeftPath(topLeft!))}`
      return `${path} Z`
    }
  } else {
    const topIsCap = isCapEnd(normalized.topLeft, normalized.topRight, capRadius)
    const bottomIsCap = isCapEnd(normalized.bottomLeft, normalized.bottomRight, capRadius)
    if (topIsCap || bottomIsCap) {
      const top = topIsCap ? capsuleEndParameters(capRadius, safeSmoothing, preserveSmoothing, safeHeight / 2) : undefined
      const bottom = bottomIsCap ? capsuleEndParameters(capRadius, safeSmoothing, preserveSmoothing, safeHeight / 2) : undefined
      const topLeft = top ? undefined : cornerPathParameters(normalized.topLeft.radius, safeSmoothing, normalized.topLeft.budget, preserveSmoothing)
      const topRight = top ? undefined : cornerPathParameters(normalized.topRight.radius, safeSmoothing, normalized.topRight.budget, preserveSmoothing)
      const bottomRight = bottom ? undefined : cornerPathParameters(normalized.bottomRight.radius, safeSmoothing, normalized.bottomRight.budget, preserveSmoothing)
      const bottomLeft = bottom ? undefined : cornerPathParameters(normalized.bottomLeft.radius, safeSmoothing, normalized.bottomLeft.budget, preserveSmoothing)
      let path = top
        ? `M 0 ${round4(top.p)} ${topCap(top)}`
        : `M ${round4(topLeft!.p)} 0 L ${round4(safeWidth - topRight!.p)} 0${segment(topRightPath(topRight!))}`
      path += ` L ${round4(safeWidth)} ${round4(safeHeight - (bottom?.p ?? bottomRight!.p))}`
      if (bottom) path += ` ${bottomCap(bottom)}`
      else path += `${segment(bottomRightPath(bottomRight!))} L ${round4(bottomLeft!.p)} ${round4(safeHeight)}${segment(bottomLeftPath(bottomLeft!))}`
      if (top) path += ` L 0 ${round4(top.p)}`
      else path += ` L 0 ${round4(safeHeight - topLeft!.p)} L 0 ${round4(topLeft!.p)}${segment(topLeftPath(topLeft!))}`
      return `${path} Z`
    }
  }

  const topLeft = cornerPathParameters(normalized.topLeft.radius, safeSmoothing, normalized.topLeft.budget, preserveSmoothing)
  const topRight = cornerPathParameters(normalized.topRight.radius, safeSmoothing, normalized.topRight.budget, preserveSmoothing)
  const bottomRight = cornerPathParameters(normalized.bottomRight.radius, safeSmoothing, normalized.bottomRight.budget, preserveSmoothing)
  const bottomLeft = cornerPathParameters(normalized.bottomLeft.radius, safeSmoothing, normalized.bottomLeft.budget, preserveSmoothing)

  return [
    `M ${round4(topLeft.p)} 0`,
    `L ${round4(safeWidth - topRight.p)} 0`,
    topRightPath(topRight),
    `L ${round4(safeWidth)} ${round4(bottomRight.p)}`,
    `L ${round4(safeWidth)} ${round4(safeHeight - bottomRight.p)}`,
    bottomRightPath(bottomRight),
    `L ${round4(safeWidth - bottomLeft.p)} ${round4(safeHeight)}`,
    `L ${round4(bottomLeft.p)} ${round4(safeHeight)}`,
    bottomLeftPath(bottomLeft),
    `L 0 ${round4(safeHeight - topLeft.p)}`,
    `L 0 ${round4(topLeft.p)}`,
    topLeftPath(topLeft),
    "Z",
  ].filter(Boolean).join(" ")
}

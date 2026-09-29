import {
  defineResidentRegion,
  type KernelExpression,
  type KernelIR,
  type KernelMapIR,
  type PackedLayout,
  type ResidentRegionIR,
} from "@mun/core/internal/execution"

/**
 * Residency at a producer-to-consumer connection considered for fusion.
 * A packed connection means both regions share packed numeric authority; an
 * object or GPU connection is a materialization boundary and is never fused by
 * the CPU resident planner.
 */
export type ResidentFusionBoundaryResidency = "packed" | "objects" | "gpu"

/**
 * Costs are normalized planner units supplied by profiling or a static model.
 * Keeping one entry per connection makes boundary count part of the estimate
 * rather than hiding it behind an instruction/row threshold.
 */
export interface ResidentFusionBoundary {
  readonly residency: ResidentFusionBoundaryResidency
  readonly transferCost: number
  readonly materializationCost: number
  readonly synchronizationCost: number
}

export interface ResidentFusionCostInput {
  readonly computeCostSaved: number
  readonly boundaries: readonly ResidentFusionBoundary[]
}

export interface ResidentFusionCostEstimate {
  readonly computeCostSaved: number
  readonly transferCost: number
  readonly materializationCost: number
  readonly synchronizationCost: number
  readonly benefit: number
  readonly boundaryCount: number
  readonly packedBoundaryCount: number
  readonly objectBoundaryCount: number
  readonly gpuBoundaryCount: number
}

export type ResidentFusionRejectionCode =
  | "insufficient-regions"
  | "boundary-count-mismatch"
  | "region-residency"
  | "boundary-residency"
  | "region-layout-mismatch"
  | "connection-layout-mismatch"
  | "lifetime-mismatch"
  | "missing-type-proof"
  | "unsupported-kernel"
  | "invalid-fused-region"
  | "non-positive-benefit"

export interface ResidentFusionRejection {
  readonly code: ResidentFusionRejectionCode
  readonly message: string
  readonly regionIndex?: number
  readonly boundaryIndex?: number
}

export interface ResidentFusionRequest extends ResidentFusionCostInput {
  readonly regions: readonly ResidentRegionIR[]
  /** Stable caller-owned ID. A deterministic ID is generated when omitted. */
  readonly id?: string
  /** Require benefit to be strictly greater than this value. Default: zero. */
  readonly minimumBenefit?: number
}

export interface ResidentFusionAcceptedPlan {
  readonly version: 1
  readonly eligible: true
  readonly fusedRegion: ResidentRegionIR
  readonly cost: ResidentFusionCostEstimate
  readonly rejections: readonly ResidentFusionRejection[]
}

export interface ResidentFusionRejectedPlan {
  readonly version: 1
  readonly eligible: false
  readonly fusedRegion: null
  readonly cost: ResidentFusionCostEstimate
  readonly rejections: readonly ResidentFusionRejection[]
}

export type ResidentFusionPlan = ResidentFusionAcceptedPlan | ResidentFusionRejectedPlan

export interface ResidentKernelOptimizationStats {
  readonly inputKernels: number
  readonly outputKernels: number
  readonly inputOutputs: number
  readonly outputOutputs: number
  readonly eliminatedOutputs: number
  readonly estimatedOpsPerItem: number
  readonly liveInputFields: readonly string[]
}

export interface ResidentKernelOptimizationResult {
  readonly kernels: readonly KernelIR[]
  readonly stats: ResidentKernelOptimizationStats
}

function assertFiniteNonNegative(value: number, label: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${label} must be a finite non-negative number`)
  }
}

function checkedCost(boundary: ResidentFusionBoundary, index: number): ResidentFusionBoundary {
  assertFiniteNonNegative(boundary.transferCost, `resident fusion boundary ${index} transfer cost`)
  assertFiniteNonNegative(boundary.materializationCost, `resident fusion boundary ${index} materialization cost`)
  assertFiniteNonNegative(boundary.synchronizationCost, `resident fusion boundary ${index} synchronization cost`)
  return boundary
}

/**
 * Compute the end-to-end fusion estimate in normalized planner units.
 *
 * benefit = compute saved - transfer - materialization - synchronization
 */
export function estimateResidentFusionCost(input: ResidentFusionCostInput): ResidentFusionCostEstimate {
  assertFiniteNonNegative(input.computeCostSaved, "resident fusion compute cost saved")
  let transferCost = 0
  let materializationCost = 0
  let synchronizationCost = 0
  let packedBoundaryCount = 0
  let objectBoundaryCount = 0
  let gpuBoundaryCount = 0
  input.boundaries.forEach((candidate, index) => {
    const boundary = checkedCost(candidate, index)
    transferCost += boundary.transferCost
    materializationCost += boundary.materializationCost
    synchronizationCost += boundary.synchronizationCost
    if (boundary.residency === "packed") packedBoundaryCount += 1
    else if (boundary.residency === "objects") objectBoundaryCount += 1
    else if (boundary.residency === "gpu") gpuBoundaryCount += 1
    else throw new TypeError(`resident fusion boundary ${index} has an unknown residency`)
  })
  const benefit = input.computeCostSaved - transferCost - materializationCost - synchronizationCost
  if (![transferCost, materializationCost, synchronizationCost, benefit].every(Number.isFinite)) {
    throw new RangeError("resident fusion cost estimate exceeds the finite numeric range")
  }
  return Object.freeze({
    computeCostSaved: input.computeCostSaved,
    transferCost,
    materializationCost,
    synchronizationCost,
    benefit,
    boundaryCount: input.boundaries.length,
    packedBoundaryCount,
    objectBoundaryCount,
    gpuBoundaryCount,
  })
}

function sameLayout(left: PackedLayout, right: PackedLayout): boolean {
  return left.length === right.length
    && left.fields.length === right.fields.length
    && left.fields.every((field, index) => {
      const other = right.fields[index]
      return other?.name === field.name && other.type === field.type
    })
}

function expressionKey(expression: KernelExpression): string {
  if (expression.op === "const") return `c:${String(expression.value)}`
  if (expression.op === "index") return "i"
  if (expression.op === "capture") return `p:${expression.name}`
  if (expression.op === "load") return `l:${expression.path.map(String).join(".")}`
  if (expression.op === "unary") return `u:${expression.operator}:${expressionKey(expression.value)}`
  if (expression.op === "binary") return `b:${expression.operator}:${expressionKey(expression.left)}:${expressionKey(expression.right)}`
  return `s:${expressionKey(expression.condition)}:${expressionKey(expression.whenTrue)}:${expressionKey(expression.whenFalse)}`
}

function numericConst(expression: KernelExpression): number | undefined {
  if (expression.op !== "const") return undefined
  return typeof expression.value === "boolean" ? (expression.value ? 1 : 0) : expression.value
}

function foldedConst(value: number | boolean): KernelExpression {
  return Object.freeze({ op: "const" as const, value })
}

/** Conservative numeric folding shared by JS/WASM/GPU backend planning. */
export function optimizeResidentKernelExpression(expression: KernelExpression): KernelExpression {
  if (expression.op === "const" || expression.op === "load" || expression.op === "index" || expression.op === "capture") return expression
  if (expression.op === "unary") {
    const value = optimizeResidentKernelExpression(expression.value)
    const constant = numericConst(value)
    if (constant !== undefined) {
      if (expression.operator === "+") return foldedConst(constant)
      if (expression.operator === "-") return foldedConst(-constant)
      if (expression.operator === "!") return foldedConst(!constant)
      if (expression.operator === "~") return foldedConst(~constant)
    }
    if (expression.operator === "+") return value
    return value === expression.value ? expression : Object.freeze({ ...expression, value })
  }
  if (expression.op === "select") {
    const condition = optimizeResidentKernelExpression(expression.condition)
    const whenTrue = optimizeResidentKernelExpression(expression.whenTrue)
    const whenFalse = optimizeResidentKernelExpression(expression.whenFalse)
    const constant = numericConst(condition)
    if (constant !== undefined) return constant ? whenTrue : whenFalse
    if (expressionKey(whenTrue) === expressionKey(whenFalse)) return whenTrue
    return Object.freeze({ op: "select" as const, condition, whenTrue, whenFalse })
  }
  const left = optimizeResidentKernelExpression(expression.left)
  const right = optimizeResidentKernelExpression(expression.right)
  const leftConstant = numericConst(left)
  const rightConstant = numericConst(right)
  if (leftConstant !== undefined && rightConstant !== undefined) {
    const a = leftConstant
    const b = rightConstant
    let value: number | boolean | undefined
    switch (expression.operator) {
      case "+": value = a + b; break
      case "-": value = a - b; break
      case "*": value = a * b; break
      case "/": value = a / b; break
      case "%": value = a % b; break
      case "**": value = a ** b; break
      case "<": value = a < b; break
      case "<=": value = a <= b; break
      case ">": value = a > b; break
      case ">=": value = a >= b; break
      case "==": case "===": value = a === b; break
      case "!=": case "!==": value = a !== b; break
      case "&": value = a & b; break
      case "|": value = a | b; break
      case "^": value = a ^ b; break
      case "<<": value = a << b; break
      case ">>": value = a >> b; break
      case ">>>": value = a >>> b; break
      case "&&": value = a && b ? 1 : 0; break
      case "||": value = a || b ? 1 : 0; break
      case "??": value = a; break
    }
    if (value !== undefined && (typeof value === "boolean" || Number.isFinite(value))) return foldedConst(value)
  }
  // Identities that are valid for the packed numeric contract and do not
  // erase NaN/Infinity-sensitive operations such as x * 0 or x / x.
  if (expression.operator === "+" && rightConstant === 0) return left
  if (expression.operator === "+" && leftConstant === 0) return right
  if (expression.operator === "-" && rightConstant === 0) return left
  if (expression.operator === "*" && rightConstant === 1) return left
  if (expression.operator === "*" && leftConstant === 1) return right
  if (expression.operator === "/" && rightConstant === 1) return left
  return Object.freeze({ op: "binary" as const, operator: expression.operator, left, right })
}

function collectExpressionFields(expression: KernelExpression, fields: Set<string>): void {
  if (expression.op === "load") {
    const [field] = expression.path
    if (typeof field === "string") fields.add(field)
    return
  }
  if (expression.op === "unary") collectExpressionFields(expression.value, fields)
  else if (expression.op === "binary") {
    collectExpressionFields(expression.left, fields)
    collectExpressionFields(expression.right, fields)
  } else if (expression.op === "select") {
    collectExpressionFields(expression.condition, fields)
    collectExpressionFields(expression.whenTrue, fields)
    collectExpressionFields(expression.whenFalse, fields)
  }
}

function collectExpressionCaptures(expression: KernelExpression, captures: Set<string>): void {
  if (expression.op === "capture") captures.add(expression.name)
  else if (expression.op === "unary") collectExpressionCaptures(expression.value, captures)
  else if (expression.op === "binary") {
    collectExpressionCaptures(expression.left, captures)
    collectExpressionCaptures(expression.right, captures)
  } else if (expression.op === "select") {
    collectExpressionCaptures(expression.condition, captures)
    collectExpressionCaptures(expression.whenTrue, captures)
    collectExpressionCaptures(expression.whenFalse, captures)
  }
}

export function estimateResidentKernelExpressionOps(expression: KernelExpression): number {
  if (expression.op === "const" || expression.op === "load" || expression.op === "index" || expression.op === "capture") return 1
  if (expression.op === "unary") return 1 + estimateResidentKernelExpressionOps(expression.value)
  if (expression.op === "binary") return 1 + estimateResidentKernelExpressionOps(expression.left) + estimateResidentKernelExpressionOps(expression.right)
  return 1 + estimateResidentKernelExpressionOps(expression.condition)
    + estimateResidentKernelExpressionOps(expression.whenTrue)
    + estimateResidentKernelExpressionOps(expression.whenFalse)
}

/**
 * Backward field liveness removes writes overwritten before the final sink and
 * folds each retained expression. Kernel boundaries remain intact so map
 * snapshot semantics are unchanged.
 */
export function optimizeResidentKernelSequence(
  kernels: readonly KernelIR[],
  sinkLayout: PackedLayout,
): ResidentKernelOptimizationResult {
  const live = new Set(sinkLayout.fields.map(field => field.name))
  const reversed: KernelIR[] = []
  let inputOutputs = 0
  let outputOutputs = 0
  for (let index = kernels.length - 1; index >= 0; index -= 1) {
    const kernel = kernels[index]!
    if (kernel.kind !== "map") {
      reversed.push(kernel)
      continue
    }
    inputOutputs += kernel.outputs.length
    const optimized = kernel.outputs.map(output => Object.freeze({
      name: output.name,
      value: optimizeResidentKernelExpression(output.value),
    }))
    const outputNames = new Set(optimized.map(output => output.name))
    const retained = optimized.filter(output => live.has(output.name))
    const liveBefore = new Set([...live].filter(field => !outputNames.has(field)))
    const captures = new Set<string>()
    for (const output of retained) {
      collectExpressionFields(output.value, liveBefore)
      collectExpressionCaptures(output.value, captures)
    }
    live.clear()
    for (const field of liveBefore) live.add(field)
    if (retained.length > 0) {
      outputOutputs += retained.length
      reversed.push(Object.freeze({
        ...kernel,
        outputs: Object.freeze(retained),
        captures: Object.freeze([...captures].sort()),
      }) as KernelMapIR)
    }
  }
  const optimizedKernels = Object.freeze(reversed.reverse())
  const estimatedOpsPerItem = optimizedKernels.reduce((total, kernel) => {
    if (kernel.kind === "map") return total + kernel.outputs.reduce((sum, output) => sum + estimateResidentKernelExpressionOps(output.value), 0)
    return total + estimateResidentKernelExpressionOps(kernel.value)
  }, 0)
  return Object.freeze({
    kernels: optimizedKernels,
    stats: Object.freeze({
      inputKernels: kernels.length,
      outputKernels: optimizedKernels.length,
      inputOutputs,
      outputOutputs,
      eliminatedOutputs: inputOutputs - outputOutputs,
      estimatedOpsPerItem,
      liveInputFields: Object.freeze([...live].sort()),
    }),
  })
}

function deterministicFusionId(regions: readonly ResidentRegionIR[]): string {
  return `resident-fusion:${regions.map(region => `${region.id.length}:${region.id}`).join("|")}`
}

function rejection(
  code: ResidentFusionRejectionCode,
  message: string,
  location: Pick<ResidentFusionRejection, "regionIndex" | "boundaryIndex"> = {},
): ResidentFusionRejection {
  return Object.freeze({ code, message, ...location })
}

function rejectedPlan(
  cost: ResidentFusionCostEstimate,
  rejections: readonly ResidentFusionRejection[],
): ResidentFusionRejectedPlan {
  return Object.freeze({
    version: 1,
    eligible: false,
    fusedRegion: null,
    cost,
    rejections: Object.freeze([...rejections]),
  })
}

/**
 * Fuse adjacent packed map regions into one loop candidate.
 *
 * Kernel boundaries are deliberately retained. The packed executor evaluates
 * every output of a map kernel before committing any of that kernel's writes,
 * while the following kernel observes the committed values. Flattening region
 * kernel lists therefore preserves both within-kernel snapshot semantics and
 * producer-to-consumer sequencing across the former region boundary.
 */
export function planResidentRegionFusion(request: ResidentFusionRequest): ResidentFusionPlan {
  const cost = estimateResidentFusionCost(request)
  const minimumBenefit = request.minimumBenefit ?? 0
  assertFiniteNonNegative(minimumBenefit, "resident fusion minimum benefit")
  const regions = request.regions
  const rejections: ResidentFusionRejection[] = []

  if (regions.length < 2) {
    rejections.push(rejection(
      "insufficient-regions",
      "resident fusion requires at least two adjacent regions",
    ))
  }

  const expectedBoundaryCount = Math.max(0, regions.length - 1)
  if (request.boundaries.length !== expectedBoundaryCount) {
    rejections.push(rejection(
      "boundary-count-mismatch",
      `resident fusion expected ${expectedBoundaryCount} connection boundaries but received ${request.boundaries.length}`,
    ))
  }

  regions.forEach((region, regionIndex) => {
    if (region.inputResidency !== "packed" || region.outputResidency !== "packed") {
      rejections.push(rejection(
        "region-residency",
        `region ${JSON.stringify(region.id)} crosses ${region.inputResidency} -> ${region.outputResidency}; CPU resident fusion requires packed -> packed authority`,
        { regionIndex },
      ))
    }
    if (!sameLayout(region.source.layout, region.sink.layout)) {
      rejections.push(rejection(
        "region-layout-mismatch",
        `region ${JSON.stringify(region.id)} changes packed layout inside the initial map-fusion model`,
        { regionIndex },
      ))
    }
    if (region.typeProof !== "numeric-packed") {
      rejections.push(rejection(
        "missing-type-proof",
        `region ${JSON.stringify(region.id)} lacks numeric packed type proof`,
        { regionIndex },
      ))
    }
    if (region.kernels.length === 0 || region.kernels.some(kernel => kernel.kind !== "map")) {
      rejections.push(rejection(
        "unsupported-kernel",
        `region ${JSON.stringify(region.id)} is not a non-empty packed map-kernel sequence`,
        { regionIndex },
      ))
    }
    if (regionIndex > 0) {
      const first = regions[0]!
      if (region.lifetime !== first.lifetime) {
        rejections.push(rejection(
          "lifetime-mismatch",
          `region ${JSON.stringify(region.id)} has lifetime ${region.lifetime}; fused regions must share ${first.lifetime}`,
          { regionIndex },
        ))
      }
      const previous = regions[regionIndex - 1]!
      if (!sameLayout(previous.sink.layout, region.source.layout)) {
        rejections.push(rejection(
          "connection-layout-mismatch",
          `packed layout changes between regions ${JSON.stringify(previous.id)} and ${JSON.stringify(region.id)}`,
          { boundaryIndex: regionIndex - 1 },
        ))
      }
    }
  })

  request.boundaries.forEach((boundary, boundaryIndex) => {
    if (boundary.residency !== "packed") {
      rejections.push(rejection(
        "boundary-residency",
        `connection boundary ${boundaryIndex} is ${boundary.residency}; CPU resident fusion cannot cross object materialization or GPU authority`,
        { boundaryIndex },
      ))
    }
  })

  // Residency/layout/type failures are absolute. A large arithmetic estimate
  // cannot buy its way across an object, GPU, or semantic boundary.
  if (rejections.length > 0) return rejectedPlan(cost, rejections)

  if (cost.benefit <= minimumBenefit) {
    return rejectedPlan(cost, [rejection(
      "non-positive-benefit",
      `resident fusion benefit ${cost.benefit} must be greater than ${minimumBenefit}`,
    )])
  }

  const first = regions[0]!
  const last = regions[regions.length - 1]!
  const optimization = optimizeResidentKernelSequence(regions.flatMap(region => [...region.kernels]), last.sink.layout)
  const estimatedOpsPerItem = optimization.stats.estimatedOpsPerItem
  const estimatedTransferBytes = regions.reduce((total, region) => total + region.estimatedTransferBytes, 0)
  let fusedRegion: ResidentRegionIR
  try {
    fusedRegion = defineResidentRegion({
      id: request.id ?? deterministicFusionId(regions),
      source: first.source,
      kernels: optimization.kernels,
      sink: last.sink,
      typeProof: "numeric-packed",
      lifetime: first.lifetime,
      inputResidency: "packed",
      outputResidency: "packed",
      estimatedOpsPerItem,
      estimatedTransferBytes,
    })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return rejectedPlan(cost, [rejection(
      "invalid-fused-region",
      `resident fusion could not form a valid packed region: ${message}`,
    )])
  }

  return Object.freeze({
    version: 1,
    eligible: true,
    fusedRegion,
    cost,
    rejections: Object.freeze([]),
  })
}

import type {
  KernelExpression,
  PackedLayout,
  ResidentRegionIR,
} from "@mun/core/internal/execution"

interface EmitContext {
  readonly fields: ReadonlyMap<string, string>
  readonly captures: ReadonlyMap<string, string>
  readonly index: string
}

function safeFunctionName(name: string): string {
  if (!/^[$A-Z_a-z][$\w]*$/u.test(name)) throw new TypeError(`invalid resident executor name: ${name}`)
  return name
}

function sameLayout(left: PackedLayout, right: PackedLayout): boolean {
  return left.length === right.length
    && left.fields.length === right.fields.length
    && left.fields.every((field, index) => {
      const other = right.fields[index]
      return other?.name === field.name && other.type === field.type
    })
}

function emitExpression(expression: KernelExpression, context: EmitContext): string {
  if (expression.op === "const") return typeof expression.value === "boolean" ? String(expression.value) : JSON.stringify(expression.value)
  if (expression.op === "index") return context.index
  if (expression.op === "capture") {
    const capture = context.captures.get(expression.name)
    if (!capture) throw new TypeError(`resident kernel capture is not declared: ${expression.name}`)
    return capture
  }
  if (expression.op === "load") {
    if (expression.path.length !== 1 || typeof expression.path[0] !== "string") {
      throw new TypeError("packed JS code generation requires a single statically proven column load")
    }
    const field = context.fields.get(expression.path[0])
    if (!field) throw new TypeError(`resident kernel reads unknown packed field: ${expression.path[0]}`)
    return `${field}[${context.index}]`
  }
  if (expression.op === "unary") return `(${expression.operator}${emitExpression(expression.value, context)})`
  if (expression.op === "select") {
    return `(${emitExpression(expression.condition, context)} ? ${emitExpression(expression.whenTrue, context)} : ${emitExpression(expression.whenFalse, context)})`
  }
  return `(${emitExpression(expression.left, context)} ${expression.operator} ${emitExpression(expression.right, context)})`
}

/**
 * Emit a CSP-safe executor body at Mun compile time. The resulting bundle has
 * an ordinary numeric loop; it does not interpret Kernel IR in the browser.
 */
export function emitResidentRegionJS(region: ResidentRegionIR, functionName = "__munResidentRegion"): string {
  const name = safeFunctionName(functionName)
  if (region.inputResidency !== "packed" || region.outputResidency !== "packed") {
    throw new TypeError("resident JS code generation requires packed input and output")
  }
  if (!sameLayout(region.source.layout, region.sink.layout)) {
    throw new TypeError("resident JS code generation currently requires matching source and sink layouts")
  }
  if (region.kernels.length === 0 || region.kernels.some(kernel => kernel.kind !== "map")) {
    throw new TypeError("resident JS code generation currently requires map kernels")
  }

  const fieldVariables = new Map(region.sink.layout.fields.map((field, index) => [field.name, `__munColumn${index}`]))
  const captureNames = new Set(region.kernels.flatMap(kernel => [...kernel.captures]))
  const captureVariables = new Map([...captureNames].sort().map((capture, index) => [capture, `__munCapture${index}`]))
  const context: EmitContext = { fields: fieldVariables, captures: captureVariables, index: "__munIndex" }
  const lines = [
    `function ${name}(__munSourceStorage, __munSinkStorage = __munSourceStorage, __munCaptures = {}, __munInputRanges = null) {`,
    `  const __munSource = __munSourceStorage.buffers`,
    `  const __munSink = __munSinkStorage.buffers`,
    `  if (__munSourceStorage.layout.length !== ${region.source.layout.length} || __munSinkStorage.layout.length !== ${region.sink.layout.length}) throw new RangeError("resident storage length does not match compiled layout")`,
    `  const __munRanges = Array.isArray(__munInputRanges) ? __munInputRanges : [{ start: 0, end: ${region.sink.layout.length} }]`,
    `  if (__munRanges.length === 0) return __munSinkStorage`,
    `  if (__munSource !== __munSink) {`,
    `    for (let __munColumn = 0; __munColumn < ${region.sink.layout.fields.length}; __munColumn += 1) {`,
    `      const __munInput = __munSource[__munColumn]`,
    `      const __munOutput = __munSink[__munColumn]`,
    `      if (__munInput === __munOutput) continue`,
    `      for (let __munRangeIndex = 0; __munRangeIndex < __munRanges.length; __munRangeIndex += 1) {`,
    `        const __munRange = __munRanges[__munRangeIndex]`,
    `        if (!__munRange || !Number.isSafeInteger(__munRange.start) || !Number.isSafeInteger(__munRange.end) || __munRange.start < 0 || __munRange.end < __munRange.start || __munRange.end > ${region.sink.layout.length}) throw new RangeError("resident execution range does not match compiled layout")`,
    `        __munOutput.set(__munInput.subarray(__munRange.start, __munRange.end), __munRange.start)`,
    `      }`,
    `    }`,
    `  }`,
    ...region.sink.layout.fields.map((_, index) => `  const __munColumn${index} = __munSink[${index}]`),
    ...[...captureVariables].map(([capture, variable]) => `  const ${variable} = __munCaptures[${JSON.stringify(capture)}]`),
    ...[...captureVariables].map(([capture, variable]) => `  if (typeof ${variable} !== "number" && typeof ${variable} !== "boolean") throw new TypeError(${JSON.stringify(`resident kernel capture is missing or non-numeric: ${capture}`)})`),
    `  for (let __munRangeIndex = 0; __munRangeIndex < __munRanges.length; __munRangeIndex += 1) {`,
    `    const __munRange = __munRanges[__munRangeIndex]`,
    `    if (!__munRange || !Number.isSafeInteger(__munRange.start) || !Number.isSafeInteger(__munRange.end) || __munRange.start < 0 || __munRange.end < __munRange.start || __munRange.end > ${region.sink.layout.length}) throw new RangeError("resident execution range does not match compiled layout")`,
    `    for (let __munIndex = __munRange.start; __munIndex < __munRange.end; __munIndex += 1) {`,
  ]
  for (let kernelIndex = 0; kernelIndex < region.kernels.length; kernelIndex += 1) {
    const kernel = region.kernels[kernelIndex]!
    if (kernel.kind !== "map") continue
    for (let outputIndex = 0; outputIndex < kernel.outputs.length; outputIndex += 1) {
      const output = kernel.outputs[outputIndex]!
      lines.push(`    const __munKernel${kernelIndex}Output${outputIndex} = ${emitExpression(output.value, context)}`)
    }
    for (let outputIndex = 0; outputIndex < kernel.outputs.length; outputIndex += 1) {
      const output = kernel.outputs[outputIndex]!
      const field = fieldVariables.get(output.name)
      if (!field) throw new TypeError(`resident kernel writes unknown packed field: ${output.name}`)
      lines.push(`    ${field}[__munIndex] = __munKernel${kernelIndex}Output${outputIndex}`)
    }
  }
  lines.push(
    `    }`,
    `  }`,
    `  __munSinkStorage.version += 1`,
    `  return __munSinkStorage`,
    `}`,
  )
  return lines.join("\n")
}

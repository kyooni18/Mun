import type {
  KernelBinaryOperator,
  KernelExpression,
  PackedLayout,
  ResidentRegionIR,
} from "@mun/core/internal/execution";

/** Kept structural so the compiler does not load the WASM runtime in bundles. */
export interface CompiledResidentWasmProgram {
  readonly version: 1;
  readonly regionId: string;
  readonly words: Uint32Array;
  readonly fieldNames: readonly string[];
  readonly captureNames: readonly string[];
  readonly operationCount: number;
  readonly maxStackDepth: number;
  /** Compiler-known hot-loop cost used by the adaptive native scheduler. */
  readonly costProfile: ResidentWasmCostProfile;
  /**
   * Region-specialized scalar WebAssembly. Unlike `words`, this is not an
   * interpreter program: the fused row loop and Kernel IR expressions are
   * emitted as native WASM instructions. The generic bytecode kernel remains
   * the compatibility path for shared-memory Worker execution and engines that
   * reject the specialized module.
   */
  readonly directModuleBytes?: Uint8Array;
  readonly directEntrypoint?: "resident_execute_direct";
  /** Region-specialized f32x4 module with an in-module scalar tail. */
  readonly directSimdModuleBytes?: Uint8Array;
  readonly directSimdEntrypoint?: "resident_execute_direct_simd";
  /** Shared-memory form of the same region-specialized SIMD loop for Workers. */
  readonly directSharedSimdModuleBytes?: Uint8Array;
  readonly directSharedSimdEntrypoint?: "resident_execute_direct_simd";
}

export interface ResidentWasmCostProfile {
  readonly loadOpsPerItem: number;
  readonly storeOpsPerItem: number;
  readonly scalarValueOpsPerItem: number;
  readonly arithmeticOpsPerItem: number;
  readonly divisionOpsPerItem: number;
  readonly comparisonOpsPerItem: number;
  readonly selectOpsPerItem: number;
  /** Weighted work units; deliberately comparable across resident regions. */
  readonly weightedOpsPerItem: number;
  /** 0...1 estimate. Direct f32x4 lowering is required for a high score. */
  readonly simdSuitability: number;
  /** Select density, kept separate because branch-like kernels cross over later. */
  readonly branchPressure: number;
}

export type ResidentWasmCompileRejection =
  | "single-use-region"
  | "non-packed-boundary"
  | "transfer-required"
  | "layout-mismatch"
  | "layout-not-dense-f32"
  | "non-map-kernel"
  | "too-many-columns"
  | "too-many-kernel-outputs"
  | "unsupported-expression"
  | "unknown-column"
  | "undeclared-capture"
  | "operand-stack-too-deep";

export type ResidentWasmCompileAnalysis =
  | Readonly<{ eligible: true; program: CompiledResidentWasmProgram; reasons: readonly [] }>
  | Readonly<{ eligible: false; program: null; reasons: readonly ResidentWasmCompileRejection[] }>;

const OP = Object.freeze({
  End: 0,
  Kernel: 1,
  ConstF32: 2,
  LoadColumn: 3,
  Index: 4,
  Capture: 5,
  Positive: 6,
  Negative: 7,
  Not: 8,
  Add: 9,
  Subtract: 10,
  Multiply: 11,
  Divide: 12,
  LessThan: 13,
  LessEqual: 14,
  GreaterThan: 15,
  GreaterEqual: 16,
  Equal: 17,
  NotEqual: 18,
  And: 19,
  Or: 20,
  Select: 21,
  StoreTemp: 22,
  Commit: 23,
});

const BINARY_OPCODE: Readonly<Partial<Record<KernelBinaryOperator, number>>> = Object.freeze({
  "+": OP.Add,
  "-": OP.Subtract,
  "*": OP.Multiply,
  "/": OP.Divide,
  "<": OP.LessThan,
  "<=": OP.LessEqual,
  ">": OP.GreaterThan,
  ">=": OP.GreaterEqual,
  "==": OP.Equal,
  "===": OP.Equal,
  "!=": OP.NotEqual,
  "!==": OP.NotEqual,
  "&&": OP.And,
  "||": OP.Or,
});

const WASM = Object.freeze({
  i32: 0x7f,
  f32: 0x7d,
  v128: 0x7b,
  emptyBlock: 0x40,
  block: 0x02,
  loop: 0x03,
  end: 0x0b,
  br: 0x0c,
  brIf: 0x0d,
  select: 0x1b,
  localGet: 0x20,
  localSet: 0x21,
  i32Load: 0x28,
  f32Load: 0x2a,
  f32Store: 0x38,
  i32Const: 0x41,
  f32Const: 0x43,
  i32Eqz: 0x45,
  i32GtU: 0x4b,
  i32GeU: 0x4f,
  f32Eq: 0x5b,
  f32Ne: 0x5c,
  f32Lt: 0x5d,
  f32Gt: 0x5e,
  f32Le: 0x5f,
  f32Ge: 0x60,
  i32Add: 0x6a,
  i32Mul: 0x6c,
  i32And: 0x71,
  i32Or: 0x72,
  f32Neg: 0x8c,
  f32Add: 0x92,
  f32Sub: 0x93,
  f32Mul: 0x94,
  f32Div: 0x95,
  f32ConvertI32S: 0xb2,
  f32ConvertI32U: 0xb3,
});

const SIMD = Object.freeze({
  prefix: 0xfd,
  v128Load: 0x00,
  v128Store: 0x0b,
  v128Const: 0x0c,
  i32x4Splat: 0x11,
  f32x4Splat: 0x13,
  f32x4Eq: 0x41,
  f32x4Ne: 0x42,
  f32x4Lt: 0x43,
  f32x4Gt: 0x44,
  f32x4Le: 0x45,
  f32x4Ge: 0x46,
  v128And: 0x4e,
  v128Or: 0x50,
  v128Bitselect: 0x52,
  i32x4Add: 0xae,
  f32x4Neg: 0xe1,
  f32x4Add: 0xe4,
  f32x4Sub: 0xe5,
  f32x4Mul: 0xe6,
  f32x4Div: 0xe7,
  f32x4ConvertI32x4U: 0xfb,
});

function encodeU32(value: number): number[] {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0xffff_ffff) {
    throw new RangeError(`WASM u32 immediate is outside range: ${value}`);
  }
  const bytes: number[] = [];
  let remaining = value >>> 0;
  do {
    let byte = remaining & 0x7f;
    remaining >>>= 7;
    if (remaining !== 0) byte |= 0x80;
    bytes.push(byte);
  } while (remaining !== 0);
  return bytes;
}

function wasmName(value: string): number[] {
  // Every name emitted by this module is compiler-owned ASCII. Keeping the
  // encoder tiny avoids pulling TextEncoder or a binary dependency into the
  // compiler package.
  const bytes = [...value].map(character => character.charCodeAt(0));
  if (bytes.some(byte => byte > 0x7f)) throw new TypeError("direct resident WASM names must be ASCII");
  return [...encodeU32(bytes.length), ...bytes];
}

function wasmVector(items: readonly (readonly number[])[]): number[] {
  return [...encodeU32(items.length), ...items.flatMap(item => [...item])];
}

function wasmSection(id: number, payload: readonly number[]): number[] {
  return [id, ...encodeU32(payload.length), ...payload];
}

function wasmF32(value: number | boolean): number[] {
  const buffer = new ArrayBuffer(4);
  new DataView(buffer).setFloat32(0, typeof value === "boolean" ? (value ? 1 : 0) : value, true);
  return [...new Uint8Array(buffer)];
}

function simdOpcode(opcode: number): number[] {
  return [SIMD.prefix, ...encodeU32(opcode)];
}

function wasmI32x4Const(values: readonly [number, number, number, number]): number[] {
  const buffer = new ArrayBuffer(16);
  const view = new DataView(buffer);
  values.forEach((value, index) => view.setInt32(index * 4, value, true));
  return [...simdOpcode(SIMD.v128Const), ...new Uint8Array(buffer)];
}

interface DirectWasmEmitContext {
  /** Compiler-assigned local containing the base pointer for each column. */
  readonly fieldPointers: ReadonlyMap<string, number>;
  readonly captures: ReadonlyMap<string, number>;
  readonly rowLocal: number;
}

interface DirectVectorWasmEmitContext extends DirectWasmEmitContext {}

function directExpressionKey(expression: KernelExpression): string {
  if (expression.op === "const") return `c:${String(expression.value)}`;
  if (expression.op === "index") return "i";
  if (expression.op === "capture") return `p:${expression.name}`;
  if (expression.op === "load") return `l:${expression.path.map(String).join(".")}`;
  if (expression.op === "unary") return `u:${expression.operator}:${directExpressionKey(expression.value)}`;
  if (expression.op === "binary") return `b:${expression.operator}:${directExpressionKey(expression.left)}:${directExpressionKey(expression.right)}`;
  return `s:${directExpressionKey(expression.condition)}:${directExpressionKey(expression.whenTrue)}:${directExpressionKey(expression.whenFalse)}`;
}

function directColumnAddress(pointerLocal: number, rowLocal: number): number[] {
  return [
    WASM.localGet, ...encodeU32(pointerLocal),
    WASM.localGet, ...encodeU32(rowLocal),
    WASM.i32Const, ...encodeU32(4),
    WASM.i32Mul,
    WASM.i32Add,
  ];
}

function emitDirectTruthiness(expression: KernelExpression, context: DirectWasmEmitContext): number[] {
  return [
    ...emitDirectExpression(expression, context),
    WASM.f32Const, ...wasmF32(0),
    WASM.f32Ne,
  ];
}

function emitDirectExpression(expression: KernelExpression, context: DirectWasmEmitContext): number[] {
  if (expression.op === "const") return [WASM.f32Const, ...wasmF32(expression.value)];
  if (expression.op === "index") {
    return [WASM.localGet, ...encodeU32(context.rowLocal), WASM.f32ConvertI32U];
  }
  if (expression.op === "capture") {
    const capture = context.captures.get(expression.name);
    if (capture === undefined) throw new CompileFailure("undeclared-capture", `resident capture is undeclared: ${expression.name}`);
    return [
      WASM.localGet, ...encodeU32(3),
      WASM.i32Const, ...encodeU32(capture * 4),
      WASM.i32Add,
      WASM.f32Load, 0x02, 0x00,
    ];
  }
  if (expression.op === "load") {
    if (expression.path.length !== 1 || typeof expression.path[0] !== "string") {
      throw new CompileFailure("unsupported-expression", "direct resident WASM requires a statically proven column load");
    }
    const pointerLocal = context.fieldPointers.get(expression.path[0]);
    if (pointerLocal === undefined) throw new CompileFailure("unknown-column", `resident WASM reads unknown column: ${expression.path[0]}`);
    return [...directColumnAddress(pointerLocal, context.rowLocal), WASM.f32Load, 0x02, 0x00];
  }
  if (expression.op === "unary") {
    if (expression.operator === "+") return emitDirectExpression(expression.value, context);
    if (expression.operator === "-") return [...emitDirectExpression(expression.value, context), WASM.f32Neg];
    if (expression.operator === "!") {
      return [
        ...emitDirectExpression(expression.value, context),
        WASM.f32Const, ...wasmF32(0),
        WASM.f32Eq,
        WASM.f32ConvertI32S,
      ];
    }
    throw new CompileFailure("unsupported-expression", `direct resident WASM does not support unary ${expression.operator}`);
  }
  if (expression.op === "binary") {
    const arithmetic: Readonly<Partial<Record<KernelBinaryOperator, number>>> = {
      "+": WASM.f32Add,
      "-": WASM.f32Sub,
      "*": WASM.f32Mul,
      "/": WASM.f32Div,
    };
    const comparison: Readonly<Partial<Record<KernelBinaryOperator, number>>> = {
      "<": WASM.f32Lt,
      "<=": WASM.f32Le,
      ">": WASM.f32Gt,
      ">=": WASM.f32Ge,
      "==": WASM.f32Eq,
      "===": WASM.f32Eq,
      "!=": WASM.f32Ne,
      "!==": WASM.f32Ne,
    };
    const arithmeticOpcode = arithmetic[expression.operator];
    if (arithmeticOpcode !== undefined) {
      return [
        ...emitDirectExpression(expression.left, context),
        ...emitDirectExpression(expression.right, context),
        arithmeticOpcode,
      ];
    }
    const comparisonOpcode = comparison[expression.operator];
    if (comparisonOpcode !== undefined) {
      return [
        ...emitDirectExpression(expression.left, context),
        ...emitDirectExpression(expression.right, context),
        comparisonOpcode,
        WASM.f32ConvertI32S,
      ];
    }
    if (expression.operator === "&&" || expression.operator === "||") {
      return [
        ...emitDirectTruthiness(expression.left, context),
        ...emitDirectTruthiness(expression.right, context),
        expression.operator === "&&" ? WASM.i32And : WASM.i32Or,
        WASM.f32ConvertI32S,
      ];
    }
    throw new CompileFailure("unsupported-expression", `direct resident WASM does not support binary ${expression.operator}`);
  }
  return [
    ...emitDirectExpression(expression.whenTrue, context),
    ...emitDirectExpression(expression.whenFalse, context),
    ...emitDirectTruthiness(expression.condition, context),
    WASM.select,
  ];
}

function emitVectorSplat(value: number | boolean): number[] {
  return [WASM.f32Const, ...wasmF32(value), ...simdOpcode(SIMD.f32x4Splat)];
}

function emitVectorTruthinessMask(expression: KernelExpression, context: DirectVectorWasmEmitContext): number[] {
  return [
    ...emitDirectVectorExpression(expression, context),
    ...emitVectorSplat(0),
    ...simdOpcode(SIMD.f32x4Ne),
  ];
}

function emitVectorBoolean(mask: readonly number[]): number[] {
  return [
    ...emitVectorSplat(1),
    ...emitVectorSplat(0),
    ...mask,
    ...simdOpcode(SIMD.v128Bitselect),
  ];
}

/**
 * Emit one f32x4 expression. Boolean-valued Kernel IR remains represented as
 * numeric 0/1 lanes, matching the scalar resident ABI rather than leaking mask
 * bit patterns into later arithmetic or stores.
 */
function emitDirectVectorExpression(expression: KernelExpression, context: DirectVectorWasmEmitContext): number[] {
  if (expression.op === "const") return emitVectorSplat(expression.value);
  if (expression.op === "index") {
    return [
      WASM.localGet, ...encodeU32(context.rowLocal),
      ...simdOpcode(SIMD.i32x4Splat),
      ...wasmI32x4Const([0, 1, 2, 3]),
      ...simdOpcode(SIMD.i32x4Add),
      ...simdOpcode(SIMD.f32x4ConvertI32x4U),
    ];
  }
  if (expression.op === "capture") {
    const capture = context.captures.get(expression.name);
    if (capture === undefined) throw new CompileFailure("undeclared-capture", `resident capture is undeclared: ${expression.name}`);
    return [
      WASM.localGet, ...encodeU32(3),
      WASM.i32Const, ...encodeU32(capture * 4),
      WASM.i32Add,
      WASM.f32Load, 0x02, 0x00,
      ...simdOpcode(SIMD.f32x4Splat),
    ];
  }
  if (expression.op === "load") {
    if (expression.path.length !== 1 || typeof expression.path[0] !== "string") {
      throw new CompileFailure("unsupported-expression", "direct SIMD resident WASM requires a statically proven column load");
    }
    const pointerLocal = context.fieldPointers.get(expression.path[0]);
    if (pointerLocal === undefined) throw new CompileFailure("unknown-column", `resident SIMD WASM reads unknown column: ${expression.path[0]}`);
    return [...directColumnAddress(pointerLocal, context.rowLocal), ...simdOpcode(SIMD.v128Load), 0x02, 0x00];
  }
  if (expression.op === "unary") {
    if (expression.operator === "+") return emitDirectVectorExpression(expression.value, context);
    if (expression.operator === "-") return [...emitDirectVectorExpression(expression.value, context), ...simdOpcode(SIMD.f32x4Neg)];
    if (expression.operator === "!") {
      return emitVectorBoolean([
        ...emitDirectVectorExpression(expression.value, context),
        ...emitVectorSplat(0),
        ...simdOpcode(SIMD.f32x4Eq),
      ]);
    }
    throw new CompileFailure("unsupported-expression", `direct SIMD resident WASM does not support unary ${expression.operator}`);
  }
  if (expression.op === "binary") {
    const arithmetic: Readonly<Partial<Record<KernelBinaryOperator, number>>> = {
      "+": SIMD.f32x4Add,
      "-": SIMD.f32x4Sub,
      "*": SIMD.f32x4Mul,
      "/": SIMD.f32x4Div,
    };
    const comparison: Readonly<Partial<Record<KernelBinaryOperator, number>>> = {
      "<": SIMD.f32x4Lt,
      "<=": SIMD.f32x4Le,
      ">": SIMD.f32x4Gt,
      ">=": SIMD.f32x4Ge,
      "==": SIMD.f32x4Eq,
      "===": SIMD.f32x4Eq,
      "!=": SIMD.f32x4Ne,
      "!==": SIMD.f32x4Ne,
    };
    const arithmeticOpcode = arithmetic[expression.operator];
    if (arithmeticOpcode !== undefined) {
      return [
        ...emitDirectVectorExpression(expression.left, context),
        ...emitDirectVectorExpression(expression.right, context),
        ...simdOpcode(arithmeticOpcode),
      ];
    }
    const comparisonOpcode = comparison[expression.operator];
    if (comparisonOpcode !== undefined) {
      return emitVectorBoolean([
        ...emitDirectVectorExpression(expression.left, context),
        ...emitDirectVectorExpression(expression.right, context),
        ...simdOpcode(comparisonOpcode),
      ]);
    }
    if (expression.operator === "&&" || expression.operator === "||") {
      return emitVectorBoolean([
        ...emitVectorTruthinessMask(expression.left, context),
        ...emitVectorTruthinessMask(expression.right, context),
        ...simdOpcode(expression.operator === "&&" ? SIMD.v128And : SIMD.v128Or),
      ]);
    }
    throw new CompileFailure("unsupported-expression", `direct SIMD resident WASM does not support binary ${expression.operator}`);
  }
  return [
    ...emitDirectVectorExpression(expression.whenTrue, context),
    ...emitDirectVectorExpression(expression.whenFalse, context),
    ...emitVectorTruthinessMask(expression.condition, context),
    ...simdOpcode(SIMD.v128Bitselect),
  ];
}

/**
 * Emit a region-specific f32x4 loop with a scalar tail for arbitrary dirty
 * range boundaries. This keeps one semantic implementation per region while
 * letting the engine execute four packed rows per vector iteration.
 */
function emitDirectResidentWasmSimdModule(
  region: ResidentRegionIR,
  fields: ReadonlyMap<string, number>,
  captures: ReadonlyMap<string, number>,
  sharedMemory = false,
): Uint8Array {
  const maxOutputs = Math.max(0, ...region.kernels.map(kernel => kernel.kind === "map" ? kernel.outputs.length : 0));
  const rowLocal = 4;
  const rangeLocal = 5;
  const endLocal = 6;
  const pointerBase = 7;
  const fieldPointers = new Map<string, number>();
  for (const [name, index] of fields) fieldPointers.set(name, pointerBase + index);
  const scalarTempBase = pointerBase + fields.size;
  const vectorTempBase = scalarTempBase + maxOutputs;
  const context: DirectVectorWasmEmitContext = { fieldPointers, captures, rowLocal };
  const instructions: number[] = [
    ...[...fields.entries()].flatMap(([, column], index) => [
      WASM.localGet, ...encodeU32(0),
      WASM.i32Const, ...encodeU32(column * 4),
      WASM.i32Add,
      WASM.i32Load, 0x02, 0x00,
      WASM.localSet, ...encodeU32(pointerBase + index),
    ]),
    WASM.i32Const, ...encodeU32(0),
    WASM.localSet, ...encodeU32(rangeLocal),
    WASM.block, WASM.emptyBlock,
    WASM.loop, WASM.emptyBlock,
    WASM.localGet, ...encodeU32(rangeLocal),
    WASM.localGet, ...encodeU32(2),
    WASM.i32GeU,
    WASM.brIf, ...encodeU32(1),
    WASM.localGet, ...encodeU32(1),
    WASM.localGet, ...encodeU32(rangeLocal),
    WASM.i32Const, ...encodeU32(8),
    WASM.i32Mul,
    WASM.i32Add,
    WASM.i32Load, 0x02, 0x00,
    WASM.localSet, ...encodeU32(rowLocal),
    WASM.localGet, ...encodeU32(1),
    WASM.localGet, ...encodeU32(rangeLocal),
    WASM.i32Const, ...encodeU32(8),
    WASM.i32Mul,
    WASM.i32Add,
    WASM.i32Const, ...encodeU32(4),
    WASM.i32Add,
    WASM.i32Load, 0x02, 0x00,
    WASM.localSet, ...encodeU32(endLocal),

    // Vector body: stop when fewer than four rows remain in this dirty range.
    WASM.block, WASM.emptyBlock,
    WASM.loop, WASM.emptyBlock,
    WASM.localGet, ...encodeU32(rowLocal),
    WASM.i32Const, ...encodeU32(4),
    WASM.i32Add,
    WASM.localGet, ...encodeU32(endLocal),
    WASM.i32GtU,
    WASM.brIf, ...encodeU32(1),
  ];

  for (const kernel of region.kernels) {
    if (kernel.kind !== "map") throw new CompileFailure("non-map-kernel", "direct SIMD resident WASM currently supports fused map kernels");
    const computed = new Map<string, number>();
    kernel.outputs.forEach((output, index) => {
      const key = directExpressionKey(output.value);
      const existing = computed.get(key);
      instructions.push(
        ...(existing === undefined
          ? emitDirectVectorExpression(output.value, context)
          : [WASM.localGet, ...encodeU32(vectorTempBase + existing)]),
        WASM.localSet, ...encodeU32(vectorTempBase + index),
      );
      if (existing === undefined) computed.set(key, index);
    });
    kernel.outputs.forEach((output, index) => {
      const pointerLocal = fieldPointers.get(output.name);
      if (pointerLocal === undefined) throw new CompileFailure("unknown-column", `resident SIMD WASM writes unknown column: ${output.name}`);
      instructions.push(
        ...directColumnAddress(pointerLocal, rowLocal),
        WASM.localGet, ...encodeU32(vectorTempBase + index),
        ...simdOpcode(SIMD.v128Store), 0x02, 0x00,
      );
    });
  }

  instructions.push(
    WASM.localGet, ...encodeU32(rowLocal),
    WASM.i32Const, ...encodeU32(4),
    WASM.i32Add,
    WASM.localSet, ...encodeU32(rowLocal),
    WASM.br, ...encodeU32(0),
    WASM.end,
    WASM.end,

    // Scalar tail retains exact semantics for 0..3 remaining rows.
    WASM.block, WASM.emptyBlock,
    WASM.loop, WASM.emptyBlock,
    WASM.localGet, ...encodeU32(rowLocal),
    WASM.localGet, ...encodeU32(endLocal),
    WASM.i32GeU,
    WASM.brIf, ...encodeU32(1),
  );
  const scalarContext: DirectWasmEmitContext = { fieldPointers, captures, rowLocal };
  for (const kernel of region.kernels) {
    if (kernel.kind !== "map") throw new CompileFailure("non-map-kernel", "direct SIMD resident WASM currently supports fused map kernels");
    const computed = new Map<string, number>();
    kernel.outputs.forEach((output, index) => {
      const key = directExpressionKey(output.value);
      const existing = computed.get(key);
      instructions.push(
        ...(existing === undefined
          ? emitDirectExpression(output.value, scalarContext)
          : [WASM.localGet, ...encodeU32(scalarTempBase + existing)]),
        WASM.localSet, ...encodeU32(scalarTempBase + index),
      );
      if (existing === undefined) computed.set(key, index);
    });
    kernel.outputs.forEach((output, index) => {
      const pointerLocal = fieldPointers.get(output.name);
      if (pointerLocal === undefined) throw new CompileFailure("unknown-column", `resident SIMD WASM writes unknown column: ${output.name}`);
      instructions.push(
        ...directColumnAddress(pointerLocal, rowLocal),
        WASM.localGet, ...encodeU32(scalarTempBase + index),
        WASM.f32Store, 0x02, 0x00,
      );
    });
  }
  instructions.push(
    WASM.localGet, ...encodeU32(rowLocal),
    WASM.i32Const, ...encodeU32(1),
    WASM.i32Add,
    WASM.localSet, ...encodeU32(rowLocal),
    WASM.br, ...encodeU32(0),
    WASM.end,
    WASM.end,

    WASM.localGet, ...encodeU32(rangeLocal),
    WASM.i32Const, ...encodeU32(1),
    WASM.i32Add,
    WASM.localSet, ...encodeU32(rangeLocal),
    WASM.br, ...encodeU32(0),
    WASM.end,
    WASM.end,
    WASM.i32Const, ...encodeU32(0),
    WASM.end,
  );

  const localGroups: number[][] = [[...encodeU32(3 + fields.size), WASM.i32]];
  if (maxOutputs > 0) {
    localGroups.push([...encodeU32(maxOutputs), WASM.f32]);
    localGroups.push([...encodeU32(maxOutputs), WASM.v128]);
  }
  const body = [...encodeU32(localGroups.length), ...localGroups.flat(), ...instructions];
  const functionType = [
    0x60,
    ...encodeU32(4), WASM.i32, WASM.i32, WASM.i32, WASM.i32,
    ...encodeU32(1), WASM.i32,
  ];
  const importMemory = sharedMemory
    ? [...wasmName("env"), ...wasmName("memory"), 0x02, 0x03, ...encodeU32(0), ...encodeU32(65_536)]
    : [...wasmName("env"), ...wasmName("memory"), 0x02, 0x00, ...encodeU32(0)];
  const exportedFunction = [...wasmName("resident_execute_direct_simd"), 0x00, ...encodeU32(0)];
  return new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...wasmSection(1, wasmVector([functionType])),
    ...wasmSection(2, wasmVector([importMemory])),
    ...wasmSection(3, wasmVector([[...encodeU32(0)]])),
    ...wasmSection(7, wasmVector([exportedFunction])),
    ...wasmSection(10, wasmVector([[...encodeU32(body.length), ...body]])),
  ]);
}

/**
 * Emit a tiny region-specific scalar WASM module. The hot row loop contains no
 * opcode dispatch or operand-stack interpreter; browser engines can compile the
 * exact fused arithmetic like an ordinary native function.
 */
function emitDirectResidentWasmModule(
  region: ResidentRegionIR,
  fields: ReadonlyMap<string, number>,
  captures: ReadonlyMap<string, number>,
): Uint8Array {
  const maxOutputs = Math.max(0, ...region.kernels.map(kernel => kernel.kind === "map" ? kernel.outputs.length : 0));
  const rowLocal = 4;
  const rangeLocal = 5;
  const endLocal = 6;
  const pointerBase = 7;
  const fieldPointers = new Map<string, number>();
  for (const [name, index] of fields) fieldPointers.set(name, pointerBase + index);
  const tempBase = pointerBase + fields.size;
  const context: DirectWasmEmitContext = { fieldPointers, captures, rowLocal };
  const instructions: number[] = [
    // Hoist SoA column base addresses out of the row/range loops. This is one
    // of the major advantages of region-specific code over the generic bytecode
    // interpreter, which has to resolve columns dynamically.
    ...[...fields.entries()].flatMap(([, column], index) => [
      WASM.localGet, ...encodeU32(0),
      WASM.i32Const, ...encodeU32(column * 4),
      WASM.i32Add,
      WASM.i32Load, 0x02, 0x00,
      WASM.localSet, ...encodeU32(pointerBase + index),
    ]),
    WASM.i32Const, ...encodeU32(0),
    WASM.localSet, ...encodeU32(rangeLocal),
    WASM.block, WASM.emptyBlock,
    WASM.loop, WASM.emptyBlock,
    WASM.localGet, ...encodeU32(rangeLocal),
    WASM.localGet, ...encodeU32(2),
    WASM.i32GeU,
    WASM.brIf, ...encodeU32(1),
    // row = ranges[rangeIndex * 2]
    WASM.localGet, ...encodeU32(1),
    WASM.localGet, ...encodeU32(rangeLocal),
    WASM.i32Const, ...encodeU32(8),
    WASM.i32Mul,
    WASM.i32Add,
    WASM.i32Load, 0x02, 0x00,
    WASM.localSet, ...encodeU32(rowLocal),
    // end = ranges[rangeIndex * 2 + 1]
    WASM.localGet, ...encodeU32(1),
    WASM.localGet, ...encodeU32(rangeLocal),
    WASM.i32Const, ...encodeU32(8),
    WASM.i32Mul,
    WASM.i32Add,
    WASM.i32Const, ...encodeU32(4),
    WASM.i32Add,
    WASM.i32Load, 0x02, 0x00,
    WASM.localSet, ...encodeU32(endLocal),
    WASM.block, WASM.emptyBlock,
    WASM.loop, WASM.emptyBlock,
    WASM.localGet, ...encodeU32(rowLocal),
    WASM.localGet, ...encodeU32(endLocal),
    WASM.i32GeU,
    WASM.brIf, ...encodeU32(1),
  ];

  for (const kernel of region.kernels) {
    if (kernel.kind !== "map") throw new CompileFailure("non-map-kernel", "direct resident WASM currently supports fused map kernels");
    const computed = new Map<string, number>();
    kernel.outputs.forEach((output, index) => {
      const key = directExpressionKey(output.value);
      const existing = computed.get(key);
      instructions.push(
        ...(existing === undefined
          ? emitDirectExpression(output.value, context)
          : [WASM.localGet, ...encodeU32(tempBase + existing)]),
        WASM.localSet, ...encodeU32(tempBase + index),
      );
      if (existing === undefined) computed.set(key, index);
    });
    kernel.outputs.forEach((output, index) => {
      const pointerLocal = fieldPointers.get(output.name);
      if (pointerLocal === undefined) throw new CompileFailure("unknown-column", `resident WASM writes unknown column: ${output.name}`);
      instructions.push(
        ...directColumnAddress(pointerLocal, rowLocal),
        WASM.localGet, ...encodeU32(tempBase + index),
        WASM.f32Store, 0x02, 0x00,
      );
    });
  }

  instructions.push(
    WASM.localGet, ...encodeU32(rowLocal),
    WASM.i32Const, ...encodeU32(1),
    WASM.i32Add,
    WASM.localSet, ...encodeU32(rowLocal),
    WASM.br, ...encodeU32(0),
    WASM.end,
    WASM.end,
    WASM.localGet, ...encodeU32(rangeLocal),
    WASM.i32Const, ...encodeU32(1),
    WASM.i32Add,
    WASM.localSet, ...encodeU32(rangeLocal),
    WASM.br, ...encodeU32(0),
    WASM.end,
    WASM.end,
    WASM.i32Const, ...encodeU32(0),
    WASM.end,
  );

  const localGroups: number[][] = [[...encodeU32(3 + fields.size), WASM.i32]];
  if (maxOutputs > 0) localGroups.push([...encodeU32(maxOutputs), WASM.f32]);
  const body = [
    ...encodeU32(localGroups.length),
    ...localGroups.flat(),
    ...instructions,
  ];
  const functionType = [
    0x60,
    ...encodeU32(4), WASM.i32, WASM.i32, WASM.i32, WASM.i32,
    ...encodeU32(1), WASM.i32,
  ];
  const importMemory = [
    ...wasmName("env"),
    ...wasmName("memory"),
    0x02,
    0x00, ...encodeU32(0),
  ];
  const exportedFunction = [
    ...wasmName("resident_execute_direct"),
    0x00, ...encodeU32(0),
  ];
  return new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...wasmSection(1, wasmVector([functionType])),
    ...wasmSection(2, wasmVector([importMemory])),
    ...wasmSection(3, wasmVector([[...encodeU32(0)]])),
    ...wasmSection(7, wasmVector([exportedFunction])),
    ...wasmSection(10, wasmVector([[...encodeU32(body.length), ...body]])),
  ]);
}

function sameLayout(left: PackedLayout, right: PackedLayout): boolean {
  return left.length === right.length
    && left.fields.length === right.fields.length
    && left.fields.every((field, index) => field.name === right.fields[index]?.name && field.type === right.fields[index]?.type);
}

function f32Bits(value: number | boolean): number {
  const buffer = new ArrayBuffer(4);
  new Float32Array(buffer)[0] = typeof value === "boolean" ? (value ? 1 : 0) : value;
  return new Uint32Array(buffer)[0]!;
}

interface EmitContext {
  readonly fields: ReadonlyMap<string, number>;
  readonly captures: ReadonlyMap<string, number>;
  readonly words: number[];
  operationCount: number;
  loadOps: number;
  storeOps: number;
  scalarValueOps: number;
  arithmeticOps: number;
  divisionOps: number;
  comparisonOps: number;
  selectOps: number;
}

class CompileFailure extends Error {
  readonly reason: ResidentWasmCompileRejection;

  constructor(reason: ResidentWasmCompileRejection, message: string) {
    super(message);
    this.reason = reason;
  }
}

function emitExpression(expression: KernelExpression, context: EmitContext): number {
  context.operationCount += 1;
  if (expression.op === "const") {
    context.scalarValueOps += 1;
    context.words.push(OP.ConstF32, f32Bits(expression.value));
    return 1;
  }
  if (expression.op === "index") {
    context.scalarValueOps += 1;
    context.words.push(OP.Index);
    return 1;
  }
  if (expression.op === "capture") {
    context.scalarValueOps += 1;
    const capture = context.captures.get(expression.name);
    if (capture === undefined) throw new CompileFailure("undeclared-capture", `resident capture is undeclared: ${expression.name}`);
    context.words.push(OP.Capture, capture);
    return 1;
  }
  if (expression.op === "load") {
    context.loadOps += 1;
    if (expression.path.length !== 1 || typeof expression.path[0] !== "string") {
      throw new CompileFailure("unsupported-expression", "resident WASM requires a statically proven column load");
    }
    const column = context.fields.get(expression.path[0]);
    if (column === undefined) throw new CompileFailure("unknown-column", `resident WASM reads unknown column: ${expression.path[0]}`);
    context.words.push(OP.LoadColumn, column);
    return 1;
  }
  if (expression.op === "unary") {
    context.arithmeticOps += 1;
    const depth = emitExpression(expression.value, context);
    if (expression.operator === "+") context.words.push(OP.Positive);
    else if (expression.operator === "-") context.words.push(OP.Negative);
    else if (expression.operator === "!") context.words.push(OP.Not);
    else throw new CompileFailure("unsupported-expression", `resident WASM does not support unary ${expression.operator}`);
    return depth;
  }
  if (expression.op === "binary") {
    const opcode = BINARY_OPCODE[expression.operator];
    if (opcode === undefined) throw new CompileFailure("unsupported-expression", `resident WASM does not support binary ${expression.operator}`);
    if (expression.operator === "+" || expression.operator === "-" || expression.operator === "*" || expression.operator === "/") {
      context.arithmeticOps += 1;
      if (expression.operator === "/") context.divisionOps += 1;
    } else {
      context.comparisonOps += 1;
    }
    const leftDepth = emitExpression(expression.left, context);
    const rightDepth = emitExpression(expression.right, context);
    context.words.push(opcode);
    return Math.max(leftDepth, 1 + rightDepth);
  }
  context.selectOps += 1;
  const conditionDepth = emitExpression(expression.condition, context);
  const trueDepth = emitExpression(expression.whenTrue, context);
  const falseDepth = emitExpression(expression.whenFalse, context);
  context.words.push(OP.Select);
  return Math.max(conditionDepth, 1 + trueDepth, 2 + falseDepth);
}

function staticRejections(region: ResidentRegionIR): ResidentWasmCompileRejection[] {
  const reasons = new Set<ResidentWasmCompileRejection>();
  if (region.lifetime === "single-use") reasons.add("single-use-region");
  if (region.inputResidency !== "packed" || region.outputResidency !== "packed") reasons.add("non-packed-boundary");
  if (region.estimatedTransferBytes !== 0) reasons.add("transfer-required");
  if (!sameLayout(region.source.layout, region.sink.layout)) reasons.add("layout-mismatch");
  if (region.source.layout.fields.some(field => field.type !== "f32")) reasons.add("layout-not-dense-f32");
  if (region.source.layout.fields.length > 64) reasons.add("too-many-columns");
  if (region.kernels.some(kernel => kernel.kind !== "map")) reasons.add("non-map-kernel");
  if (region.kernels.some(kernel => kernel.kind === "map" && kernel.outputs.length > 64)) reasons.add("too-many-kernel-outputs");
  return [...reasons];
}

export function analyzeResidentWasmRegion(region: ResidentRegionIR): ResidentWasmCompileAnalysis {
  const reasons = staticRejections(region);
  if (reasons.length > 0) return Object.freeze({ eligible: false, program: null, reasons: Object.freeze(reasons) });
  const fieldNames = Object.freeze(region.source.layout.fields.map(field => field.name));
  const fields = new Map(fieldNames.map((name, index) => [name, index]));
  const captureNames = Object.freeze([...new Set(region.kernels.flatMap(kernel => [...kernel.captures]))].sort());
  const captures = new Map(captureNames.map((name, index) => [name, index]));
  const context: EmitContext = {
    fields,
    captures,
    words: [],
    operationCount: 0,
    loadOps: 0,
    storeOps: 0,
    scalarValueOps: 0,
    arithmeticOps: 0,
    divisionOps: 0,
    comparisonOps: 0,
    selectOps: 0,
  };
  let maxStackDepth = 0;
  try {
    for (const kernel of region.kernels) {
      if (kernel.kind !== "map") throw new CompileFailure("non-map-kernel", "resident WASM currently supports fused map kernels");
      context.words.push(OP.Kernel, kernel.outputs.length);
      for (const output of kernel.outputs) {
        const column = fields.get(output.name);
        if (column === undefined) throw new CompileFailure("unknown-column", `resident WASM writes unknown column: ${output.name}`);
        maxStackDepth = Math.max(maxStackDepth, emitExpression(output.value, context));
        context.words.push(OP.StoreTemp, column);
        context.storeOps += 1;
      }
      context.words.push(OP.Commit);
    }
    if (maxStackDepth > 128) throw new CompileFailure("operand-stack-too-deep", "resident WASM expression stack exceeds 128 values");
  } catch (error) {
    if (!(error instanceof CompileFailure)) throw error;
    return Object.freeze({ eligible: false, program: null, reasons: Object.freeze([error.reason]) });
  }
  context.words.push(OP.End);
  let directModuleBytes: Uint8Array | undefined;
  let directSimdModuleBytes: Uint8Array | undefined;
  let directSharedSimdModuleBytes: Uint8Array | undefined;
  try {
    directModuleBytes = emitDirectResidentWasmModule(region, fields, captures);
  } catch (error) {
    // The bytecode program is still the required compatibility representation.
    // A direct-module emitter rejection must never make an otherwise supported
    // Resident Compute region incorrect or unavailable.
    if (!(error instanceof CompileFailure)) throw error;
  }
  try {
    directSimdModuleBytes = emitDirectResidentWasmSimdModule(region, fields, captures);
  } catch (error) {
    // SIMD specialization is strictly optional. Scalar direct WASM and the
    // generic resident kernels remain available when a vector expression is
    // outside the current lowering subset.
    if (!(error instanceof CompileFailure)) throw error;
  }
  if (directSimdModuleBytes) {
    try {
      directSharedSimdModuleBytes = emitDirectResidentWasmSimdModule(region, fields, captures, true);
    } catch (error) {
      if (!(error instanceof CompileFailure)) throw error;
    }
  }
  const branchBase = Math.max(1, context.arithmeticOps + context.comparisonOps + context.selectOps);
  const branchPressure = context.selectOps / branchBase;
  const weightedOpsPerItem = context.operationCount
    + context.storeOps * 0.5
    + context.selectOps * 1.5
    + context.divisionOps * 1.5;
  const simdSuitability = directSimdModuleBytes
    ? Math.max(0.75, 1 - branchPressure * 0.25)
    : 0;
  const costProfile: ResidentWasmCostProfile = Object.freeze({
    loadOpsPerItem: context.loadOps,
    storeOpsPerItem: context.storeOps,
    scalarValueOpsPerItem: context.scalarValueOps,
    arithmeticOpsPerItem: context.arithmeticOps,
    divisionOpsPerItem: context.divisionOps,
    comparisonOpsPerItem: context.comparisonOps,
    selectOpsPerItem: context.selectOps,
    weightedOpsPerItem,
    simdSuitability,
    branchPressure,
  });
  const program: CompiledResidentWasmProgram = Object.freeze({
    version: 1,
    regionId: region.id,
    words: new Uint32Array(context.words),
    fieldNames,
    captureNames,
    operationCount: context.operationCount,
    maxStackDepth,
    costProfile,
    ...(directModuleBytes ? {
      directModuleBytes,
      directEntrypoint: "resident_execute_direct" as const,
    } : {}),
    ...(directSimdModuleBytes ? {
      directSimdModuleBytes,
      directSimdEntrypoint: "resident_execute_direct_simd" as const,
    } : {}),
    ...(directSharedSimdModuleBytes ? {
      directSharedSimdModuleBytes,
      directSharedSimdEntrypoint: "resident_execute_direct_simd" as const,
    } : {}),
  });
  return Object.freeze({ eligible: true, program, reasons: Object.freeze([]) as readonly [] });
}

export function compileResidentWasmRegion(region: ResidentRegionIR): CompiledResidentWasmProgram {
  const analysis = analyzeResidentWasmRegion(region);
  if (!analysis.eligible) throw new TypeError(`resident WASM promotion rejected: ${analysis.reasons.join(", ")}`);
  return analysis.program;
}

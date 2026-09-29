const WORKGROUP_SIZE = 64
const FLOATS_PER_PARTICLE = 8
const PARTICLE_STRIDE = FLOATS_PER_PARTICLE * Float32Array.BYTES_PER_ELEMENT
const FLOATS_PER_CHART_POINT = 4
const CHART_POINT_STRIDE = FLOATS_PER_CHART_POINT * Float32Array.BYTES_PER_ELEMENT
const FRAME_PARAMETER_BYTES = 16
const VALIDATED_ISLAND = Symbol("validated GPU Island")

const gpuGlobals = globalThis as unknown as {
  GPUBufferUsage?: { readonly COPY_DST: number; readonly STORAGE: number; readonly UNIFORM: number; readonly VERTEX: number }
  GPUShaderStage?: { readonly COMPUTE: number; readonly FRAGMENT: number; readonly VERTEX: number }
}

const BUFFER_USAGE = gpuGlobals.GPUBufferUsage ?? {
  COPY_DST: 8,
  STORAGE: 128,
  UNIFORM: 64,
  VERTEX: 32,
}
const SHADER_STAGE = gpuGlobals.GPUShaderStage ?? { COMPUTE: 4, FRAGMENT: 2, VERTEX: 1 }

const COMPUTE_SHADER = /* wgsl */ `
struct Particle {
  position: vec2<f32>,
  velocity: vec2<f32>,
  color: vec4<f32>,
};

struct FrameParameters {
  dt: f32,
  count: u32,
  elapsed: f32,
  _padding: f32,
};

@group(0) @binding(0) var<storage, read_write> particles: array<Particle>;
@group(0) @binding(1) var<uniform> frame: FrameParameters;

@compute @workgroup_size(64)
fn computeParticles(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= frame.count) { return; }
  var particle = particles[id.x];
  var next = particle.position + particle.velocity * frame.dt;
  if (abs(next.x) > 1.0) {
    particle.velocity.x = -particle.velocity.x;
    next.x = clamp(next.x, -1.0, 1.0);
  }
  if (abs(next.y) > 1.0) {
    particle.velocity.y = -particle.velocity.y;
    next.y = clamp(next.y, -1.0, 1.0);
  }
  particle.position = next;
  particles[id.x] = particle;
}
`

const RENDER_SHADER = /* wgsl */ `
struct VertexOutput {
  @builtin(position) position: vec4<f32>,
  @location(0) color: vec4<f32>,
};

@vertex
fn renderParticle(
  @location(0) position: vec2<f32>,
  @location(1) color: vec4<f32>,
) -> VertexOutput {
  var output: VertexOutput;
  output.position = vec4<f32>(position, 0.0, 1.0);
  output.color = color;
  return output;
}

@fragment
fn shadeParticle(input: VertexOutput) -> @location(0) vec4<f32> {
  return input.color;
}
`

const CHART_COMPUTE_SHADER = /* wgsl */ `
struct ChartPoint {
  source: vec2<f32>,
  position: vec2<f32>,
};

struct FrameParameters {
  count: u32,
  elapsed: f32,
  amplitude: f32,
  _padding: f32,
};

@group(0) @binding(0) var<storage, read_write> points: array<ChartPoint>;
@group(0) @binding(1) var<uniform> frame: FrameParameters;

@compute @workgroup_size(64)
fn computeChartPoints(@builtin(global_invocation_id) id: vec3<u32>) {
  if (id.x >= frame.count) { return; }
  var point = points[id.x];
  let wave = sin(frame.elapsed + point.source.x * 6.28318530718) * frame.amplitude;
  point.position = vec2<f32>(point.source.x, clamp(point.source.y + wave, -1.0, 1.0));
  points[id.x] = point;
}
`

const CHART_RENDER_SHADER = /* wgsl */ `
struct VertexOutput {
  @builtin(position) position: vec4<f32>,
};

@vertex
fn renderChartPoint(@location(0) position: vec2<f32>) -> VertexOutput {
  var output: VertexOutput;
  output.position = vec4<f32>(position, 0.0, 1.0);
  return output;
}

@fragment
fn shadeChartLine() -> @location(0) vec4<f32> {
  return vec4<f32>(1.0, 1.0, 1.0, 1.0);
}
`

type UnknownRecord = Record<string, unknown>
type UnknownFunction = (...arguments_: unknown[]) => unknown

function record(value: unknown, label: string): UnknownRecord {
  if ((typeof value !== "object" && typeof value !== "function") || value === null) {
    throw new TypeError(`${label} must be an object.`)
  }
  return value as UnknownRecord
}

function requiredMethod(target: UnknownRecord, name: string, owner: string): UnknownFunction {
  const candidate = target[name]
  if (typeof candidate !== "function") throw new TypeError(`${owner} requires ${name}().`)
  return candidate.bind(target) as UnknownFunction
}

function optionalMethod(target: UnknownRecord, name: string): UnknownFunction | undefined {
  const candidate = target[name]
  return typeof candidate === "function" ? candidate.bind(target) as UnknownFunction : undefined
}

function finiteLimit(limits: UnknownRecord, name: string): number {
  const value = Number(limits[name])
  if (!Number.isFinite(value) || value <= 0) throw new TypeError(`GPUDevice.limits.${name} must be available.`)
  return value
}

function normalizedCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new RangeError("A GPU Island item count must be a positive safe integer.")
  return value
}

function normalizedFormat(value: string): string {
  if (typeof value !== "string" || !/^[a-z0-9-]+$/u.test(value)) {
    throw new TypeError("A GPU Island requires an explicit GPU canvas format.")
  }
  return value
}

function normalizedClearColor(value: readonly [number, number, number, number] | undefined): Readonly<UnknownRecord> {
  const color = value ?? [0, 0, 0, 0]
  if (color.length !== 4 || color.some(channel => !Number.isFinite(channel))) {
    throw new TypeError("GPU Island clearColor must contain four finite channels.")
  }
  return Object.freeze({ r: color[0], g: color[1], b: color[2], a: color[3] })
}

function errorFrom(cause: unknown, prefix: string): Error {
  if (cause instanceof Error) return new Error(`${prefix}: ${cause.message}`, { cause })
  return new Error(`${prefix}: ${String(cause)}`, { cause })
}

function deviceLostError(info: unknown): Error {
  if (info && typeof info === "object") {
    const message = (info as UnknownRecord).message
    const reason = (info as UnknownRecord).reason
    const detail = typeof message === "string" && message.length > 0 ? message : String(reason ?? "unknown reason")
    return new Error(`GPU Island device lost: ${detail}`)
  }
  return new Error("GPU Island device lost.")
}

async function validateShaderModule(module: UnknownRecord, label: string): Promise<void> {
  const getCompilationInfo = requiredMethod(module, "getCompilationInfo", `${label} shader module`)
  const info = record(await getCompilationInfo(), `${label} shader compilation info`)
  if (!Array.isArray(info.messages)) throw new TypeError(`${label} shader compilation info requires messages.`)
  const errors = info.messages.filter(message => {
    return message && typeof message === "object" && (message as UnknownRecord).type === "error"
  })
  if (errors.length === 0) return
  const details = errors.map(message => {
    const text = (message as UnknownRecord).message
    return typeof text === "string" ? text : "unknown shader error"
  }).join("; ")
  throw new Error(`${label} shader validation failed: ${details}`)
}

function validateInitialData(data: Float32Array | undefined, count: number): void {
  if (data === undefined) return
  if (!(data instanceof Float32Array) || data.length !== count * FLOATS_PER_PARTICLE) {
    throw new RangeError(`GPU Island initialData must contain exactly ${count * FLOATS_PER_PARTICLE} float values.`)
  }
  for (const value of data) {
    if (!Number.isFinite(value)) throw new TypeError("GPU Island initialData must contain only finite values.")
  }
}

function validateLineChartInitialData(data: Float32Array | undefined, count: number): void {
  if (data === undefined) return
  if (!(data instanceof Float32Array) || data.length !== count * FLOATS_PER_CHART_POINT) {
    throw new RangeError(`GPU LineChart initialData must contain exactly ${count * FLOATS_PER_CHART_POINT} float values.`)
  }
  for (const value of data) {
    if (!Number.isFinite(value)) throw new TypeError("GPU LineChart initialData must contain only finite values.")
  }
}

function validateCapacity(device: UnknownRecord, count: number): number {
  const byteLength = count * PARTICLE_STRIDE
  if (!Number.isSafeInteger(byteLength)) throw new RangeError("GPU Island particle storage exceeds the safe buffer size.")
  const limits = record(device.limits, "GPUDevice.limits")
  if (byteLength > finiteLimit(limits, "maxBufferSize")) throw new RangeError("GPU Island particle storage exceeds maxBufferSize.")
  if (byteLength > finiteLimit(limits, "maxStorageBufferBindingSize")) {
    throw new RangeError("GPU Island particle storage exceeds maxStorageBufferBindingSize.")
  }
  const groups = Math.ceil(count / WORKGROUP_SIZE)
  if (groups > finiteLimit(limits, "maxComputeWorkgroupsPerDimension")) {
    throw new RangeError("GPU Island dispatch exceeds maxComputeWorkgroupsPerDimension.")
  }
  return byteLength
}

function validateLineChartCapacity(device: UnknownRecord, count: number): number {
  const byteLength = count * CHART_POINT_STRIDE
  if (!Number.isSafeInteger(byteLength)) throw new RangeError("GPU LineChart storage exceeds the safe buffer size.")
  const limits = record(device.limits, "GPUDevice.limits")
  if (byteLength > finiteLimit(limits, "maxBufferSize")) throw new RangeError("GPU LineChart storage exceeds maxBufferSize.")
  if (byteLength > finiteLimit(limits, "maxStorageBufferBindingSize")) throw new RangeError("GPU LineChart storage exceeds maxStorageBufferBindingSize.")
  if (Math.ceil(count / WORKGROUP_SIZE) > finiteLimit(limits, "maxComputeWorkgroupsPerDimension")) {
    throw new RangeError("GPU LineChart dispatch exceeds maxComputeWorkgroupsPerDimension.")
  }
  return byteLength
}

function validateDeviceAndContext(deviceValue: unknown, contextValue: unknown): {
  readonly context: UnknownRecord
  readonly device: UnknownRecord
  readonly queue: UnknownRecord
  readonly lost: PromiseLike<unknown>
} {
  const device = record(deviceValue, "GPU Island device")
  for (const method of [
    "createBindGroup", "createBindGroupLayout", "createBuffer", "createCommandEncoder",
    "createComputePipeline", "createPipelineLayout", "createRenderPipeline", "createShaderModule",
  ]) requiredMethod(device, method, "GPU Island device")
  const queue = record(device.queue, "GPUDevice.queue")
  requiredMethod(queue, "submit", "GPUDevice.queue")
  requiredMethod(queue, "writeBuffer", "GPUDevice.queue")
  const lost = device.lost
  if (!lost || (typeof lost !== "object" && typeof lost !== "function") || typeof (lost as PromiseLike<unknown>).then !== "function") {
    throw new TypeError("GPU Island device requires a device-loss promise.")
  }
  const context = record(contextValue, "GPUCanvasContext")
  requiredMethod(context, "configure", "GPUCanvasContext")
  requiredMethod(context, "getCurrentTexture", "GPUCanvasContext")
  return { context, device, queue, lost: lost as PromiseLike<unknown> }
}

export interface ParticleFieldGPUIslandOptions {
  readonly count: number
  readonly format: string
  readonly initialData?: Float32Array
  readonly clearColor?: readonly [number, number, number, number]
  readonly alphaMode?: "opaque" | "premultiplied"
  readonly label?: string
  readonly onFailure?: (error: Error) => void
}

export interface LineChartGPUIslandOptions {
  readonly count: number
  readonly format: string
  readonly initialData?: Float32Array
  readonly clearColor?: readonly [number, number, number, number]
  readonly alphaMode?: "opaque" | "premultiplied"
  readonly amplitude?: number
  readonly label?: string
  readonly onFailure?: (error: Error) => void
}

export type GPUIslandStatus = "active" | "failed" | "disposed"

interface GPUIslandResources {
  readonly bindGroup: unknown
  readonly computePipeline: unknown
  readonly context: UnknownRecord
  readonly device: UnknownRecord
  readonly lost: PromiseLike<unknown>
  readonly particleBuffer: UnknownRecord
  readonly parameterBuffer: UnknownRecord
  readonly queue: UnknownRecord
  readonly renderPipeline: unknown
}

interface SharedParticlePipelines {
  readonly computeBindGroupLayout: unknown
  readonly computePipeline: unknown
  readonly renderPipeline: unknown
}

interface SharedLineChartPipelines {
  readonly computeBindGroupLayout: unknown
  readonly computePipeline: unknown
  readonly renderPipeline: unknown
}

const particlePipelineCache = new WeakMap<object, Map<string, Promise<SharedParticlePipelines>>>()
const lineChartPipelineCache = new WeakMap<object, Map<string, Promise<SharedLineChartPipelines>>>()

async function sharedParticlePipelines(device: UnknownRecord, format: string): Promise<SharedParticlePipelines> {
  const key = device as object
  let byFormat = particlePipelineCache.get(key)
  if (!byFormat) {
    byFormat = new Map()
    particlePipelineCache.set(key, byFormat)
  }
  let pending = byFormat.get(format)
  if (pending) return pending
  pending = (async () => {
    const createShaderModule = requiredMethod(device, "createShaderModule", "GPU Island device")
    const computeModule = record(createShaderModule({ label: "Mun particle compute shader", code: COMPUTE_SHADER }), "GPU compute shader module")
    const renderModule = record(createShaderModule({ label: "Mun particle render shader", code: RENDER_SHADER }), "GPU render shader module")
    await Promise.all([
      validateShaderModule(computeModule, "GPU Island compute"),
      validateShaderModule(renderModule, "GPU Island render"),
    ])
    const computeBindGroupLayout = requiredMethod(device, "createBindGroupLayout", "GPU Island device")({
      label: "Mun particle compute bindings",
      entries: [
        { binding: 0, visibility: SHADER_STAGE.COMPUTE, buffer: { type: "storage", minBindingSize: PARTICLE_STRIDE } },
        { binding: 1, visibility: SHADER_STAGE.COMPUTE, buffer: { type: "uniform", minBindingSize: FRAME_PARAMETER_BYTES } },
      ],
    })
    const computeLayout = requiredMethod(device, "createPipelineLayout", "GPU Island device")({
      label: "Mun particle compute layout",
      bindGroupLayouts: [computeBindGroupLayout],
    })
    const renderLayout = requiredMethod(device, "createPipelineLayout", "GPU Island device")({
      label: "Mun particle render layout",
      bindGroupLayouts: [],
    })
    const computePipeline = requiredMethod(device, "createComputePipeline", "GPU Island device")({
      label: "Mun particle compute pipeline",
      layout: computeLayout,
      compute: { module: computeModule, entryPoint: "computeParticles" },
    })
    const renderPipeline = requiredMethod(device, "createRenderPipeline", "GPU Island device")({
      label: "Mun particle render pipeline",
      layout: renderLayout,
      vertex: {
        module: renderModule,
        entryPoint: "renderParticle",
        buffers: [{
          arrayStride: PARTICLE_STRIDE,
          stepMode: "vertex",
          attributes: [
            { shaderLocation: 0, offset: 0, format: "float32x2" },
            { shaderLocation: 1, offset: 16, format: "float32x4" },
          ],
        }],
      },
      fragment: {
        module: renderModule,
        entryPoint: "shadeParticle",
        targets: [{ format }],
      },
      primitive: { topology: "point-list" },
    })
    return Object.freeze({ computeBindGroupLayout, computePipeline, renderPipeline })
  })()
  byFormat.set(format, pending)
  try {
    return await pending
  } catch (error) {
    if (byFormat.get(format) === pending) byFormat.delete(format)
    throw error
  }
}

async function sharedLineChartPipelines(device: UnknownRecord, format: string): Promise<SharedLineChartPipelines> {
  const key = device as object
  let byFormat = lineChartPipelineCache.get(key)
  if (!byFormat) {
    byFormat = new Map()
    lineChartPipelineCache.set(key, byFormat)
  }
  let pending = byFormat.get(format)
  if (pending) return pending
  pending = (async () => {
    const createShaderModule = requiredMethod(device, "createShaderModule", "GPU Island device")
    const computeModule = record(createShaderModule({ label: "Mun chart compute shader", code: CHART_COMPUTE_SHADER }), "GPU chart compute shader module")
    const renderModule = record(createShaderModule({ label: "Mun chart render shader", code: CHART_RENDER_SHADER }), "GPU chart render shader module")
    await Promise.all([
      validateShaderModule(computeModule, "GPU LineChart compute"),
      validateShaderModule(renderModule, "GPU LineChart render"),
    ])
    const computeBindGroupLayout = requiredMethod(device, "createBindGroupLayout", "GPU Island device")({
      label: "Mun chart compute bindings",
      entries: [
        { binding: 0, visibility: SHADER_STAGE.COMPUTE, buffer: { type: "storage", minBindingSize: CHART_POINT_STRIDE } },
        { binding: 1, visibility: SHADER_STAGE.COMPUTE, buffer: { type: "uniform", minBindingSize: FRAME_PARAMETER_BYTES } },
      ],
    })
    const computeLayout = requiredMethod(device, "createPipelineLayout", "GPU Island device")({
      label: "Mun chart compute layout",
      bindGroupLayouts: [computeBindGroupLayout],
    })
    const renderLayout = requiredMethod(device, "createPipelineLayout", "GPU Island device")({
      label: "Mun chart render layout",
      bindGroupLayouts: [],
    })
    const computePipeline = requiredMethod(device, "createComputePipeline", "GPU Island device")({
      label: "Mun chart compute pipeline",
      layout: computeLayout,
      compute: { module: computeModule, entryPoint: "computeChartPoints" },
    })
    const renderPipeline = requiredMethod(device, "createRenderPipeline", "GPU Island device")({
      label: "Mun chart render pipeline",
      layout: renderLayout,
      vertex: {
        module: renderModule,
        entryPoint: "renderChartPoint",
        buffers: [{
          arrayStride: CHART_POINT_STRIDE,
          stepMode: "vertex",
          attributes: [{ shaderLocation: 0, offset: 8, format: "float32x2" }],
        }],
      },
      fragment: {
        module: renderModule,
        entryPoint: "shadeChartLine",
        targets: [{ format }],
      },
      primitive: { topology: "line-strip" },
    })
    return Object.freeze({ computeBindGroupLayout, computePipeline, renderPipeline })
  })()
  byFormat.set(format, pending)
  try {
    return await pending
  } catch (error) {
    if (byFormat.get(format) === pending) byFormat.delete(format)
    throw error
  }
}

/**
 * A renderer-owned compute island. Particle storage becomes GPU-authoritative
 * at creation and the exact same buffer is consumed by the compute and render
 * passes. Frames only upload a 16-byte uniform; they never expose particle rows
 * to JavaScript or copy GPU results into host-visible memory.
 */
export class ParticleFieldGPUIsland {
  readonly kind = "gpu-island" as const
  readonly count: number
  readonly format: string
  readonly byteLength: number
  readonly workgroupSize = WORKGROUP_SIZE

  private readonly resources: GPUIslandResources
  private readonly clearColor: Readonly<UnknownRecord>
  private readonly label: string
  private readonly onFailure?: (error: Error) => void
  private readonly frameParameters = new Float32Array(FRAME_PARAMETER_BYTES / Float32Array.BYTES_PER_ELEMENT)
  private readonly frameParameterWords = new Uint32Array(this.frameParameters.buffer)
  private state: GPUIslandStatus = "active"
  private failureValue: Error | undefined
  private elapsedSeconds = 0
  private resourcesDestroyed = false
  private uncapturedErrorListener?: (event: unknown) => void

  constructor(
    validation: typeof VALIDATED_ISLAND,
    resources: GPUIslandResources,
    options: ParticleFieldGPUIslandOptions,
    byteLength: number,
  ) {
    if (validation !== VALIDATED_ISLAND) throw new TypeError("GPU Islands must be created through createParticleFieldGPUIsland().")
    this.resources = resources
    this.count = options.count
    this.format = options.format
    this.byteLength = byteLength
    this.label = options.label ?? "Mun ParticleField GPU Island"
    this.clearColor = normalizedClearColor(options.clearColor)
    this.onFailure = options.onFailure

    this.uncapturedErrorListener = event => {
      const candidate = event && typeof event === "object" ? (event as UnknownRecord).error : event
      this.fail(errorFrom(candidate, "GPU Island uncaptured device error"))
    }
    optionalMethod(resources.device, "addEventListener")?.("uncapturederror", this.uncapturedErrorListener)
    void Promise.resolve(resources.lost).then(
      info => this.fail(deviceLostError(info)),
      cause => this.fail(errorFrom(cause, "GPU Island device-loss observation failed")),
    )
  }

  get status(): GPUIslandStatus { return this.state }
  get failure(): Error | undefined { return this.failureValue }

  /** Encode compute followed by render and submit both as one ordered command buffer. */
  renderFrame(deltaSeconds: number): void {
    this.assertActive()
    if (!Number.isFinite(deltaSeconds) || deltaSeconds < 0) throw new RangeError("GPU Island frame delta must be finite and non-negative.")
    const dt = Math.min(deltaSeconds, 0.1)
    this.elapsedSeconds += dt
    this.frameParameters[0] = dt
    this.frameParameterWords[1] = this.count
    this.frameParameters[2] = this.elapsedSeconds

    try {
      requiredMethod(this.resources.queue, "writeBuffer", "GPUDevice.queue")(
        this.resources.parameterBuffer,
        0,
        this.frameParameters,
      )
      const encoder = record(
        requiredMethod(this.resources.device, "createCommandEncoder", "GPU Island device")({ label: `${this.label} frame` }),
        "GPUCommandEncoder",
      )
      const computePass = record(requiredMethod(encoder, "beginComputePass", "GPUCommandEncoder")({
        label: `${this.label} compute`,
      }), "GPUComputePassEncoder")
      requiredMethod(computePass, "setPipeline", "GPUComputePassEncoder")(this.resources.computePipeline)
      requiredMethod(computePass, "setBindGroup", "GPUComputePassEncoder")(0, this.resources.bindGroup)
      requiredMethod(computePass, "dispatchWorkgroups", "GPUComputePassEncoder")(Math.ceil(this.count / WORKGROUP_SIZE))
      requiredMethod(computePass, "end", "GPUComputePassEncoder")()

      const texture = record(
        requiredMethod(this.resources.context, "getCurrentTexture", "GPUCanvasContext")(),
        "GPUCanvasTexture",
      )
      const view = requiredMethod(texture, "createView", "GPUCanvasTexture")()
      const renderPass = record(requiredMethod(encoder, "beginRenderPass", "GPUCommandEncoder")({
        label: `${this.label} render`,
        colorAttachments: [{
          view,
          clearValue: this.clearColor,
          loadOp: "clear",
          storeOp: "store",
        }],
      }), "GPURenderPassEncoder")
      requiredMethod(renderPass, "setPipeline", "GPURenderPassEncoder")(this.resources.renderPipeline)
      requiredMethod(renderPass, "setVertexBuffer", "GPURenderPassEncoder")(0, this.resources.particleBuffer)
      requiredMethod(renderPass, "draw", "GPURenderPassEncoder")(this.count, 1, 0, 0)
      requiredMethod(renderPass, "end", "GPURenderPassEncoder")()
      const commands = requiredMethod(encoder, "finish", "GPUCommandEncoder")()
      requiredMethod(this.resources.queue, "submit", "GPUDevice.queue")([commands])
    } catch (cause) {
      const failure = errorFrom(cause, "GPU Island frame failed")
      this.fail(failure)
      throw failure
    }
  }

  dispose(): void {
    if (this.state === "disposed") return
    this.state = "disposed"
    this.destroyResources()
  }

  private assertActive(): void {
    if (this.state === "active") return
    if (this.state === "failed") throw this.failureValue ?? new Error("GPU Island failed.")
    throw new Error("GPU Island is disposed.")
  }

  private fail(error: Error): void {
    if (this.state !== "active") return
    this.state = "failed"
    this.failureValue = error
    this.destroyResources()
    try { this.onFailure?.(error) } catch { /* reporting must not replace the device failure */ }
  }

  private destroyResources(): void {
    if (this.resourcesDestroyed) return
    this.resourcesDestroyed = true
    if (this.uncapturedErrorListener) {
      optionalMethod(this.resources.device, "removeEventListener")?.("uncapturederror", this.uncapturedErrorListener)
    }
    optionalMethod(this.resources.particleBuffer, "destroy")?.()
    optionalMethod(this.resources.parameterBuffer, "destroy")?.()
  }
}

interface LineChartGPUIslandResources {
  readonly bindGroup: unknown
  readonly computePipeline: unknown
  readonly context: UnknownRecord
  readonly device: UnknownRecord
  readonly lost: PromiseLike<unknown>
  readonly pointBuffer: UnknownRecord
  readonly parameterBuffer: UnknownRecord
  readonly queue: UnknownRecord
  readonly renderPipeline: unknown
}

/** GPU-resident chart transform + line renderer used as the second real island workload. */
export class LineChartGPUIsland {
  readonly kind = "gpu-island" as const
  readonly count: number
  readonly format: string
  readonly byteLength: number
  readonly workgroupSize = WORKGROUP_SIZE

  private readonly resources: LineChartGPUIslandResources
  private readonly clearColor: Readonly<UnknownRecord>
  private readonly label: string
  private readonly onFailure?: (error: Error) => void
  private readonly frameParameters = new Float32Array(FRAME_PARAMETER_BYTES / Float32Array.BYTES_PER_ELEMENT)
  private readonly frameParameterWords = new Uint32Array(this.frameParameters.buffer)
  private readonly amplitude: number
  private state: GPUIslandStatus = "active"
  private failureValue: Error | undefined
  private elapsedSeconds = 0
  private resourcesDestroyed = false
  private uncapturedErrorListener?: (event: unknown) => void

  constructor(
    validation: typeof VALIDATED_ISLAND,
    resources: LineChartGPUIslandResources,
    options: LineChartGPUIslandOptions,
    byteLength: number,
  ) {
    if (validation !== VALIDATED_ISLAND) throw new TypeError("GPU Islands must be created through createLineChartGPUIsland().")
    this.resources = resources
    this.count = options.count
    this.format = options.format
    this.byteLength = byteLength
    this.label = options.label ?? "Mun LineChart GPU Island"
    this.clearColor = normalizedClearColor(options.clearColor)
    this.onFailure = options.onFailure
    const amplitude = options.amplitude ?? 0.03
    if (!Number.isFinite(amplitude) || amplitude < 0) throw new RangeError("GPU LineChart amplitude must be finite and non-negative.")
    this.amplitude = amplitude
    this.uncapturedErrorListener = event => {
      const candidate = event && typeof event === "object" ? (event as UnknownRecord).error : event
      this.fail(errorFrom(candidate, "GPU LineChart uncaptured device error"))
    }
    optionalMethod(resources.device, "addEventListener")?.("uncapturederror", this.uncapturedErrorListener)
    void Promise.resolve(resources.lost).then(
      info => this.fail(deviceLostError(info)),
      cause => this.fail(errorFrom(cause, "GPU LineChart device-loss observation failed")),
    )
  }

  get status(): GPUIslandStatus { return this.state }
  get failure(): Error | undefined { return this.failureValue }

  renderFrame(deltaSeconds: number): void {
    this.assertActive()
    if (!Number.isFinite(deltaSeconds) || deltaSeconds < 0) throw new RangeError("GPU LineChart frame delta must be finite and non-negative.")
    this.elapsedSeconds += Math.min(deltaSeconds, 0.1)
    this.frameParameterWords[0] = this.count
    this.frameParameters[1] = this.elapsedSeconds
    this.frameParameters[2] = this.amplitude
    try {
      requiredMethod(this.resources.queue, "writeBuffer", "GPUDevice.queue")(this.resources.parameterBuffer, 0, this.frameParameters)
      const encoder = record(requiredMethod(this.resources.device, "createCommandEncoder", "GPU Island device")({ label: `${this.label} frame` }), "GPUCommandEncoder")
      const computePass = record(requiredMethod(encoder, "beginComputePass", "GPUCommandEncoder")({ label: `${this.label} compute` }), "GPUComputePassEncoder")
      requiredMethod(computePass, "setPipeline", "GPUComputePassEncoder")(this.resources.computePipeline)
      requiredMethod(computePass, "setBindGroup", "GPUComputePassEncoder")(0, this.resources.bindGroup)
      requiredMethod(computePass, "dispatchWorkgroups", "GPUComputePassEncoder")(Math.ceil(this.count / WORKGROUP_SIZE))
      requiredMethod(computePass, "end", "GPUComputePassEncoder")()
      const texture = record(requiredMethod(this.resources.context, "getCurrentTexture", "GPUCanvasContext")(), "GPUCanvasTexture")
      const view = requiredMethod(texture, "createView", "GPUCanvasTexture")()
      const renderPass = record(requiredMethod(encoder, "beginRenderPass", "GPUCommandEncoder")({
        label: `${this.label} render`,
        colorAttachments: [{ view, clearValue: this.clearColor, loadOp: "clear", storeOp: "store" }],
      }), "GPURenderPassEncoder")
      requiredMethod(renderPass, "setPipeline", "GPURenderPassEncoder")(this.resources.renderPipeline)
      requiredMethod(renderPass, "setVertexBuffer", "GPURenderPassEncoder")(0, this.resources.pointBuffer)
      requiredMethod(renderPass, "draw", "GPURenderPassEncoder")(this.count, 1, 0, 0)
      requiredMethod(renderPass, "end", "GPURenderPassEncoder")()
      const commands = requiredMethod(encoder, "finish", "GPUCommandEncoder")()
      requiredMethod(this.resources.queue, "submit", "GPUDevice.queue")([commands])
    } catch (cause) {
      const failure = errorFrom(cause, "GPU LineChart frame failed")
      this.fail(failure)
      throw failure
    }
  }

  dispose(): void {
    if (this.state === "disposed") return
    this.state = "disposed"
    this.destroyResources()
  }

  private assertActive(): void {
    if (this.state === "active") return
    if (this.state === "failed") throw this.failureValue ?? new Error("GPU LineChart failed.")
    throw new Error("GPU LineChart is disposed.")
  }

  private fail(error: Error): void {
    if (this.state !== "active") return
    this.state = "failed"
    this.failureValue = error
    this.destroyResources()
    try { this.onFailure?.(error) } catch { /* reporting must not replace the device failure */ }
  }

  private destroyResources(): void {
    if (this.resourcesDestroyed) return
    this.resourcesDestroyed = true
    if (this.uncapturedErrorListener) optionalMethod(this.resources.device, "removeEventListener")?.("uncapturederror", this.uncapturedErrorListener)
    optionalMethod(this.resources.pointBuffer, "destroy")?.()
    optionalMethod(this.resources.parameterBuffer, "destroy")?.()
  }
}

export async function createLineChartGPUIsland(
  deviceValue: unknown,
  contextValue: unknown,
  optionsValue: LineChartGPUIslandOptions,
): Promise<LineChartGPUIsland> {
  const count = normalizedCount(optionsValue?.count)
  if (count < 2) throw new RangeError("GPU LineChart requires at least two points.")
  const format = normalizedFormat(optionsValue?.format)
  const options = { ...optionsValue, count, format }
  validateLineChartInitialData(options.initialData, count)
  const { context, device, queue, lost } = validateDeviceAndContext(deviceValue, contextValue)
  const byteLength = validateLineChartCapacity(device, count)
  const label = options.label ?? "Mun LineChart GPU Island"
  const createBuffer = requiredMethod(device, "createBuffer", "GPU Island device")
  const pointBuffer = record(createBuffer({
    label: `${label} resident points`,
    size: byteLength,
    usage: BUFFER_USAGE.STORAGE | BUFFER_USAGE.VERTEX | BUFFER_USAGE.COPY_DST,
  }), "GPU chart point buffer")
  const parameterBuffer = record(createBuffer({
    label: `${label} frame parameters`,
    size: FRAME_PARAMETER_BYTES,
    usage: BUFFER_USAGE.UNIFORM | BUFFER_USAGE.COPY_DST,
  }), "GPU chart frame parameter buffer")
  try {
    const { computeBindGroupLayout, computePipeline, renderPipeline } = await sharedLineChartPipelines(device, format)
    const bindGroup = requiredMethod(device, "createBindGroup", "GPU Island device")({
      label: `${label} compute bind group`,
      layout: computeBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: pointBuffer, size: byteLength } },
        { binding: 1, resource: { buffer: parameterBuffer, size: FRAME_PARAMETER_BYTES } },
      ],
    })
    requiredMethod(context, "configure", "GPUCanvasContext")({ device, format, alphaMode: options.alphaMode ?? "premultiplied" })
    if (options.initialData) {
      requiredMethod(queue, "writeBuffer", "GPUDevice.queue")(pointBuffer, 0, options.initialData, options.initialData.byteOffset, options.initialData.byteLength)
    }
    return new LineChartGPUIsland(VALIDATED_ISLAND, {
      bindGroup, computePipeline, context, device, lost, pointBuffer, parameterBuffer, queue, renderPipeline,
    }, options, byteLength)
  } catch (cause) {
    optionalMethod(pointBuffer, "destroy")?.()
    optionalMethod(parameterBuffer, "destroy")?.()
    throw errorFrom(cause, "GPU LineChart creation failed")
  }
}

/**
 * Validate and create a fixed-layout ParticleField GPU Island. Custom shaders
 * are intentionally not accepted: the storage stride, shader structs, bind
 * group layout, and vertex attributes are one compiler-proven contract.
 */
export async function createParticleFieldGPUIsland(
  deviceValue: unknown,
  contextValue: unknown,
  optionsValue: ParticleFieldGPUIslandOptions,
): Promise<ParticleFieldGPUIsland> {
  const count = normalizedCount(optionsValue?.count)
  const format = normalizedFormat(optionsValue?.format)
  const options = { ...optionsValue, count, format }
  validateInitialData(options.initialData, count)
  const { context, device, queue, lost } = validateDeviceAndContext(deviceValue, contextValue)
  const byteLength = validateCapacity(device, count)
  const label = options.label ?? "Mun ParticleField GPU Island"
  const createBuffer = requiredMethod(device, "createBuffer", "GPU Island device")
  const particleBuffer = record(createBuffer({
    label: `${label} resident particles`,
    size: byteLength,
    usage: BUFFER_USAGE.STORAGE | BUFFER_USAGE.VERTEX | BUFFER_USAGE.COPY_DST,
  }), "GPU particle buffer")
  const parameterBuffer = record(createBuffer({
    label: `${label} frame parameters`,
    size: FRAME_PARAMETER_BYTES,
    usage: BUFFER_USAGE.UNIFORM | BUFFER_USAGE.COPY_DST,
  }), "GPU frame parameter buffer")

  try {
    const { computeBindGroupLayout, computePipeline, renderPipeline } = await sharedParticlePipelines(device, format)
    const bindGroup = requiredMethod(device, "createBindGroup", "GPU Island device")({
      label: `${label} compute bind group`,
      layout: computeBindGroupLayout,
      entries: [
        { binding: 0, resource: { buffer: particleBuffer, size: byteLength } },
        { binding: 1, resource: { buffer: parameterBuffer, size: FRAME_PARAMETER_BYTES } },
      ],
    })
    requiredMethod(context, "configure", "GPUCanvasContext")({
      device,
      format,
      alphaMode: options.alphaMode ?? "premultiplied",
    })
    if (options.initialData) {
      requiredMethod(queue, "writeBuffer", "GPUDevice.queue")(
        particleBuffer,
        0,
        options.initialData,
        options.initialData.byteOffset,
        options.initialData.byteLength,
      )
    }
    return new ParticleFieldGPUIsland(VALIDATED_ISLAND, {
      bindGroup,
      computePipeline,
      context,
      device,
      lost,
      particleBuffer,
      parameterBuffer,
      queue,
      renderPipeline,
    }, options, byteLength)
  } catch (cause) {
    optionalMethod(particleBuffer, "destroy")?.()
    optionalMethod(parameterBuffer, "destroy")?.()
    throw errorFrom(cause, "GPU Island creation failed")
  }
}

const mountedParticleFields = new WeakMap<HTMLCanvasElement, () => void>()
const sharedGpuDevices = new WeakMap<object, Promise<Readonly<{
  device: unknown
  format: string
}>>>()

/**
 * A Web page should normally own one logical WebGPU device, not one device per
 * GPU View. Cache the asynchronous adapter/device handshake by `navigator.gpu`
 * identity and evict it on device loss so later islands can recover through a
 * fresh adapter/device pair.
 */
async function sharedGpuDevice(gpu: UnknownRecord): Promise<Readonly<{ device: unknown; format: string }>> {
  const key = gpu as object
  let pending = sharedGpuDevices.get(key)
  if (pending) return pending
  pending = (async () => {
    const adapter = record(await requiredMethod(gpu, "requestAdapter", "GPU")(), "GPUAdapter")
    const device = await requiredMethod(adapter, "requestDevice", "GPUAdapter")()
    const preferredFormat = optionalMethod(gpu, "getPreferredCanvasFormat")?.()
    const format = typeof preferredFormat === "string" ? preferredFormat : "bgra8unorm"
    const deviceRecord = record(device, "GPUDevice")
    const lost = deviceRecord.lost
    if (lost && (typeof lost === "object" || typeof lost === "function") && typeof (lost as PromiseLike<unknown>).then === "function") {
      void Promise.resolve(lost).then(
        () => { if (sharedGpuDevices.get(key) === pending) sharedGpuDevices.delete(key) },
        () => { if (sharedGpuDevices.get(key) === pending) sharedGpuDevices.delete(key) },
      )
    }
    return Object.freeze({ device, format })
  })()
  sharedGpuDevices.set(key, pending)
  try {
    return await pending
  } catch (error) {
    if (sharedGpuDevices.get(key) === pending) sharedGpuDevices.delete(key)
    throw error
  }
}

function seededParticleData(count: number, provided: Float32Array | undefined): Float32Array {
  if (provided) return new Float32Array(provided)
  const data = new Float32Array(count * FLOATS_PER_PARTICLE)
  for (let index = 0; index < count; index += 1) {
    const offset = index * FLOATS_PER_PARTICLE
    const phase = (index * 0.61803398875) % 1
    data[offset] = phase * 2 - 1
    data[offset + 1] = ((index * 0.41421356237) % 1) * 2 - 1
    data[offset + 2] = (((index * 17) % 31) - 15) / 150
    data[offset + 3] = (((index * 23) % 29) - 14) / 150
    data[offset + 4] = 0.35 + phase * 0.65
    data[offset + 5] = 0.45 + (1 - phase) * 0.55
    data[offset + 6] = 0.9
    data[offset + 7] = 1
  }
  return data
}

function seededLineChartData(count: number, provided: Float32Array | undefined): Float32Array {
  if (provided) return new Float32Array(provided)
  const data = new Float32Array(count * FLOATS_PER_CHART_POINT)
  const denominator = Math.max(1, count - 1)
  for (let index = 0; index < count; index += 1) {
    const offset = index * FLOATS_PER_CHART_POINT
    const x = index / denominator * 2 - 1
    const y = Math.sin(index * 0.075) * 0.55 + Math.sin(index * 0.013) * 0.2
    data[offset] = x
    data[offset + 1] = y
    data[offset + 2] = x
    data[offset + 3] = y
  }
  return data
}

function runLineChartCanvasFallback(
  canvas: HTMLCanvasElement,
  node: GPUIslandViewNode,
  data: Float32Array,
): () => void {
  canvas.dataset.munGpuBackend = node.ir.fallback === "canvas" ? "cpu-canvas" : "static"
  let context: CanvasRenderingContext2D | null = null
  try { context = canvas.getContext("2d") } catch { /* synthetic DOM or an existing WebGPU context may reject 2D */ }
  if (!context) return () => undefined
  const owner = canvas.ownerDocument.defaultView
  let frame = 0
  let elapsed = 0
  const draw = (step: boolean) => {
    if (step) elapsed += 1 / 60
    context!.clearRect(0, 0, canvas.width, canvas.height)
    context!.beginPath()
    for (let index = 0; index < node.ir.render.vertexCount; index += 1) {
      const offset = index * FLOATS_PER_CHART_POINT
      const x = data[offset]!
      const y = Math.max(-1, Math.min(1, data[offset + 1]! + Math.sin(elapsed + x * Math.PI * 2) * 0.03))
      data[offset + 2] = x
      data[offset + 3] = y
      const px = (x + 1) * canvas.width / 2
      const py = (1 - y) * canvas.height / 2
      if (index === 0) context!.moveTo(px, py)
      else context!.lineTo(px, py)
    }
    context!.stroke()
  }
  draw(false)
  if (node.ir.fallback !== "canvas" || typeof owner?.requestAnimationFrame !== "function") return () => undefined
  let stopped = false
  const tick = () => {
    if (stopped) return
    draw(true)
    frame = owner.requestAnimationFrame(tick)
  }
  frame = owner.requestAnimationFrame(tick)
  return () => {
    stopped = true
    if (frame) owner.cancelAnimationFrame(frame)
  }
}

function runCanvasFallback(
  canvas: HTMLCanvasElement,
  node: GPUIslandViewNode,
  data: Float32Array,
): () => void {
  if (node.ir.kind === "line-chart") return runLineChartCanvasFallback(canvas, node, data)
  canvas.dataset.munGpuBackend = node.ir.fallback === "canvas" ? "cpu-canvas" : "static"
  let context: CanvasRenderingContext2D | null = null
  try { context = canvas.getContext("2d") } catch { /* synthetic DOM or a prior WebGPU context may reject 2D */ }
  if (!context) return () => undefined
  let frame = 0
  const owner = canvas.ownerDocument.defaultView
  const draw = (step: boolean) => {
    if (step) {
      for (let index = 0; index < node.ir.render.vertexCount; index += 1) {
        const offset = index * FLOATS_PER_PARTICLE
        let x = data[offset]! + data[offset + 2]!
        let y = data[offset + 1]! + data[offset + 3]!
        if (Math.abs(x) > 1) { data[offset + 2] = -data[offset + 2]!; x = Math.max(-1, Math.min(1, x)) }
        if (Math.abs(y) > 1) { data[offset + 3] = -data[offset + 3]!; y = Math.max(-1, Math.min(1, y)) }
        data[offset] = x
        data[offset + 1] = y
      }
    }
    context!.clearRect(0, 0, canvas.width, canvas.height)
    const radius = Math.max(1, Math.min(canvas.width, canvas.height) / 256)
    for (let index = 0; index < node.ir.render.vertexCount; index += 1) {
      const offset = index * FLOATS_PER_PARTICLE
      context!.fillStyle = `rgba(${Math.round(data[offset + 4]! * 255)}, ${Math.round(data[offset + 5]! * 255)}, ${Math.round(data[offset + 6]! * 255)}, ${data[offset + 7]!})`
      context!.beginPath()
      context!.arc((data[offset]! + 1) * canvas.width / 2, (1 - data[offset + 1]!) * canvas.height / 2, radius, 0, Math.PI * 2)
      context!.fill()
    }
  }
  draw(false)
  if (node.ir.fallback !== "canvas" || typeof owner?.requestAnimationFrame !== "function") return () => undefined
  let stopped = false
  const tick = () => {
    if (stopped) return
    draw(true)
    frame = owner.requestAnimationFrame(tick)
  }
  frame = owner.requestAnimationFrame(tick)
  return () => {
    stopped = true
    if (frame) owner.cancelAnimationFrame(frame)
  }
}

/**
 * Activate a graph GPU Island on a renderer-owned canvas. The returned cleanup
 * owns every requestAnimationFrame and GPU resource created for this canvas.
 */
export function mountParticleFieldGPUIslandCanvas(
  canvas: HTMLCanvasElement,
  node: GPUIslandViewNode,
  options: Readonly<{ experimentalResidentCompute?: boolean }> = {},
): () => void {
  mountedParticleFields.get(canvas)?.()
  const data = node.ir.kind === "line-chart"
    ? seededLineChartData(node.ir.render.vertexCount, node.options.initialData)
    : seededParticleData(node.ir.render.vertexCount, node.options.initialData)
  const owner = canvas.ownerDocument.defaultView
  if (options.experimentalResidentCompute !== true) {
    canvas.dataset.munGpuBackend = "disabled"
    const cleanup = runCanvasFallback(canvas, node, data)
    const dispose = () => { cleanup(); mountedParticleFields.delete(canvas) }
    mountedParticleFields.set(canvas, dispose)
    return dispose
  }
  let stopped = false
  let frame = 0
  let island: ParticleFieldGPUIsland | LineChartGPUIsland | undefined
  let fallbackCleanup: (() => void) | undefined
  const stopFrame = () => {
    if (frame && owner && typeof owner.cancelAnimationFrame === "function") owner.cancelAnimationFrame(frame)
    frame = 0
  }
  const fallback = (reason: unknown) => {
    if (stopped || fallbackCleanup) return
    stopFrame()
    island?.dispose()
    island = undefined
    canvas.dataset.munGpuFailure = reason instanceof Error ? reason.message : String(reason)
    fallbackCleanup = runCanvasFallback(canvas, node, data)
  }
  const activate = async () => {
    const navigatorValue = owner?.navigator as Navigator & { gpu?: UnknownRecord } | undefined
    const gpu = navigatorValue?.gpu
    if (!gpu) return fallback(new Error("WebGPU is unavailable"))
    try {
      const shared = await sharedGpuDevice(gpu)
      const device = shared.device
      const context = canvas.getContext("webgpu" as never)
      if (!context) throw new Error("GPUCanvasContext is unavailable")
      const format = shared.format
      if (stopped) return
      island = node.ir.kind === "line-chart"
        ? await createLineChartGPUIsland(device, context, {
          count: node.ir.render.vertexCount,
          format,
          initialData: data,
          clearColor: node.options.clearColor,
          label: `Mun GPU LineChart ${node.ir.id}`,
          onFailure: error => fallback(error),
        })
        : await createParticleFieldGPUIsland(device, context, {
          count: node.ir.render.vertexCount,
          format,
          initialData: data,
          clearColor: node.options.clearColor,
          label: `Mun GPU Island ${node.ir.id}`,
          onFailure: error => fallback(error),
        })
      if (stopped) { island.dispose(); island = undefined; return }
      canvas.dataset.munGpuBackend = "webgpu"
      let previous: number | undefined
      const render = (timestamp: number) => {
        if (stopped || island?.status !== "active") return
        const delta = previous === undefined ? 1 / 60 : Math.max(0, (timestamp - previous) / 1000)
        previous = timestamp
        try { island.renderFrame(delta) } catch (error) { fallback(error); return }
        if (owner && typeof owner.requestAnimationFrame === "function") frame = owner.requestAnimationFrame(render)
      }
      if (owner && typeof owner.requestAnimationFrame === "function") frame = owner.requestAnimationFrame(render)
      else island.renderFrame(1 / 60)
    } catch (error) {
      fallback(error)
    }
  }
  queueMicrotask(() => { if (!stopped) void activate() })
  const dispose = () => {
    if (stopped) return
    stopped = true
    stopFrame()
    fallbackCleanup?.()
    island?.dispose()
    mountedParticleFields.delete(canvas)
  }
  mountedParticleFields.set(canvas, dispose)
  return dispose
}

export function disposeParticleFieldGPUIslandCanvas(canvas: HTMLCanvasElement): void {
  mountedParticleFields.get(canvas)?.()
}
import type { GPUIslandViewNode } from "@mun/core/internal/runtime"

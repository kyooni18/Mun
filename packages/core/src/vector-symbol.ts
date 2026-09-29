const vectorSymbolBrand = Symbol.for("mun.vector-symbol")

export interface VectorSymbolLayer {
  readonly id?: string
  readonly d: string
  readonly fill?: string
  readonly stroke?: string
  readonly strokeWidth?: number | string
  readonly strokeLinecap?: string
  readonly strokeLinejoin?: string
  readonly fillRule?: string
  readonly clipRule?: string
  readonly transform?: string
  readonly vectorEffect?: string
  readonly opacity?: number
}

export type SVGIconAttributeValue = string | number | boolean | undefined
export type SVGIconNode = readonly [
  tagName: string,
  attributes: Readonly<Record<string, SVGIconAttributeValue>>,
  children?: readonly SVGIconNode[],
]

export interface SVGIconOptions {
  readonly name?: string
  readonly viewBox?: string
  readonly width?: number
  readonly height?: number
  readonly fill?: string
  readonly stroke?: string
  readonly strokeWidth?: number | string
  readonly strokeLinecap?: string
  readonly strokeLinejoin?: string
}

/** Structural subset of the official @lucide/icons data format. */
export interface LucideIconDataLike {
  readonly name: string
  readonly node: readonly SVGIconNode[]
  readonly size?: number
  readonly width?: number
  readonly height?: number
}

export interface VectorSymbolOptions {
  readonly name?: string
  readonly viewBox: string
  readonly layers: readonly VectorSymbolLayer[]
}

export interface VectorSymbolDescriptor {
  readonly name?: string
  readonly viewBox: string
  readonly layers: readonly Readonly<Required<Pick<VectorSymbolLayer, "id" | "d">> & Omit<VectorSymbolLayer, "id" | "d">>[]
}

function finiteOpacity(value: number | undefined): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : undefined
}

function finiteNumber(value: SVGIconAttributeValue, fallback = 0): number {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : fallback
}

function attribute(attributes: Readonly<Record<string, SVGIconAttributeValue>>, ...names: string[]): SVGIconAttributeValue {
  for (const name of names) if (attributes[name] !== undefined) return attributes[name]
  return undefined
}

function pointsPath(raw: SVGIconAttributeValue, close: boolean): string | undefined {
  if (typeof raw !== "string") return undefined
  const values = raw.trim().split(/[\s,]+/).map(Number).filter(Number.isFinite)
  if (values.length < 4 || values.length % 2 !== 0) return undefined
  let d = `M${values[0]} ${values[1]}`
  for (let index = 2; index < values.length; index += 2) d += ` L${values[index]} ${values[index + 1]}`
  return close ? `${d} Z` : d
}

function geometryPath(tagName: string, attributes: Readonly<Record<string, SVGIconAttributeValue>>): string | undefined {
  switch (tagName.toLowerCase()) {
    case "path": {
      const d = attribute(attributes, "d")
      return typeof d === "string" && d.trim() ? d : undefined
    }
    case "line":
      return `M${finiteNumber(attribute(attributes, "x1"))} ${finiteNumber(attribute(attributes, "y1"))} L${finiteNumber(attribute(attributes, "x2"))} ${finiteNumber(attribute(attributes, "y2"))}`
    case "polyline": return pointsPath(attribute(attributes, "points"), false)
    case "polygon": return pointsPath(attribute(attributes, "points"), true)
    case "circle": {
      const cx = finiteNumber(attribute(attributes, "cx"))
      const cy = finiteNumber(attribute(attributes, "cy"))
      const r = Math.max(0, finiteNumber(attribute(attributes, "r")))
      return r > 0 ? `M${cx + r} ${cy} A${r} ${r} 0 1 0 ${cx - r} ${cy} A${r} ${r} 0 1 0 ${cx + r} ${cy} Z` : undefined
    }
    case "ellipse": {
      const cx = finiteNumber(attribute(attributes, "cx"))
      const cy = finiteNumber(attribute(attributes, "cy"))
      const rx = Math.max(0, finiteNumber(attribute(attributes, "rx")))
      const ry = Math.max(0, finiteNumber(attribute(attributes, "ry")))
      return rx > 0 && ry > 0 ? `M${cx + rx} ${cy} A${rx} ${ry} 0 1 0 ${cx - rx} ${cy} A${rx} ${ry} 0 1 0 ${cx + rx} ${cy} Z` : undefined
    }
    case "rect": {
      const x = finiteNumber(attribute(attributes, "x"))
      const y = finiteNumber(attribute(attributes, "y"))
      const width = Math.max(0, finiteNumber(attribute(attributes, "width")))
      const height = Math.max(0, finiteNumber(attribute(attributes, "height")))
      if (width <= 0 || height <= 0) return undefined
      const rx = Math.min(width / 2, Math.max(0, finiteNumber(attribute(attributes, "rx"))))
      const ryValue = attribute(attributes, "ry")
      const ry = Math.min(height / 2, Math.max(0, ryValue === undefined ? rx : finiteNumber(ryValue)))
      if (rx <= 0 && ry <= 0) return `M${x} ${y} H${x + width} V${y + height} H${x} Z`
      return `M${x + rx} ${y} H${x + width - rx} A${rx} ${ry} 0 0 1 ${x + width} ${y + ry} V${y + height - ry} A${rx} ${ry} 0 0 1 ${x + width - rx} ${y + height} H${x + rx} A${rx} ${ry} 0 0 1 ${x} ${y + height - ry} V${y + ry} A${rx} ${ry} 0 0 1 ${x + rx} ${y} Z`
    }
    default: return undefined
  }
}

function stringAttribute(attributes: Readonly<Record<string, SVGIconAttributeValue>>, ...names: string[]): string | undefined {
  const value = attribute(attributes, ...names)
  return typeof value === "string" || typeof value === "number" ? String(value) : undefined
}

interface FlattenedIconNode {
  readonly tagName: string
  readonly attributes: Readonly<Record<string, SVGIconAttributeValue>>
}

function flattenIconNodes(
  nodes: readonly SVGIconNode[],
  inherited: Readonly<Record<string, SVGIconAttributeValue>> = {},
  result: FlattenedIconNode[] = [],
): FlattenedIconNode[] {
  for (const node of nodes) {
    if (!Array.isArray(node) || typeof node[0] !== "string" || !node[1] || typeof node[1] !== "object") continue
    const [tagName, own, children] = node
    const inheritedTransform = stringAttribute(inherited, "transform")
    const ownTransform = stringAttribute(own, "transform")
    const merged = {
      ...inherited,
      ...own,
      ...((inheritedTransform || ownTransform)
        ? { transform: [inheritedTransform, ownTransform].filter(Boolean).join(" ") }
        : {}),
    }
    if (tagName === "g" || tagName === "svg") {
      if (children) flattenIconNodes(children, merged, result)
      continue
    }
    result.push({ tagName, attributes: merged })
    if (children) flattenIconNodes(children, merged, result)
  }
  return result
}

function layersFromIconNodes(nodes: readonly SVGIconNode[], defaults: SVGIconOptions): VectorSymbolLayer[] {
  const result: VectorSymbolLayer[] = []
  for (const { tagName, attributes } of flattenIconNodes(nodes)) {
    const d = geometryPath(tagName, attributes)
    if (!d) continue
    const index = result.length
    // Many standard icon packs carry stable source-level node keys even when
    // they do not expose human-readable semantic layer names. Lucide in
    // particular reuses these keys across related symbols, so preserving them
    // lets Magic Replace keep genuinely common geometry alive instead of
    // degrading every imported icon to ordinal layer identity.
    const explicitId = stringAttribute(attributes, "data-mun-symbol-layer", "id", "key")
    const rawOpacity = attribute(attributes, "opacity")
    const parsedOpacity = rawOpacity === undefined ? undefined : finiteOpacity(finiteNumber(rawOpacity, 1))
    result.push({
      id: explicitId?.trim() || `layer:${index}`,
      d,
      fill: stringAttribute(attributes, "fill") ?? defaults.fill,
      stroke: stringAttribute(attributes, "stroke") ?? defaults.stroke,
      strokeWidth: stringAttribute(attributes, "stroke-width", "strokeWidth") ?? defaults.strokeWidth,
      strokeLinecap: stringAttribute(attributes, "stroke-linecap", "strokeLinecap") ?? defaults.strokeLinecap,
      strokeLinejoin: stringAttribute(attributes, "stroke-linejoin", "strokeLinejoin") ?? defaults.strokeLinejoin,
      fillRule: stringAttribute(attributes, "fill-rule", "fillRule"),
      clipRule: stringAttribute(attributes, "clip-rule", "clipRule"),
      transform: stringAttribute(attributes, "transform"),
      vectorEffect: stringAttribute(attributes, "vector-effect", "vectorEffect"),
      ...(parsedOpacity !== undefined ? { opacity: parsedOpacity } : {}),
    })
  }
  return result
}

/** Immutable multi-path vector value used by Image(symbol). */
export class VectorSymbol {
  readonly descriptor: VectorSymbolDescriptor
  readonly [vectorSymbolBrand] = true

  constructor(options: VectorSymbolOptions) {
    if (!options || typeof options !== "object" || typeof options.viewBox !== "string" || !options.viewBox.trim()) {
      throw new TypeError("VectorSymbol requires a non-empty viewBox.")
    }
    if (!Array.isArray(options.layers) || options.layers.length === 0) {
      throw new TypeError("VectorSymbol requires at least one path layer.")
    }
    const ids = new Set<string>()
    const layers = options.layers.map((layer, index) => {
      if (!layer || typeof layer !== "object" || typeof layer.d !== "string" || !layer.d.trim()) {
        throw new TypeError(`VectorSymbol layer ${index} requires a non-empty SVG path.`)
      }
      const id = typeof layer.id === "string" && layer.id.trim() ? layer.id : `layer:${index}`
      if (ids.has(id)) throw new TypeError(`VectorSymbol layer id must be unique: ${id}`)
      ids.add(id)
      const opacity = finiteOpacity(layer.opacity)
      return Object.freeze({
        id,
        d: layer.d,
        ...(typeof layer.fill === "string" ? { fill: layer.fill } : {}),
        ...(typeof layer.stroke === "string" ? { stroke: layer.stroke } : {}),
        ...(typeof layer.strokeWidth === "string" || (typeof layer.strokeWidth === "number" && Number.isFinite(layer.strokeWidth))
          ? { strokeWidth: layer.strokeWidth }
          : {}),
        ...(typeof layer.strokeLinecap === "string" ? { strokeLinecap: layer.strokeLinecap } : {}),
        ...(typeof layer.strokeLinejoin === "string" ? { strokeLinejoin: layer.strokeLinejoin } : {}),
        ...(typeof layer.fillRule === "string" ? { fillRule: layer.fillRule } : {}),
        ...(typeof layer.clipRule === "string" ? { clipRule: layer.clipRule } : {}),
        ...(typeof layer.transform === "string" ? { transform: layer.transform } : {}),
        ...(typeof layer.vectorEffect === "string" ? { vectorEffect: layer.vectorEffect } : {}),
        ...(opacity !== undefined ? { opacity } : {}),
      })
    })
    this.descriptor = Object.freeze({
      ...(typeof options.name === "string" && options.name.trim() ? { name: options.name } : {}),
      viewBox: options.viewBox,
      layers: Object.freeze(layers),
    })
    Object.freeze(this)
  }

  /** Convert ordinary SVG geometry nodes into a morphable Mün symbol. */
  static fromSVGNodes(nodes: readonly SVGIconNode[], options: SVGIconOptions = {}): VectorSymbol {
    const width = typeof options.width === "number" && Number.isFinite(options.width) && options.width > 0 ? options.width : 24
    const height = typeof options.height === "number" && Number.isFinite(options.height) && options.height > 0 ? options.height : width
    return new VectorSymbol({
      ...(options.name ? { name: options.name } : {}),
      viewBox: options.viewBox?.trim() || `0 0 ${width} ${height}`,
      layers: layersFromIconNodes(nodes, options),
    })
  }

  /**
   * Adapt official `@lucide/icons` data without depending on Lucide at runtime.
   * Geometry primitives are normalized to paths so unrelated Lucide icons can
   * use the same path-morph engine as custom Mün symbols.
   */
  static fromLucide(icon: LucideIconDataLike, options: Omit<SVGIconOptions, "name" | "width" | "height"> = {}): VectorSymbol {
    if (!icon || typeof icon !== "object" || typeof icon.name !== "string" || !Array.isArray(icon.node)) {
      throw new TypeError("VectorSymbol.fromLucide requires @lucide/icons-compatible icon data.")
    }
    const width = Number.isFinite(icon.width) && (icon.width ?? 0) > 0 ? icon.width! : Number.isFinite(icon.size) && (icon.size ?? 0) > 0 ? icon.size! : 24
    const height = Number.isFinite(icon.height) && (icon.height ?? 0) > 0 ? icon.height! : Number.isFinite(icon.size) && (icon.size ?? 0) > 0 ? icon.size! : 24
    return VectorSymbol.fromSVGNodes(icon.node, {
      ...options,
      name: icon.name,
      width,
      height,
      viewBox: options.viewBox ?? `0 0 ${width} ${height}`,
      fill: options.fill ?? "none",
      stroke: options.stroke ?? "currentColor",
      strokeWidth: options.strokeWidth ?? 2,
      strokeLinecap: options.strokeLinecap ?? "round",
      strokeLinejoin: options.strokeLinejoin ?? "round",
    })
  }
}

export function isVectorSymbol(value: unknown): value is VectorSymbol {
  return Boolean(value && typeof value === "object" && (value as VectorSymbol)[vectorSymbolBrand] === true)
}

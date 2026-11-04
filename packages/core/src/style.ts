export type UnitPoint =
  | "center"
  | "leading"
  | "trailing"
  | "top"
  | "bottom"
  | "topLeading"
  | "topTrailing"
  | "bottomLeading"
  | "bottomTrailing"

export class Color {
  // Fixed sRGB values, matching the native color palette.
  static readonly black = new Color("#000000")
  static readonly blue = new Color("#007AFF")
  static readonly brown = new Color("#A2845E")
  static readonly clear = new Color("#00000000")
  static readonly cyan = new Color("#32ADE6")
  static readonly gray = new Color("#8E8E93")
  static readonly green = new Color("#34C759")
  static readonly indigo = new Color("#5856D6")
  static readonly mint = new Color("#00C7BE")
  static readonly orange = new Color("#FF9500")
  static readonly pink = new Color("#FF2D55")
  static readonly primary = new Color("#F0F0F7")
  static readonly purple = new Color("#AF52DE")
  static readonly red = new Color("#FF3B30")
  static readonly secondary = new Color("#F0F0F799")
  static readonly teal = new Color("#30B0C7")
  static readonly white = new Color("#FFFFFF")
  static readonly yellow = new Color("#FFCC00")
  readonly kind = "solid" as const
  readonly value: string

  constructor(value: string) {
    if (typeof value !== "string" || value.length === 0) {
      throw new TypeError("Color requires a non-empty color string")
    }
    this.value = value
    Object.freeze(this)
  }

  toString(): string {
    return this.value
  }
}

export class LinearGradient {
  readonly kind = "linearGradient" as const
  readonly start: Color
  readonly end: Color
  readonly startPoint: UnitPoint
  readonly endPoint: UnitPoint

  constructor(
    start: Color | string,
    end: Color | string,
    startPoint: UnitPoint = "leading",
    endPoint: UnitPoint = "trailing",
  ) {
    this.start = start instanceof Color ? start : new Color(start)
    this.end = end instanceof Color ? end : new Color(end)
    this.startPoint = startPoint
    this.endPoint = endPoint
    Object.freeze(this)
  }

  toString(): string {
    return `linear-gradient(${gradientDirection(this.startPoint, this.endPoint)}, ${this.start}, ${this.end})`
  }
}

export type ShapeStyle = string | Color | LinearGradient

export function shapeStyleCss(value: ShapeStyle): string {
  return typeof value === "string" ? value : value.toString()
}

function gradientDirection(start: UnitPoint, end: UnitPoint): string {
  switch (`${start}:${end}`) {
    case "leading:trailing": return "to right"
    case "trailing:leading": return "to left"
    case "top:bottom": return "to bottom"
    case "bottom:top": return "to top"
    case "topLeading:bottomTrailing": return "to bottom right"
    case "topTrailing:bottomLeading": return "to bottom left"
    case "bottomLeading:topTrailing": return "to top right"
    case "bottomTrailing:topLeading": return "to top left"
    default: return "to right"
  }
}

/** Semantic typography shared by all renderers; values are CSS font shorthands. */
export class Font {
  private constructor(readonly css: string) { Object.freeze(this) }
  toString(): string { return this.css }
  static readonly largeTitle = new Font("400 34px/41px system-ui")
  static readonly title = new Font("400 28px/34px system-ui")
  static readonly title2 = new Font("400 22px/28px system-ui")
  static readonly title3 = new Font("400 20px/25px system-ui")
  static readonly headline = new Font("600 17px/22px system-ui")
  static readonly subheadline = new Font("400 15px/20px system-ui")
  static readonly body = new Font("400 17px/22px system-ui")
  static readonly callout = new Font("400 16px/21px system-ui")
  static readonly footnote = new Font("400 13px/18px system-ui")
  static readonly caption = new Font("400 12px/16px system-ui")
  static readonly caption2 = new Font("400 11px/13px system-ui")
}

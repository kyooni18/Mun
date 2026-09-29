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

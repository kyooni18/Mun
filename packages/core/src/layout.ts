import type { Length } from "./graph/types.js"

export type FrameAlignment = "center" | "leading" | "trailing" | "top" | "bottom" | "topLeading" | "topTrailing" | "bottomLeading" | "bottomTrailing"
export type Edge = "top" | "leading" | "bottom" | "trailing"
export type EdgeSet = Edge | "horizontal" | "vertical" | "all" | readonly Edge[]

export interface LayoutEdgeInsets {
  readonly top?: Length
  readonly leading?: Length
  readonly bottom?: Length
  readonly trailing?: Length
  /** Browser-oriented aliases accepted by the runtime compatibility surface. */
  readonly left?: Length
  readonly right?: Length
}

export interface FrameOptions {
  readonly width?: Length
  readonly height?: Length
  readonly minWidth?: Length
  /** Web approximation of SwiftUI's preferred width. Used as `width` when no explicit width is supplied. */
  readonly idealWidth?: Length
  readonly maxWidth?: Length | "infinity"
  readonly minHeight?: Length
  /** Web approximation of SwiftUI's preferred height. Used as `height` when no explicit height is supplied. */
  readonly idealHeight?: Length
  readonly maxHeight?: Length | "infinity"
  readonly alignment?: FrameAlignment
}

function framePlaceItems(alignment: FrameAlignment = "center"): string {
  switch (alignment) {
    case "leading": return "center start"
    case "trailing": return "center end"
    case "top": return "start center"
    case "bottom": return "end center"
    case "topLeading": return "start start"
    case "topTrailing": return "start end"
    case "bottomLeading": return "end start"
    case "bottomTrailing": return "end end"
    default: return "center"
  }
}

function ownFrameValue(options: FrameOptions, key: keyof FrameOptions): unknown {
  try {
    const descriptor = Object.getOwnPropertyDescriptor(options, key)
    return descriptor && "value" in descriptor ? descriptor.value : undefined
  } catch {
    return undefined
  }
}

export function layoutLength(value: unknown): string | undefined {
  return typeof value === "number" ? Number.isFinite(value) ? `${value}px` : undefined : typeof value === "string" ? value : undefined
}


export function frameStyle(options: FrameOptions): Record<string, string | undefined> {
  const width = ownFrameValue(options, "width")
  const height = ownFrameValue(options, "height")
  const minWidth = ownFrameValue(options, "minWidth")
  const idealWidth = ownFrameValue(options, "idealWidth")
  const maxWidth = ownFrameValue(options, "maxWidth")
  const minHeight = ownFrameValue(options, "minHeight")
  const idealHeight = ownFrameValue(options, "idealHeight")
  const maxHeight = ownFrameValue(options, "maxHeight")
  const alignment = ownFrameValue(options, "alignment")
  return {
    boxSizing: "border-box",
    display: "grid",
    placeItems: framePlaceItems(typeof alignment === "string" ? alignment as FrameAlignment : undefined),
    // A flexible frame accepts the parent's proposal; a CSS max-width alone
    // only caps the box and never asks it to expand. Explicit sizes still win.
    width: width === undefined && maxWidth === "infinity" ? "100%" : layoutLength(width === undefined ? idealWidth : width),
    height: height === undefined && maxHeight === "infinity" ? "100%" : layoutLength(height === undefined ? idealHeight : height),
    minWidth: layoutLength(minWidth),
    maxWidth: maxWidth === "infinity" ? "100%" : layoutLength(maxWidth),
    minHeight: layoutLength(minHeight),
    maxHeight: maxHeight === "infinity" ? "100%" : layoutLength(maxHeight),
  }
}

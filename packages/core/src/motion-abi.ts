// SPDX-License-Identifier: MIT

/**
 * Compact compiler/runtime ABI for the common CSS properties Mun animates.
 *
 * Bare `.animation()` lowering stores these properties as one unsigned 32-bit
 * mask instead of carrying string arrays through every render. Unknown/custom
 * properties intentionally remain on the string fallback path. Keep the order
 * stable because generated output can live in incremental compiler caches.
 */
export const motionPropertyNames = Object.freeze([
  "opacity", "transform", "translate", "scale", "rotate",
  "color", "background", "background-color", "border-color",
  "width", "height", "min-width", "min-height", "max-width", "max-height",
  "padding", "padding-top", "padding-right", "padding-bottom", "padding-left",
  "margin", "margin-top", "margin-right", "margin-bottom", "margin-left",
  "gap", "row-gap", "column-gap", "font", "font-size", "line-height", "letter-spacing",
] as const)

const motionPropertyBits = new Map<string, number>(motionPropertyNames.map((name, index) => [name, (2 ** index) >>> 0]))

export function motionPropertyBit(name: string): number {
  return motionPropertyBits.get(name) ?? 0
}

export function motionPropertyMask(properties: Iterable<string>): number {
  let mask = 0
  for (const property of properties) mask = (mask | motionPropertyBit(property)) >>> 0
  return mask
}

export const compositorMotionPropertyMask = motionPropertyMask(["opacity", "transform", "translate", "scale", "rotate"])
export const paintMotionPropertyMask = motionPropertyMask(["color", "background", "background-color", "border-color"])
export const layoutMotionPropertyMask = motionPropertyMask([
  "width", "height", "min-width", "min-height", "max-width", "max-height",
  "padding", "padding-top", "padding-right", "padding-bottom", "padding-left",
  "margin", "margin-top", "margin-right", "margin-bottom", "margin-left",
  "gap", "row-gap", "column-gap", "font", "font-size", "line-height", "letter-spacing",
])

import { defineBuiltinView, initializer, initializerKinds, type ModifiableViewNode, type TypedViewConstructor } from "./graph.js"
import { Image } from "./controls.js"
import { requireOptionRecord } from "./options.js"
import { resolveValue, type Value } from "./state.js"
import { VectorSymbol, isVectorSymbol, type LucideIconDataLike, type SVGIconNode, type SVGIconOptions } from "./vector-symbol.js"

/** Web image URL, normalized symbol, SVG geometry, or official Lucide icon data. */
export type IconSource = string | VectorSymbol | LucideIconDataLike | readonly SVGIconNode[]
export interface IconOptions extends SVGIconOptions { readonly alt?: string }
export interface IconProps { readonly source: IconSource; readonly options: IconOptions }
interface IconCall { (source: Value<IconSource>, options?: IconOptions): ModifiableViewNode }

/** Raw SVG geometry is authored on a 24-unit grid as outline strokes, matching common icon sets. */
const svgNodeDefaults: SVGIconOptions = { viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 2, strokeLinecap: "round", strokeLinejoin: "round" }

/** A renderer-independent View: ordinary View modifiers apply just as on Image. */
export const Icon = defineBuiltinView<IconProps>(
  "Icon",
  [initializer(
    "Icon(source, options?)",
    args => args.length >= 1 && args.length <= 2 && (args[1] === undefined || (args[1] !== null && typeof args[1] === "object" && !Array.isArray(args[1]))),
    args => {
      const source = resolveValue(args[0] as Value<IconSource>)
      if (typeof source !== "string" && !isVectorSymbol(source) && !Array.isArray(source) && !(source && typeof source === "object" && "node" in source)) {
        throw new TypeError("Icon requires an image URL, VectorSymbol, SVG nodes, or Lucide icon data.")
      }
      const options = args[1] === undefined ? {} : requireOptionRecord(args[1], ["alt", "name", "viewBox", "width", "height", "fill", "stroke", "strokeWidth", "strokeLinecap", "strokeLinejoin"], "Icon")
      return { source, options: options as IconOptions }
    },
    [initializerKinds.value(true, "source"), initializerKinds.value(false, "options")],
  )],
  ({ source, options }) => {
    const symbol = typeof source === "string" || isVectorSymbol(source) ? source
      : Array.isArray(source) ? VectorSymbol.fromSVGNodes(source as readonly SVGIconNode[], { ...svgNodeDefaults, ...options })
      : VectorSymbol.fromLucide(source as LucideIconDataLike, options)
    return typeof symbol === "string" ? Image(symbol, { alt: options.alt ?? "" }) : Image(symbol, { alt: options.alt ?? "" })
  },
) as TypedViewConstructor<IconProps, IconCall>

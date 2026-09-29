export type MunHtmlTagName =
  | "a" | "abbr" | "address" | "area" | "article" | "aside" | "audio"
  | "b" | "base" | "bdi" | "bdo" | "blockquote" | "body" | "br" | "button"
  | "canvas" | "caption" | "cite" | "code" | "col" | "colgroup"
  | "data" | "datalist" | "dd" | "del" | "details" | "dfn" | "dialog" | "div" | "dl" | "dt"
  | "em" | "embed" | "fieldset" | "figcaption" | "figure" | "footer" | "form"
  | "h1" | "h2" | "h3" | "h4" | "h5" | "h6" | "head" | "header" | "hgroup" | "hr" | "html"
  | "i" | "iframe" | "img" | "input" | "ins" | "kbd" | "label" | "legend" | "li" | "link"
  | "main" | "map" | "mark" | "menu" | "meta" | "meter" | "nav" | "noscript" | "object" | "ol" | "optgroup" | "option" | "output"
  | "p" | "picture" | "pre" | "progress" | "q" | "rp" | "rt" | "ruby" | "s" | "samp" | "script" | "search" | "section" | "select" | "slot" | "small" | "source" | "span" | "strong" | "style" | "sub" | "summary" | "sup"
  | "table" | "tbody" | "td" | "template" | "textarea" | "tfoot" | "th" | "thead" | "time" | "title" | "tr" | "track" | "u" | "ul" | "var" | "video" | "wbr"

export interface MunEventTarget<Tag extends string = string> {
  readonly tagName?: Uppercase<Tag>
  readonly value?: string
  readonly checked?: boolean
  readonly files?: unknown
  readonly key?: string
  readonly code?: string
  readonly clientX?: number
  readonly clientY?: number
  readonly button?: number
}

export interface MunDOMEvent<Tag extends string = string> {
  readonly target?: MunEventTarget<Tag>
  readonly currentTarget?: MunEventTarget<Tag>
  readonly defaultPrevented?: boolean
  preventDefault?(): void
  stopPropagation?(): void
}

export type MunEventHandler<Tag extends string = string> = (event: MunDOMEvent<Tag>) => unknown

/** CSS values accepted by the renderer-neutral inline style modifier. */
type MunStylePropertyValue = string | number | undefined

/**
 * Renderer-neutral CSS properties.
 *
 * Named properties catch misspellings while the template-literal index
 * signature keeps CSS custom properties (`--app-accent`) extensible. External
 * stylesheets and CSS processors remain ordinary host build-tool inputs.
 */
export interface MunStyleProperties {
  readonly [property: `--${string}`]: MunStylePropertyValue
  readonly accentColor?: MunStylePropertyValue
  readonly alignContent?: MunStylePropertyValue
  readonly alignItems?: MunStylePropertyValue
  readonly alignSelf?: MunStylePropertyValue
  readonly appearance?: MunStylePropertyValue
  readonly aspectRatio?: MunStylePropertyValue
  readonly background?: MunStylePropertyValue
  readonly backgroundColor?: MunStylePropertyValue
  readonly backgroundImage?: MunStylePropertyValue
  readonly backgroundPosition?: MunStylePropertyValue
  readonly backgroundRepeat?: MunStylePropertyValue
  readonly backgroundSize?: MunStylePropertyValue
  readonly blockSize?: MunStylePropertyValue
  readonly border?: MunStylePropertyValue
  readonly borderBottom?: MunStylePropertyValue
  readonly borderColor?: MunStylePropertyValue
  readonly borderLeft?: MunStylePropertyValue
  readonly borderRadius?: MunStylePropertyValue
  readonly cornerShape?: MunStylePropertyValue
  readonly borderRight?: MunStylePropertyValue
  readonly borderStyle?: MunStylePropertyValue
  readonly borderTop?: MunStylePropertyValue
  readonly borderWidth?: MunStylePropertyValue
  readonly bottom?: MunStylePropertyValue
  readonly boxShadow?: MunStylePropertyValue
  readonly boxSizing?: MunStylePropertyValue
  readonly color?: MunStylePropertyValue
  readonly columnGap?: MunStylePropertyValue
  readonly columns?: MunStylePropertyValue
  readonly content?: MunStylePropertyValue
  readonly cursor?: MunStylePropertyValue
  readonly display?: MunStylePropertyValue
  readonly flex?: MunStylePropertyValue
  readonly flexBasis?: MunStylePropertyValue
  readonly flexDirection?: MunStylePropertyValue
  readonly flexGrow?: MunStylePropertyValue
  readonly flexShrink?: MunStylePropertyValue
  readonly flexWrap?: MunStylePropertyValue
  readonly float?: MunStylePropertyValue
  readonly font?: MunStylePropertyValue
  readonly fontFamily?: MunStylePropertyValue
  readonly fontSize?: MunStylePropertyValue
  readonly fontStyle?: MunStylePropertyValue
  readonly fontWeight?: MunStylePropertyValue
  readonly gap?: MunStylePropertyValue
  readonly gridArea?: MunStylePropertyValue
  readonly gridAutoColumns?: MunStylePropertyValue
  readonly gridAutoFlow?: MunStylePropertyValue
  readonly gridAutoRows?: MunStylePropertyValue
  readonly gridColumn?: MunStylePropertyValue
  readonly gridRow?: MunStylePropertyValue
  readonly gridTemplateColumns?: MunStylePropertyValue
  readonly gridTemplateRows?: MunStylePropertyValue
  readonly height?: MunStylePropertyValue
  readonly inset?: MunStylePropertyValue
  readonly insetBlock?: MunStylePropertyValue
  readonly insetInline?: MunStylePropertyValue
  readonly justifyContent?: MunStylePropertyValue
  readonly justifyItems?: MunStylePropertyValue
  readonly justifySelf?: MunStylePropertyValue
  readonly left?: MunStylePropertyValue
  readonly letterSpacing?: MunStylePropertyValue
  readonly lineHeight?: MunStylePropertyValue
  readonly listStyle?: MunStylePropertyValue
  readonly margin?: MunStylePropertyValue
  readonly marginBlock?: MunStylePropertyValue
  readonly marginInline?: MunStylePropertyValue
  readonly marginBottom?: MunStylePropertyValue
  readonly marginLeft?: MunStylePropertyValue
  readonly marginRight?: MunStylePropertyValue
  readonly marginTop?: MunStylePropertyValue
  readonly mask?: MunStylePropertyValue
  readonly maskImage?: MunStylePropertyValue
  readonly maskSize?: MunStylePropertyValue
  readonly maxHeight?: MunStylePropertyValue
  readonly maxWidth?: MunStylePropertyValue
  readonly minHeight?: MunStylePropertyValue
  readonly minWidth?: MunStylePropertyValue
  readonly objectFit?: MunStylePropertyValue
  readonly opacity?: MunStylePropertyValue
  readonly order?: MunStylePropertyValue
  readonly outline?: MunStylePropertyValue
  readonly overflow?: MunStylePropertyValue
  readonly overflowX?: MunStylePropertyValue
  readonly overflowY?: MunStylePropertyValue
  readonly overscrollBehavior?: MunStylePropertyValue
  readonly padding?: MunStylePropertyValue
  readonly paddingBlock?: MunStylePropertyValue
  readonly paddingInline?: MunStylePropertyValue
  readonly paddingBottom?: MunStylePropertyValue
  readonly paddingLeft?: MunStylePropertyValue
  readonly paddingRight?: MunStylePropertyValue
  readonly paddingTop?: MunStylePropertyValue
  readonly placeContent?: MunStylePropertyValue
  readonly placeItems?: MunStylePropertyValue
  readonly placeSelf?: MunStylePropertyValue
  readonly pointerEvents?: MunStylePropertyValue
  readonly position?: MunStylePropertyValue
  readonly right?: MunStylePropertyValue
  readonly rowGap?: MunStylePropertyValue
  readonly scrollBehavior?: MunStylePropertyValue
  readonly textAlign?: MunStylePropertyValue
  readonly textDecoration?: MunStylePropertyValue
  readonly textOverflow?: MunStylePropertyValue
  readonly textTransform?: MunStylePropertyValue
  readonly top?: MunStylePropertyValue
  readonly transform?: MunStylePropertyValue
  readonly transformOrigin?: MunStylePropertyValue
  readonly translate?: MunStylePropertyValue
  readonly scale?: MunStylePropertyValue
  readonly rotate?: MunStylePropertyValue
  readonly userSelect?: MunStylePropertyValue
  readonly verticalAlign?: MunStylePropertyValue
  readonly visibility?: MunStylePropertyValue
  readonly WebkitMask?: MunStylePropertyValue
  readonly WebkitMaskImage?: MunStylePropertyValue
  readonly WebkitMaskSize?: MunStylePropertyValue
  readonly whiteSpace?: MunStylePropertyValue
  readonly width?: MunStylePropertyValue
  readonly wordBreak?: MunStylePropertyValue
  readonly zIndex?: MunStylePropertyValue
  readonly WebkitOverflowScrolling?: MunStylePropertyValue
  readonly WebkitTapHighlightColor?: MunStylePropertyValue
}
export type MunStyleValue = string | MunStyleProperties

type AriaAttributes = { readonly [Name in `aria-${string}`]?: string | number | boolean }
type DataAttributes = { readonly [Name in `data-${string}`]?: string | number | boolean }

export interface MunGlobalHtmlAttributes {
  readonly id?: string
  readonly class?: string
  readonly className?: string
  readonly style?: MunStyleValue
  readonly title?: string
  readonly role?: string
  readonly hidden?: boolean
  readonly lang?: string
  readonly dir?: "ltr" | "rtl" | "auto"
  readonly tabindex?: number
  readonly tabIndex?: number
  readonly draggable?: boolean
  readonly spellcheck?: boolean
  readonly contenteditable?: boolean | "plaintext-only"
  readonly slot?: string
  readonly part?: string
  readonly ref?: unknown
}

export type MunHtmlEventAttributes<Tag extends string> = {
  readonly onclick?: MunEventHandler<Tag>
  readonly onClick?: MunEventHandler<Tag>
  readonly onchange?: MunEventHandler<Tag>
  readonly onChange?: MunEventHandler<Tag>
  readonly oninput?: MunEventHandler<Tag>
  readonly onInput?: MunEventHandler<Tag>
  readonly onsubmit?: MunEventHandler<Tag>
  readonly onSubmit?: MunEventHandler<Tag>
  readonly onkeydown?: MunEventHandler<Tag>
  readonly onKeyDown?: MunEventHandler<Tag>
  readonly onkeyup?: MunEventHandler<Tag>
  readonly onKeyUp?: MunEventHandler<Tag>
  readonly onfocus?: MunEventHandler<Tag>
  readonly onFocus?: MunEventHandler<Tag>
  readonly onblur?: MunEventHandler<Tag>
  readonly onBlur?: MunEventHandler<Tag>
  readonly onpointerdown?: MunEventHandler<Tag>
  readonly onPointerDown?: MunEventHandler<Tag>
  readonly onpointermove?: MunEventHandler<Tag>
  readonly onPointerMove?: MunEventHandler<Tag>
  readonly onpointerup?: MunEventHandler<Tag>
  readonly onPointerUp?: MunEventHandler<Tag>
  readonly onpointerenter?: MunEventHandler<Tag>
  readonly onPointerEnter?: MunEventHandler<Tag>
  readonly onpointerleave?: MunEventHandler<Tag>
  readonly onPointerLeave?: MunEventHandler<Tag>
  readonly onmouseenter?: MunEventHandler<Tag>
  readonly onMouseEnter?: MunEventHandler<Tag>
  readonly onmouseleave?: MunEventHandler<Tag>
  readonly onMouseLeave?: MunEventHandler<Tag>
  readonly onmousemove?: MunEventHandler<Tag>
  readonly onMouseMove?: MunEventHandler<Tag>
  readonly onmouseover?: MunEventHandler<Tag>
  readonly onMouseOver?: MunEventHandler<Tag>
  readonly oncontextmenu?: MunEventHandler<Tag>
  readonly onContextMenu?: MunEventHandler<Tag>
  readonly ondblclick?: MunEventHandler<Tag>
  readonly onDoubleClick?: MunEventHandler<Tag>
  readonly onwheel?: MunEventHandler<Tag>
  readonly onWheel?: MunEventHandler<Tag>
  readonly onscroll?: MunEventHandler<Tag>
  readonly onScroll?: MunEventHandler<Tag>
  readonly onfocusin?: MunEventHandler<Tag>
  readonly onFocusIn?: MunEventHandler<Tag>
  readonly onfocusout?: MunEventHandler<Tag>
  readonly onFocusOut?: MunEventHandler<Tag>
  readonly oncompositionstart?: MunEventHandler<Tag>
  readonly onCompositionStart?: MunEventHandler<Tag>
  readonly oncompositionend?: MunEventHandler<Tag>
  readonly onCompositionEnd?: MunEventHandler<Tag>
  readonly ondragstart?: MunEventHandler<Tag>
  readonly onDragStart?: MunEventHandler<Tag>
  readonly ondragover?: MunEventHandler<Tag>
  readonly onDragOver?: MunEventHandler<Tag>
  readonly ondrop?: MunEventHandler<Tag>
  readonly onDrop?: MunEventHandler<Tag>
  readonly oncopy?: MunEventHandler<Tag>
  readonly onCopy?: MunEventHandler<Tag>
  readonly oncut?: MunEventHandler<Tag>
  readonly onCut?: MunEventHandler<Tag>
  readonly onpaste?: MunEventHandler<Tag>
  readonly onPaste?: MunEventHandler<Tag>
  readonly ontouchstart?: MunEventHandler<Tag>
  readonly onTouchStart?: MunEventHandler<Tag>
  readonly ontouchmove?: MunEventHandler<Tag>
  readonly onTouchMove?: MunEventHandler<Tag>
  readonly ontouchend?: MunEventHandler<Tag>
  readonly onTouchEnd?: MunEventHandler<Tag>
  readonly onload?: MunEventHandler<Tag>
  readonly onLoad?: MunEventHandler<Tag>
  readonly onerror?: MunEventHandler<Tag>
  readonly onError?: MunEventHandler<Tag>
}

type AnchorAttributes = { readonly href?: string; readonly target?: "_self" | "_blank" | "_parent" | "_top" | string; readonly rel?: string; readonly download?: string | boolean; readonly hreflang?: string }
type ButtonAttributes = { readonly type?: "button" | "submit" | "reset"; readonly disabled?: boolean; readonly name?: string; readonly value?: string | number; readonly autofocus?: boolean; readonly form?: string }
type FormAttributes = { readonly action?: string; readonly method?: "get" | "post" | "dialog"; readonly enctype?: string; readonly target?: string; readonly novalidate?: boolean; readonly autocomplete?: "on" | "off" }
type ImageAttributes = { readonly src: string; readonly alt: string; readonly width?: number | string; readonly height?: number | string; readonly loading?: "eager" | "lazy"; readonly decoding?: "sync" | "async" | "auto" }
type InputAttributes = { readonly type?: string; readonly value?: string | number; readonly checked?: boolean; readonly disabled?: boolean; readonly readonly?: boolean; readonly required?: boolean; readonly multiple?: boolean; readonly name?: string; readonly placeholder?: string; readonly min?: string | number; readonly max?: string | number; readonly step?: string | number; readonly accept?: string; readonly autocomplete?: string }
type LabelAttributes = { readonly for?: string; readonly htmlFor?: string }
type OptionAttributes = { readonly value?: string | number; readonly selected?: boolean; readonly disabled?: boolean; readonly label?: string }
type SelectAttributes = { readonly value?: string | number; readonly disabled?: boolean; readonly required?: boolean; readonly multiple?: boolean; readonly name?: string }
type TextAreaAttributes = { readonly value?: string; readonly disabled?: boolean; readonly readonly?: boolean; readonly required?: boolean; readonly name?: string; readonly placeholder?: string; readonly rows?: number; readonly cols?: number; readonly maxlength?: number }
type MediaAttributes = { readonly src?: string; readonly controls?: boolean; readonly autoplay?: boolean; readonly loop?: boolean; readonly muted?: boolean; readonly preload?: "none" | "metadata" | "auto" }
type ProgressAttributes = { readonly value?: number; readonly max?: number }
type TableCellAttributes = { readonly colspan?: number; readonly rowspan?: number; readonly headers?: string; readonly scope?: "row" | "col" | "rowgroup" | "colgroup" }

type TagAttributes<Tag extends MunHtmlTagName> =
  Tag extends "a" ? AnchorAttributes
  : Tag extends "button" ? ButtonAttributes
  : Tag extends "form" ? FormAttributes
  : Tag extends "img" ? ImageAttributes
  : Tag extends "input" ? InputAttributes
  : Tag extends "label" ? LabelAttributes
  : Tag extends "option" ? OptionAttributes
  : Tag extends "select" ? SelectAttributes
  : Tag extends "textarea" ? TextAreaAttributes
  : Tag extends "audio" | "video" ? MediaAttributes
  : Tag extends "progress" | "meter" ? ProgressAttributes
  : Tag extends "td" | "th" ? TableCellAttributes
  : Record<never, never>

export type MunHtmlAttributes<Tag extends MunHtmlTagName> =
  MunGlobalHtmlAttributes & AriaAttributes & DataAttributes & MunHtmlEventAttributes<Tag> & TagAttributes<Tag>

export type MunCustomElementAttributes<Tag extends `${string}-${string}` = `${string}-${string}`> =
  MunGlobalHtmlAttributes & AriaAttributes & DataAttributes & MunHtmlEventAttributes<Tag> & Readonly<Record<string, unknown>>

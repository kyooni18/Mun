import { isForeignComponent, renderViewNode, zeroGeometry, type CompiledTemplateValue, type MunRenderer, type ViewGraphValue, type ViewHostNode } from "@mun/core/compat"
import type { GPUIslandViewNode } from "@mun/core/internal/runtime"
import { assertHtmlName, classNameOf, escape, escapeAttribute, htmlAttributeName, isBooleanHtmlAttribute, isEnumeratedBooleanAttribute, nativeElementProps, normalizedRawTextValue, normalizedTextAreaValue, propsOf, rawTextHtmlElements, styleAttribute, styleOf, styleText, validTableChildElements, voidHtmlElements } from "./shared.js"



function mergeSerializedStyles(current: string, extra: string): string {
  const declarations = new Map<string, string>()
  const append = (input: string, composeTransform: boolean) => {
    for (const declaration of input.split(";")) {
      const colon = declaration.indexOf(":")
      if (colon < 0) continue
      const name = declaration.slice(0, colon).trim()
      const value = declaration.slice(colon + 1).trim()
      if (!name || !value) continue
      if (composeTransform && name === "transform" && declarations.has(name)) declarations.set(name, `${declarations.get(name)} ${value}`)
      else declarations.set(name, value)
    }
  }
  append(current, false)
  append(extra, true)
  return [...declarations].map(([name, value]) => `${name}:${value}`).join(";")
}

function serializedAttribute(key: string, value: unknown): string | undefined {
  if (key === "children" || key === "key" || key === "ref" || /^on[A-Za-z]/.test(key) || value === undefined || value === null || typeof value === "function") return undefined
  if (typeof value === "object" && key !== "style" && key !== "className" && key !== "class") return undefined
  const name = assertHtmlName(htmlAttributeName(key), "attribute")
  const serialized = key === "style" ? styleAttribute(value) : key === "className" || key === "class" ? classNameOf(value) : String(value)
  if (serialized === undefined) return undefined
  if (isBooleanHtmlAttribute(name)) return value ? name : undefined
  if (value === false || value === true) {
    if (name.startsWith("aria-") || name.startsWith("data-") || isEnumeratedBooleanAttribute(name)) {
      return `${name}="${String(value)}"`
    }
    return value ? name : `${name}="false"`
  }
  return `${name}="${escapeAttribute(serialized)}"`
}

function serializedTextAreaValue(value: unknown): string {
  const text = normalizedTextAreaValue(value)
  // The HTML parser strips one leading LF from textarea content. A synthetic
  // LF preserves the normalized value exposed by HTMLTextAreaElement.value.
  const serialized = escape(text)
  return text.startsWith("\n") ? `\n${serialized}` : serialized
}

function deserializeEscapedText(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&gt;", ">")
    .replaceAll("&lt;", "<")
    .replaceAll("&amp;", "&")
}

function serializeRawText(tag: string, children: readonly string[]): string {
  if (children.some(child => child.includes("<"))) {
    throw new TypeError(`<${tag.toLowerCase()}> only accepts text children`)
  }
  return normalizedRawTextValue(tag, deserializeEscapedText(children.join("")))
}

function serializeSelectedOption(content: string, value: unknown): string {
  const expectedAttribute = escapeAttribute(String(value))
  const expectedText = escape(String(value))
  let matched = false
  return content.replace(/<option(?=\s|>)([^>]*)>([\s\S]*?)<\/option>/gi, (_match, attributes: string, body: string) => {
    const cleaned = attributes.replace(/\sselected(?:="[^"]*")?/gi, "")
    const explicitValue = /\svalue="([^"]*)"/i.exec(cleaned)?.[1]
    const selected = !matched && (explicitValue === undefined ? body === expectedText : explicitValue === expectedAttribute)
    if (selected) matched = true
    return `<option${cleaned}${selected ? " selected" : ""}>${body}</option>`
  })
}

function serializeTableChildren(children: readonly string[]): string {
  let result = ""
  let group: { kind: "row" | "column" | "cell"; content: string } | undefined
  const flushGroup = (): void => {
    if (!group) return
    result += group.kind === "row"
      ? `<tbody>${group.content}</tbody>`
      : group.kind === "column"
        ? `<colgroup>${group.content}</colgroup>`
        : `<tbody><tr>${group.content}</tr></tbody>`
    group = undefined
  }
  for (const child of children) {
    const tag = /^<([A-Za-z][A-Za-z0-9-]*)(?:\s|>)/.exec(child)?.[1]?.toLowerCase()
    const kind = tag === "tr" ? "row" : tag === "col" ? "column" : tag === "td" || tag === "th" ? "cell" : undefined
    if (kind) {
      if (group?.kind !== kind) flushGroup()
      group = { kind, content: `${group?.content ?? ""}${child}` }
      continue
    }
    flushGroup()
    if (!tag && child.trim()) {
      throw new TypeError("<table> only accepts table sections, rows, columns, cells, scripts, templates, or whitespace")
    }
    if (tag && !validTableChildElements.has(tag)) {
      throw new TypeError("<table> only accepts table sections, rows, columns, cells, scripts, templates, or whitespace")
    }
    result += child
  }
  flushGroup()
  return result
}

type HtmlTemplateFactory = (renderSlot: (index: number) => string) => string
const htmlTemplateFactories = new WeakMap<object, HtmlTemplateFactory>()

function compileHtmlTemplate(value: CompiledTemplateValue): HtmlTemplateFactory {
  if (value !== null && typeof value === "object") {
    if (value.kind === "slot") {
      const index = value.index
      return renderSlot => renderSlot(index)
    }
    if (value.kind === "fragment") {
      const children = value.children.map(compileHtmlTemplate)
      return renderSlot => children.map(child => child(renderSlot)).join("")
    }
    if (value.kind === "element") {
      const type = value.type
      const props = value.props
      const children = value.children.map(compileHtmlTemplate)
      return renderSlot => htmlRenderer.element(type, props, ...children.map(child => child(renderSlot)))
    }
  }
  const staticValue = value === null || value === undefined || value === false || value === true ? "" : escape(value)
  return () => staticValue
}

const htmlRenderer: MunRenderer<string> = {
  element(type, props, ...children) {
    const foreign = isForeignComponent(type) ? type : undefined
    const tag = assertHtmlName(typeof type === "string" ? type : "div", "tag")
    const effectiveProps = foreign
      ? { ...foreign.props, ...foreign.events, ...(foreign.ref === undefined ? {} : { ref: foreign.ref }), ...(props ?? {}), "data-mun-foreign": foreign.name }
      : props
    const isTextArea = tag.toLowerCase() === "textarea"
    const isSelect = tag.toLowerCase() === "select"
    const isRawText = rawTextHtmlElements.has(tag.toLowerCase())
    const textAreaValue = isTextArea ? effectiveProps?.value : undefined
    const selectValue = isSelect ? effectiveProps?.value : undefined
    const hasTextAreaValue = textAreaValue !== undefined && textAreaValue !== null
    const hasSelectValue = selectValue !== undefined && selectValue !== null
    const attributes = Object.entries(effectiveProps ?? {})
      .filter(([key]) => !((isTextArea || isSelect) && htmlAttributeName(key).toLowerCase() === "value"))
      .map(([key, value]) => serializedAttribute(key, value))
      .filter((value): value is string => Boolean(value))
      .join(" ")
    const opening = `<${tag}${attributes ? ` ${attributes}` : ""}>`
    const childContent = isRawText
      ? serializeRawText(tag, children)
      : tag.toLowerCase() === "table"
        ? serializeTableChildren(children)
        : children.join("")
    const content = hasTextAreaValue
      ? serializedTextAreaValue(textAreaValue)
      : hasSelectValue
        ? serializeSelectedOption(childContent, selectValue)
        : childContent
    return voidHtmlElements.has(tag.toLowerCase()) ? opening : `${opening}${content}</${tag}>`
  },
  fragment(children) { return children.join("") },
  value(value) { return value === null || value === undefined || value === false ? "" : escape(value) },
  gpuIsland(node: GPUIslandViewNode) {
    return htmlRenderer.element("canvas", {
      ...(node.options.width === undefined ? {} : { width: node.options.width }),
      ...(node.options.height === undefined ? {} : { height: node.options.height }),
      ...(node.options.class === undefined ? {} : { class: node.options.class }),
      ...(node.options.style === undefined ? {} : { style: node.options.style }),
      ...(node.options.ariaLabel === undefined ? {} : { "aria-label": node.options.ariaLabel }),
      "data-mun-gpu-island": node.ir.id,
      "data-mun-gpu-kind": node.ir.kind,
      "data-mun-gpu-owner": "web-ssr",
      "data-mun-gpu-readback": "forbidden",
      "data-mun-gpu-fallback": node.ir.fallback,
      "data-mun-gpu-inert": "",
    })
  },
  template(node, renderSlot) {
    let factory = htmlTemplateFactories.get(node.template)
    if (!factory) {
      factory = compileHtmlTemplate(node.template.root)
      htmlTemplateFactories.set(node.template, factory)
    }
    return factory(renderSlot)
  },
  modifier(content, modifier, renderArgument) {
    if (modifier.name === "frame") {
      const style = styleText(styleOf(modifier))
      return `<div${style ? ` style="${escapeAttribute(style)}"` : ""}>${content}</div>`
    }
    if ((modifier.name === "background" || modifier.name === "overlay" || modifier.name === "listRowBackground")
      && typeof modifier.arguments[0] !== "string" && modifier.arguments[0] != null && renderArgument) {
      const layer = renderArgument(0)
      const alignment = modifier.arguments[1]
      const place = alignment === "leading" ? "center start"
        : alignment === "trailing" ? "center end"
          : alignment === "top" ? "start center"
            : alignment === "bottom" ? "end center"
              : alignment === "topLeading" ? "start start"
                : alignment === "topTrailing" ? "start end"
                  : alignment === "bottomLeading" ? "end start"
                    : alignment === "bottomTrailing" ? "end end"
                      : "center"
      const layerStyle = `grid-area:1 / 1;place-self:${place}${modifier.name === "overlay" ? "" : ";pointer-events:none"}`
      const contentLayer = `<div style="grid-area:1 / 1;min-width:0;min-height:0">${content}</div>`
      const modifierLayer = `<div style="${escapeAttribute(layerStyle)}">${layer}</div>`
      return `<div style="display:grid;position:relative">${modifier.name !== "overlay" ? `${modifierLayer}${contentLayer}` : `${contentLayer}${modifierLayer}`}</div>`
    }
    const extraStyle = styleText(styleOf(modifier))
    const modifierProps = propsOf(modifier)
    const rootTag = /^<([A-Za-z][A-Za-z0-9-]*)(?:\s|>)/.exec(content)?.[1]
    const extraProps = rootTag && !rootTag.includes("-") ? nativeElementProps(modifierProps) : modifierProps
    const propStyle = styleAttribute(extraProps.style)
    const propClass = classNameOf(extraProps.className ?? extraProps.class)
    if (!extraStyle && !propStyle && !propClass && Object.keys(extraProps).length === 0) return content
    const isTextArea = /^<textarea(?:\s|>)/i.test(content)
    const isSelect = /^<select(?:\s|>)/i.test(content)
    const hasTextAreaValue = isTextArea
      && Object.prototype.hasOwnProperty.call(extraProps, "value")
      && extraProps.value !== undefined
      && extraProps.value !== null
    const withAttributes = content.replace(/^(<[^ >]+)([^>]*)(>)/, (_match, start: string, attributes: string, end: string) => {
      let nextAttributes = attributes
      const styleMatch = /\sstyle="([^"]*)"/.exec(attributes)
      const extraStyles = [extraStyle, propStyle].filter(Boolean).join(";")
      if (styleMatch && extraStyles) {
        const merged = mergeSerializedStyles(deserializeEscapedText(styleMatch[1]), extraStyles)
        nextAttributes = nextAttributes.replace(styleMatch[0], ` style="${escapeAttribute(merged)}"`)
      } else if (extraStyles) {
        nextAttributes += ` style="${escapeAttribute(extraStyles)}"`
      }
      if (propClass) {
        const classMatch = /\sclass="([^"]*)"/.exec(nextAttributes)
        const escapedPropClass = escapeAttribute(propClass)
        const merged = [classMatch?.[1], escapedPropClass].filter(Boolean).join(" ")
        if (classMatch) nextAttributes = nextAttributes.replace(classMatch[0], ` class="${merged}"`)
        else nextAttributes += ` class="${escapedPropClass}"`
      }
      for (const [key, value] of Object.entries(extraProps)) {
        const name = assertHtmlName(htmlAttributeName(key), "attribute")
        if (name === "class" || name === "style" || name === "key" || name === "ref" || name === "children") continue
        if ((isTextArea || isSelect) && name.toLowerCase() === "value") {
          nextAttributes = nextAttributes.replace(/\svalue(?:="[^"]*")?/i, "")
          continue
        }
        const attribute = serializedAttribute(key, value)
        const escapedName = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
        const pattern = new RegExp(`\\s${escapedName}(?:="[^"]*")?`)
        if (!attribute) nextAttributes = nextAttributes.replace(pattern, "")
        else nextAttributes = pattern.test(nextAttributes)
          ? nextAttributes.replace(pattern, ` ${attribute}`)
          : `${nextAttributes} ${attribute}`
      }
      return `${start}${nextAttributes}${end}`
    })
    if (hasTextAreaValue) {
      return withAttributes.replace(
        /^(<textarea(?:\s[^>]*)?>)[\s\S]*(<\/textarea>)$/i,
        (_match, opening: string, closing: string) => `${opening}${serializedTextAreaValue(extraProps.value)}${closing}`,
      )
    }
    const hasSelectValue = isSelect
      && Object.prototype.hasOwnProperty.call(extraProps, "value")
      && extraProps.value !== undefined
      && extraProps.value !== null
    return hasSelectValue ? serializeSelectedOption(withAttributes, extraProps.value) : withAttributes
  },
  view(node: ViewHostNode, render) {
    const state = node.state?.(node.props) ?? {}
    return render({ ...node.props, ...state })
  },
  geometry(_node, render) {
    return `<div data-mun="GeometryReader">${render(zeroGeometry)}</div>`
  },
}
export function renderToHTML(value: ViewGraphValue): string {
  return renderViewNode(value, htmlRenderer)
}

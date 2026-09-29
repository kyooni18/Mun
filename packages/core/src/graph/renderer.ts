import { keyedViewIdentity, viewTypeIdentity, type ViewIdentity } from "../identity.js"
import { arrayCheck, snapshotArrayValues } from "./arrays.js"
import { isForeignComponent, isViewNode, keyedCollectionEntries } from "./nodes.js"
import { zeroGeometry } from "./environment.js"
import type { CompiledTemplateValue, GeometryProxy, LazyViewRange, MunRenderer, ViewGraphValue, ViewHostNode } from "./types.js"

export type { MunRenderer }

/** Collect View host identities already present in a graph without evaluating View bodies. */
export function collectLogicalViewIdentities(value: ViewGraphValue, identity: ViewIdentity = ["root"]): ViewIdentity[] {
  if (arrayCheck(value) === true) {
    return snapshotArrayValues(value as readonly unknown[]).flatMap((item, index) => collectLogicalViewIdentities(item as ViewGraphValue, [...identity, "array", index]))
  }
  if (!isViewNode(value)) return []
  switch (value.kind) {
    case "element": {
      const foreign = isForeignComponent(value.type) ? value.type : undefined
      const elementIdentity = foreign && foreign.key !== undefined ? keyedViewIdentity(identity, foreign.key) : identity
      return value.children.flatMap((child, index) => collectLogicalViewIdentities(child as ViewGraphValue, [...elementIdentity, "element", index]))
    }
    case "fragment":
      return value.children.flatMap((child, index) => collectLogicalViewIdentities(child as ViewGraphValue, [...identity, "fragment", index]))
    case "template":
      return value.slots.flatMap((slot, index) => collectLogicalViewIdentities(slot, [...identity, ...(value.template.slotIdentities[index] ?? ["template-slot", index])]))
    case "collection":
      return keyedCollectionEntries(value).flatMap(entry => collectLogicalViewIdentities(
        value.content(entry.item, entry.index, entry.key), [...identity, "fragment", entry.index]))
    case "modified": {
      let contentIdentity = identity
      for (const item of value.modifiers) {
        if (item.name === "keyed" || item.name === "id") contentIdentity = keyedViewIdentity(contentIdentity, item.arguments[0] as string | number)
      }
      return collectLogicalViewIdentities(value.content, contentIdentity)
    }
    case "view": {
      const typeIdentity = viewTypeIdentity(value.host, value.name)
      return [[...identity, "view-type", typeIdentity, "view", value.name]]
    }
    case "geometry":
      return []
    case "gpu-island":
      return []
    case "lazy":
      return value.children.flatMap((child, index) => collectLogicalViewIdentities(child as ViewGraphValue, [...identity, "lazy", index]))
  }
}

export function renderViewNode<Output>(value: ViewGraphValue, renderer: MunRenderer<Output>): Output {
  return renderViewNodeStack(value, renderer, ["root"])
}

function renderCompiledTemplateValue<Output>(
  value: CompiledTemplateValue,
  renderer: MunRenderer<Output>,
  renderSlot: (index: number) => Output,
): Output {
  if (value !== null && typeof value === "object") {
    if (value.kind === "slot") return renderSlot(value.index)
    if (value.kind === "fragment") return renderer.fragment(value.children.map(child => renderCompiledTemplateValue(child, renderer, renderSlot)))
    if (value.kind === "element") return renderer.element(value.type, value.props, ...value.children.map(child => renderCompiledTemplateValue(child, renderer, renderSlot)))
  }
  if (value === null || value === undefined || typeof value === "boolean") return renderer.value ? renderer.value(null) : null as Output
  return renderer.value ? renderer.value(value) : value as Output
}

export function renderViewNodeAt<Output>(value: ViewGraphValue, renderer: MunRenderer<Output>, identity: ViewIdentity): Output {
  // Public callers may retain the identity they pass us. Copy it once at the
  // entry point, then let the internal depth-first traversal reuse one mutable
  // stack instead of allocating/copying an identity array for every ordinary
  // element and primitive child.
  return renderViewNodeStack(value, renderer, [...identity])
}

function renderViewNodeStack<Output>(value: ViewGraphValue, renderer: MunRenderer<Output>, identity: Array<string | number>): Output {
  if (!isViewNode(value)) {
    if (arrayCheck(value) === true) {
      const values = snapshotArrayValues(value as readonly unknown[])
      const children = new Array<Output>(values.length)
      const base = identity.length
      for (let index = 0; index < values.length; index += 1) {
        identity.push("array", index)
        children[index] = renderViewNodeStack(values[index] as ViewGraphValue, renderer, identity)
        identity.length = base
      }
      return renderer.fragment(children)
    }
    if (value === null || value === undefined || typeof value === "boolean") {
      return renderer.value ? renderer.value(null) : null as Output
    }
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "bigint") {
      throw new TypeError("Mün View graph leaves must be renderable primitives or View nodes; wrap renderer-specific values in an explicit adapter.")
    }
    return renderer.value ? renderer.value(value) : value as Output
  }
  switch (value.kind) {
    case "element": {
      const foreign = isForeignComponent(value.type) ? value.type : undefined
      const elementIdentity = foreign && foreign.key !== undefined ? [...keyedViewIdentity(identity, foreign.key)] : identity
      const children = new Array<Output>(value.children.length)
      const base = elementIdentity.length
      for (let index = 0; index < value.children.length; index += 1) {
        elementIdentity.push("element", index)
        children[index] = renderViewNodeStack(value.children[index] as ViewGraphValue, renderer, elementIdentity)
        elementIdentity.length = base
      }
      return renderer.element(value.type, value.props, ...children)
    }
    case "fragment": {
      const children = new Array<Output>(value.children.length)
      const base = identity.length
      for (let index = 0; index < value.children.length; index += 1) {
        identity.push("fragment", index)
        children[index] = renderViewNodeStack(value.children[index] as ViewGraphValue, renderer, identity)
        identity.length = base
      }
      return renderer.fragment(children)
    }
    case "template": {
      // Template renderers may retain the slot callback, so snapshot only at
      // this real identity boundary instead of for every static host below it.
      const templateIdentity = [...identity]
      const renderSlot = (index: number): Output => renderViewNodeStack(
        value.slots[index] ?? null,
        renderer,
        [...templateIdentity, ...(value.template.slotIdentities[index] ?? ["template-slot", index])],
      )
      return renderer.template
        ? renderer.template(value, renderSlot, templateIdentity)
        : renderCompiledTemplateValue(value.template.root, renderer, renderSlot)
    }
    case "collection": {
      // Collection renderers own row lifetime and may invoke renderEntry after
      // this traversal returns. Give that boundary one stable base identity;
      // generic element traversal inside each row still reuses its own stack.
      const collectionIdentity = [...identity]
      const renderEntry = (entry: ReturnType<typeof keyedCollectionEntries>[number]): Output => renderViewNodeStack(
        value.content(entry.item, entry.index, entry.key), renderer, [...collectionIdentity, "fragment", entry.index])
      return renderer.collection
        ? renderer.collection(value, renderEntry, collectionIdentity)
        : renderer.fragment(keyedCollectionEntries(value).map(renderEntry))
    }
    case "modified": {
      let contentIdentity: ViewIdentity = identity
      for (const item of value.modifiers) {
        if (item.name === "keyed" || item.name === "id") contentIdentity = keyedViewIdentity(contentIdentity, item.arguments[0] as string | number)
      }
      let rendered = renderViewNodeStack(value.content, renderer, contentIdentity === identity ? identity : [...contentIdentity])
      for (const [modifierIndex, item] of value.modifiers.entries()) {
        const renderArgument = (argumentIndex: number): Output => renderViewNodeStack(
          item.arguments[argumentIndex] as ViewGraphValue,
          renderer,
          [...contentIdentity, "modifier", modifierIndex, "argument", argumentIndex],
        )
        rendered = renderer.modifier(rendered, item, renderArgument)
      }
      return rendered
    }
    case "view": {
      const typeIdentity = viewTypeIdentity(value.host, value.name)
      const viewIdentity: ViewIdentity = [...identity, "view-type", typeIdentity, "view", value.name]
      const bodyIdentity: ViewIdentity = [...viewIdentity, "body"]
      const renderWithProps = (props: Record<string, unknown> = value.props): Output => renderViewNodeStack(value.render(props), renderer, [...bodyIdentity])
      if (renderer.view) return renderer.view(value, renderWithProps, viewIdentity)
      const state = value.state?.(value.props) ?? {}
      return renderWithProps({ ...value.props, ...state })
    }
    case "geometry": {
      const geometryIdentity: ViewIdentity = [...identity, "geometry"]
      return renderer.geometry
        ? renderer.geometry(value, geometry => renderViewNodeStack(value.content(geometry), renderer, [...geometryIdentity]))
        : renderViewNodeStack(value.content(zeroGeometry), renderer, [...geometryIdentity])
    }
    case "lazy": {
      const lazyIdentity = [...identity]
      const renderChildren = (range?: LazyViewRange): Output => {
        const start = Math.max(0, range?.start ?? 0)
        const end = Math.min(value.children.length, range?.end ?? value.children.length)
        const children = new Array<Output>(Math.max(0, end - start))
        const rowIdentity = [...lazyIdentity]
        const base = rowIdentity.length
        for (let index = start; index < end; index += 1) {
          rowIdentity.push("lazy", index)
          children[index - start] = renderViewNodeStack(value.children[index] as ViewGraphValue, renderer, rowIdentity)
          rowIdentity.length = base
        }
        return renderer.fragment(children)
      }
      const renderItem = (index: number): Output => {
        if (!Number.isSafeInteger(index) || index < 0 || index >= value.children.length) return renderer.fragment([])
        const child = value.children[index]
        return renderViewNodeStack(child as ViewGraphValue, renderer, [...lazyIdentity, "lazy", index])
      }
      return renderer.lazy
        ? renderer.lazy(value, renderChildren, lazyIdentity, renderItem)
        : renderer.element("div", value.props, ...value.children.map((child, index) => renderViewNodeStack(child as ViewGraphValue, renderer, [...lazyIdentity, "lazy", index])))
    }
    case "gpu-island": {
      const islandIdentity: ViewIdentity = [...identity, "gpu-island", value.ir.id]
      if (renderer.gpuIsland) return renderer.gpuIsland(value, islandIdentity)
      return renderer.element("canvas", {
        ...(value.options.width === undefined ? {} : { width: value.options.width }),
        ...(value.options.height === undefined ? {} : { height: value.options.height }),
        "data-mun-gpu-island": value.ir.id,
        "data-mun-gpu-fallback": value.ir.fallback,
      })
    }
  }
}

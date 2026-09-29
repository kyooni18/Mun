import { Fragment, jsx as reactJsx, jsxs as reactJsxs } from 'react/jsx-runtime'
import { jsxDEV as reactJsxDEV } from 'react/jsx-dev-runtime'
import type * as React from 'react'
import type { CSSProperties, JSXElementConstructor, ReactElement } from 'react'
import { finalize, styled } from './modifiers.js'
import { markMunNode } from './runtime/jsx-node.js'
import type { Alignment, BorderOptions, FrameOptions, Length } from './types.js'

/** JSX-only values accepted by Mun's custom intrinsic-element runtime. */
export interface MunJSXProps {
  padding?: Length
  margin?: Length
  gap?: Length
  width?: Length
  height?: Length
  minWidth?: Length
  maxWidth?: Length
  minHeight?: Length
  maxHeight?: Length
  frame?: FrameOptions
  background?: CSSProperties['background']
  foreground?: CSSProperties['color']
  opacity?: number
  radius?: Length
  border?: BorderOptions
  shadow?: CSSProperties['boxShadow']
  fontSize?: Length
  fontWeight?: CSSProperties['fontWeight']
  fontFamily?: CSSProperties['fontFamily']
  lineHeight?: CSSProperties['lineHeight']
  textAlign?: CSSProperties['textAlign']
  bold?: boolean
  grow?: number
  shrink?: number
  flex?: CSSProperties['flex']
  wrap?: CSSProperties['flexWrap']
  order?: number
  align?: CSSProperties['alignItems']
  justify?: CSSProperties['justifyContent']
  alignment?: Alignment
  position?: CSSProperties['position']
  overflow?: CSSProperties['overflow']
  cursor?: CSSProperties['cursor']
  zIndex?: CSSProperties['zIndex']
  transform?: CSSProperties['transform']
  cssTransition?: CSSProperties['transition']
}

type MunIntrinsicElements = {
  [K in keyof React.JSX.IntrinsicElements]: React.JSX.IntrinsicElements[K] & MunJSXProps
}

export namespace JSX {
  export type Element = React.JSX.Element
  export interface ElementClass extends React.JSX.ElementClass {}
  export interface ElementAttributesProperty extends React.JSX.ElementAttributesProperty {}
  export interface IntrinsicAttributes extends React.JSX.IntrinsicAttributes {}
  export type IntrinsicElements = MunIntrinsicElements
}

const MUN_PROPS = new Set([
  'padding', 'margin', 'gap', 'width', 'height', 'minWidth', 'maxWidth',
  'minHeight', 'maxHeight', 'frame', 'background', 'foreground', 'opacity',
  'radius', 'border', 'shadow', 'fontSize', 'fontWeight', 'fontFamily',
  'lineHeight', 'textAlign', 'bold', 'grow', 'shrink', 'flex', 'wrap',
  'order', 'align', 'justify', 'alignment', 'position', 'overflow', 'cursor',
  'zIndex', 'transform', 'cssTransition'
])

function splitProps(props: Record<string, unknown> | null | undefined) {
  const native: Record<string, unknown> = {}
  const modifiers: Array<(value: any) => any> = []
  const modifierNames: string[] = []

  for (const [key, value] of Object.entries(props ?? {})) {
    if (MUN_PROPS.has(key)) {
      modifierNames.push(key)
      modifiers.push((element) => {
        const fn = (element as any)[key]
        return typeof fn === 'function' ? fn.call(element, value) : element
      })
    } else {
      native[key] = value
    }
  }

  return { native, modifiers, modifierNames }
}

function applyModifiers(element: ReactElement, modifiers: Array<(value: any) => any>): ReactElement {
  if (modifiers.length === 0) return element
  let result: any = styled(element)
  for (const modifier of modifiers) result = modifier(result)
  return result
}

function wrap(factory: (type: any, props: any, key?: any) => ReactElement, type: any, props: any, key?: any) {
  const { native, modifiers, modifierNames } = splitProps(props)
  const element = factory(type as JSXElementConstructor<any>, native, key)
  const styledElement = applyModifiers(element, modifiers)
  const finalElement = finalize(styledElement)
  return markMunNode(finalElement, { modifiers: modifierNames, layout: native.style })
}

export const jsx = (type: any, props: any, key?: any) => wrap(reactJsx, type, props, key)
export const jsxs = (type: any, props: any, key?: any) => wrap(reactJsxs, type, props, key)
export const jsxDEV = (type: any, props: any, key?: any, isStaticChildren?: boolean, source?: any, self?: any) => {
  const { native, modifiers, modifierNames } = splitProps(props)
  const element = reactJsxDEV(type, native, key, isStaticChildren ?? false, source, self)
  const styledElement = applyModifiers(element, modifiers)
  const finalElement = finalize(styledElement)
  return markMunNode(finalElement, { modifiers: modifierNames, layout: native.style })
}

export { Fragment }

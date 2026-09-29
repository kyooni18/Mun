/** Public Web adapter. DOM, SSR, and hydration internals stay behind focused modules. */
export { renderToHTML } from "./ssr.js"
export { mount } from "./dom.js"
export type { WebMountOptions } from "./dom.js"
export { renderMunUiProgramToHTML } from "./ui-ir.js"
export type { MunWebIrRenderOptions } from "./ui-ir.js"

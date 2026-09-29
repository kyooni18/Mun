/** Public Vue adapter. Renderer implementation stays behind a focused module. */
export {
  Component,
  MunView,
  createVueView,
  foreignComponent,
  fromVueRef,
  mount,
  render,
  toVueRef,
  vueComponent,
} from "./renderer.js"
export type {
  MunViewProps,
  MunVueSlot,
  VueComponentProps,
  VueComponentView,
  VueMountOptions,
  VueView,
} from "./renderer.js"

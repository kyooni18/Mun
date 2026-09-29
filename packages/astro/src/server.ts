import { renderToHTML } from "@mun/web"
import {
  instantiateMunAstroComponent,
  isMunAstroComponent,
  type MunAstroComponent,
} from "./runtime.js"

function hasSlots(slots: Record<string, unknown>): boolean {
  return Object.values(slots).some(value => typeof value !== "string" || value.trim().length > 0)
}

const renderer = {
  name: "@mun/astro",

  async check(Component: unknown): Promise<boolean> {
    return isMunAstroComponent(Component)
  },

  async renderToStaticMarkup(
    Component: MunAstroComponent,
    props: Record<string, unknown>,
    slots: Record<string, string>,
  ): Promise<{ html: string }> {
    if (hasSlots(slots)) {
      throw new TypeError("Astro HTML slots cannot cross into a Mün component. Compose Mün Views inside .mun or @mun instead.")
    }
    return { html: renderToHTML(instantiateMunAstroComponent(Component, props)) }
  },
}

export default renderer

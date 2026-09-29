import { mount } from "@mun/web"
import {
  instantiateMunAstroComponent,
  type MunAstroComponent,
} from "./runtime.js"

interface AstroClientMetadata {
  readonly client?: string
}

function hasSlots(slots: Record<string, unknown>): boolean {
  return Object.values(slots).some(value => typeof value !== "string" || value.trim().length > 0)
}

export default function createMunClientRenderer(element: HTMLElement) {
  return async function hydrateMun(
    Component: MunAstroComponent,
    props: Record<string, unknown>,
    slots: Record<string, unknown>,
    metadata: AstroClientMetadata,
  ): Promise<void> {
    if (hasSlots(slots)) {
      throw new TypeError("Astro HTML slots cannot cross into a Mün component. Compose Mün Views inside .mun or @mun instead.")
    }

    const dispose = mount(instantiateMunAstroComponent(Component, props), element, {
      hydrate: metadata.client !== "only",
    })

    element.addEventListener("astro:unmount", dispose, { once: true })
  }
}

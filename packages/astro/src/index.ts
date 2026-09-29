import { munPlugin } from "@mun/vite"
import { createMunAstroSourcePlugin } from "./source.js"

export {
  createMunAstroSourcePlugin,
  generateVirtualMunModule,
  transformAstroMunSource,
} from "./source.js"
export type {
  MunAstroClientDirective,
  MunAstroEmbeddedBlock,
  MunAstroSourceTransform,
} from "./source.js"

export interface MunAstroIntegrationOptions {
  readonly embeddedBlocks?: boolean
}

interface AstroConfigSetupContext {
  readonly addRenderer: (renderer: {
    readonly name: string
    readonly serverEntrypoint: string
    readonly clientEntrypoint?: string
  }) => void
  readonly updateConfig: (config: {
    readonly vite?: { readonly plugins?: readonly unknown[] }
  }) => unknown
}

export interface MunAstroIntegration {
  readonly name: "@mun/astro"
  readonly hooks: {
    readonly "astro:config:setup": (context: AstroConfigSetupContext) => void
  }
}

export function munAstro(options: MunAstroIntegrationOptions = {}): MunAstroIntegration {
  return {
    name: "@mun/astro",
    hooks: {
      "astro:config:setup": ({ addRenderer, updateConfig }) => {
        addRenderer({
          name: "@mun/astro",
          serverEntrypoint: "@mun/astro/server",
          clientEntrypoint: "@mun/astro/client",
        })

        const plugins: unknown[] = [munPlugin()]
        if (options.embeddedBlocks !== false) plugins.unshift(createMunAstroSourcePlugin())
        updateConfig({ vite: { plugins } })
      },
    },
  }
}

export default munAstro

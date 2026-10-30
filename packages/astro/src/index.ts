import { munPlugin } from "@mun-ui/vite"
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
  readonly name: "@mun-ui/astro"
  readonly hooks: {
    readonly "astro:config:setup": (context: AstroConfigSetupContext) => void
  }
}

export function munAstro(options: MunAstroIntegrationOptions = {}): MunAstroIntegration {
  return {
    name: "@mun-ui/astro",
    hooks: {
      "astro:config:setup": ({ addRenderer, updateConfig }) => {
        addRenderer({
          name: "@mun-ui/astro",
          serverEntrypoint: "@mun-ui/astro/server",
          clientEntrypoint: "@mun-ui/astro/client",
        })

        const plugins: unknown[] = [munPlugin()]
        if (options.embeddedBlocks !== false) plugins.unshift(createMunAstroSourcePlugin())
        updateConfig({ vite: { plugins } })
      },
    },
  }
}

export default munAstro

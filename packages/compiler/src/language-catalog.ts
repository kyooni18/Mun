// Shared native API catalog. Editors consume compiler metadata, never a fallback
// copy of compatibility constructor signatures.
import {
  nativeViewInitializerSymbols, nativeModifierSymbols, swiftUIApiManifest,
  type SwiftUIOverloadSpec,
} from "@mun/core/swiftui-manifest"
import { horizontalAlignments, verticalAlignments, overlayAlignments, paddingEdges } from './native-member-contract.js'

export function nativeLanguageCatalog() {
  return {
    implicitMembers: {
      HorizontalAlignment: horizontalAlignments, VerticalAlignment: verticalAlignments,
      Alignment: overlayAlignments, UnitPoint: overlayAlignments,
      'Edge.Set': Object.keys(paddingEdges), 'Axis.Set': ['horizontal', 'vertical'],
      CGFloat: ['infinity'],
    },
    views: Object.entries(swiftUIApiManifest.views).flatMap(([name, spec]) => {
      const initializers = nativeViewInitializerSymbols(name)
      return initializers ? [{ name, initializers, documentation: (spec.initializers as readonly SwiftUIOverloadSpec[]).filter(item => item.native).map(item => item.subset ?? item.contract).join("; ") }] : []
    }),
    modifiers: swiftUIApiManifest.modifiers.flatMap(spec => {
      const initializers = nativeModifierSymbols(spec.name)
      return initializers ? [{ name: spec.name, initializers }] : []
    }),
    values: swiftUIApiManifest.values.map(spec => ({
      name: spec.name,
      members: (spec.members as readonly SwiftUIOverloadSpec[]).filter(item => item.native),
    })),
  }
}

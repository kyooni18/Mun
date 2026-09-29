#!/usr/bin/env node
import assert from "node:assert/strict"
import * as Core from "../packages/core/dist/index.js"

const manifest = Core.swiftUIApiManifest
const probe = Core.Text("manifest-probe")
const failures = []

function runtimeParameterCovers(canonical, runtime) {
  if (canonical.kind !== runtime.kind) return false
  if (canonical.label === undefined && canonical.labelRequired !== true) return true
  const canonicalName = canonical.label ?? canonical.name
  if (!canonicalName) return true
  return runtime.label === canonicalName
    || runtime.name === canonicalName
    || runtime.properties?.includes(canonicalName) === true
}

function swiftUISignatures(modifier) {
  return modifier.compatibility ? [] : modifier.swiftUISignatures ?? modifier.signatures
}

for (const [name, spec] of Object.entries(manifest.views)) {
  if (!["source", "source-subset", "web-approximation"].includes(spec.fidelity)) {
    failures.push(`View ${name} is missing a declared SwiftUI parity fidelity.`)
  }
  const runtime = Core[name]
  if (typeof runtime !== "function") {
    failures.push(`View ${name} is in the SwiftUI manifest but is not exported by @mun/core.`)
    continue
  }
  const generated = Core.swiftUIInitializerSymbols(name) ?? []
  const expected = spec.initializers.map(initializer => initializer.signature)
  const actual = generated.map(initializer => initializer.signature)
  try { assert.deepEqual(actual, expected) } catch {
    failures.push(`View ${name} initializer symbols do not match its manifest signatures.`)
  }
  const runtimeInitializers = Core.initializersOf(runtime)
  if (runtimeInitializers.length === 0) {
    failures.push(`View ${name} has no runtime initializer implementation.`)
    continue
  }
  for (const [declarationIndex, initializer] of spec.initializers.entries()) {
    const runtimeIndex = initializer.runtimeIndex ?? declarationIndex
    if (!Number.isInteger(runtimeIndex) || runtimeIndex < 0 || runtimeIndex >= runtimeInitializers.length) {
      failures.push(`View ${name} ${initializer.signature} maps to missing runtime initializer index ${runtimeIndex}.`)
      continue
    }
    const runtimeInitializer = runtimeInitializers[runtimeIndex]
    if (!Array.isArray(runtimeInitializer.parameters) && initializer.parameters.length === 0) continue
    if (!Array.isArray(runtimeInitializer.parameters)) {
      failures.push(`View ${name} ${initializer.signature} maps to runtime initializer ${runtimeIndex} without semantic parameter metadata.`)
      continue
    }
    for (const parameter of initializer.parameters) {
      if (!runtimeInitializer.parameters.some(runtimeParameter => runtimeParameterCovers(parameter, runtimeParameter))) {
        const label = parameter.label ?? parameter.name ?? parameter.kind
        failures.push(`View ${name} ${initializer.signature} parameter ${label} is not represented by runtime initializer ${runtimeIndex}.`)
      }
    }
  }
}

for (const modifier of manifest.modifiers) {
  if (typeof probe[modifier.name] !== "function") {
    failures.push(`Modifier .${modifier.name}(...) is in the manifest but is missing from ModifiableViewNode.`)
  }
  if (!Core.swiftUIStaticModifierNames.has(modifier.name)) {
    failures.push(`Modifier .${modifier.name}(...) is missing from compiler static modifier names.`)
  }
  if (!modifier.compatibility && swiftUISignatures(modifier).length === 0) {
    failures.push(`Canonical modifier .${modifier.name}(...) has no SwiftUI-backed signatures.`)
  }
  if (!modifier.compatibility && !["source", "source-subset", "web-approximation"].includes(modifier.fidelity)) {
    failures.push(`Canonical modifier .${modifier.name}(...) is missing a declared SwiftUI parity fidelity.`)
  }
}

for (const name of Core.swiftUIStaticModifierNames) {
  if (!manifest.modifiers.some(modifier => modifier.name === name)) {
    failures.push(`Static modifier ${name} has no manifest entry.`)
  }
}

if (failures.length > 0) {
  console.error("SwiftUI manifest consistency check failed:\n")
  for (const failure of failures) console.error(`- ${failure}`)
  process.exitCode = 1
} else {
  const canonicalModifiers = manifest.modifiers.filter(modifier => !modifier.compatibility).length
  const compatibilityModifiers = manifest.modifiers.length - canonicalModifiers
  const extensionSignatures = manifest.modifiers
    .filter(modifier => !modifier.compatibility)
    .reduce((count, modifier) => count + modifier.signatures.length - swiftUISignatures(modifier).length, 0)
  const fidelityCounts = [...Object.values(manifest.views), ...manifest.modifiers.filter(modifier => !modifier.compatibility)]
    .reduce((counts, entry) => ({ ...counts, [entry.fidelity]: (counts[entry.fidelity] ?? 0) + 1 }), {})
  console.log(`SwiftUI manifest OK: ${Object.keys(manifest.views).length} canonical views, ${canonicalModifiers} canonical modifiers, ${compatibilityModifiers} compatibility modifiers, ${extensionSignatures} same-name Mün extension signature(s); fidelity source=${fidelityCounts.source ?? 0}, subset=${fidelityCounts["source-subset"] ?? 0}, web=${fidelityCounts["web-approximation"] ?? 0}.`)
}

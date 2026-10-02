#!/usr/bin/env node
// SwiftUI parity contract ⇄ implementation consistency.
//
// The manifest (`swiftUIApiManifest`, @mun/core/swiftui-manifest) describes the
// SwiftUI-derived source surface. This check proves each claim has an
// implementation and each implementation is claimed:
//
// - native claims ⇄ `nativeLoweringMetadata()` of @mun/compiler (the keys of
//   the native lowering tables themselves);
// - compatibility-graph claims ⇄ the legacy View graph in @mun/core/compat;
// - compatibility-only Mün spellings are rejected by the canonical compiler.
import * as Core from "../packages/core/dist/api-manifest.js"
import * as Compat from "../packages/core/dist/compat.js"
import { compileMunUiProgram, nativeLoweringMetadata } from "../packages/compiler/dist/index.js"

const manifest = Core.swiftUIApiManifest
const native = nativeLoweringMetadata()
const failures = []
const contracts = new Set(["exact", "subset"])
const nativeSemantics = new Set(["parity", "divergent"])
const webSemantics = new Set(["parity", "approximation", "unsupported"])

function checkOverload(owner, overload) {
  const name = `${owner}.${overload.signature}`
  if (!contracts.has(overload.contract)) failures.push(`${name} has no source contract (exact/subset).`)
  if (overload.contract === "subset" && !overload.subset) failures.push(`${name} is a subset but does not say what it leaves out.`)
  if (overload.native !== undefined && !nativeSemantics.has(overload.native)) failures.push(`${name} has an unknown native semantics '${overload.native}'.`)
  if (overload.native === "divergent" && !overload.divergence) failures.push(`${name} is divergent but does not document the divergence.`)
  if (overload.web !== undefined && !webSemantics.has(overload.web)) failures.push(`${name} has an unknown web semantics '${overload.web}'.`)
  if (overload.native && overload.signature.includes("(") && !Array.isArray(overload.parameters)) {
    failures.push(`${name} is native but has no parameter contract.`)
  }
}

function compare(kind, claimed, implemented) {
  for (const key of claimed) {
    if (!implemented.has(key)) failures.push(`${kind} ${key} is claimed native in the manifest but has no native implementation.`)
  }
  for (const key of implemented) {
    if (!claimed.has(key)) failures.push(`${kind} ${key} is implemented natively but not claimed in the manifest.`)
  }
}

// Views.
const claimedViews = new Set()
for (const [name, spec] of Object.entries(manifest.views)) {
  if (spec.name !== name) failures.push(`View ${name} is registered under a different name (${spec.name}).`)
  for (const initializer of spec.initializers) {
    checkOverload(name, initializer)
    if (initializer.native) claimedViews.add(`${name}.${initializer.signature}`)
  }
  if (!spec.initializers.some(initializer => initializer.native) && !spec.compat) {
    failures.push(`View ${name} has neither a native nor a compatibility implementation.`)
  }
}
compare("View", claimedViews, new Set(native.views))

// Modifiers.
const claimedModifiers = new Set()
for (const modifier of manifest.modifiers) {
  for (const signature of modifier.signatures) {
    checkOverload(modifier.owner ?? "View", signature)
    if (signature.native) claimedModifiers.add(signature.signature)
  }
  if (modifier.signatures.length === 0 && !modifier.compat?.munExtensions?.length) {
    failures.push(`Modifier .${modifier.name} has no SDK signatures and is not a declared Mün compatibility modifier.`)
  }
}
compare("Modifier", claimedModifiers, new Set(native.modifiers))

// Values.
const claimedValues = new Set()
for (const value of manifest.values) {
  for (const member of value.members) {
    checkOverload(value.name, member)
    if (member.native) claimedValues.add(`${value.name}.${member.signature}`)
  }
}
compare("Value", claimedValues, new Set(native.values))

// Mün extensions: intentional ones are implemented; compatibility-only Views
// are rejected by the canonical compiler with their replacement.
for (const extension of manifest.extensions) {
  if (!extension.reason) failures.push(`Mün ${extension.kind} ${extension.name} does not say why it exists.`)
  if (extension.status === "extension") {
    for (const signature of extension.signatures) {
      if (!native.extensions.includes(`${extension.name}.${signature}`)) {
        failures.push(`Mün extension ${extension.name}.${signature} has no native implementation.`)
      }
    }
  } else if (!extension.replacement) {
    failures.push(`Compatibility-only ${extension.name} does not name its canonical replacement.`)
  }
}
const compatibilityProbes = {
  RadioGroup: "RadioGroup($v, [])",
  Column: "Column { Text(\"x\") }",
  Row: "Row { Text(\"x\") }",
  Action: "Action(\"x\") { v = \"y\" }",
  Panel: "Panel()",
  Transition: "Text(\"x\").transition(Transition.opacity)",
  LinearGradient: "Text(\"x\").background(LinearGradient(Color(\"#000000\"), Color(\"#FFFFFF\")))",
  foregroundColor: "Text(\"x\").foregroundColor(Color.red)",
}
for (const extension of manifest.extensions.filter(item => item.status === "compatibility")) {
  const probe = compatibilityProbes[extension.name]
  if (!probe) {
    failures.push(`Compatibility-only ${extension.name} has no rejection probe in this check.`)
    continue
  }
  try {
    compileMunUiProgram(`struct Probe: View {\n  @State var v: string = "x"\n  var body: some View {\n    ${probe}\n  }\n}\n`)
    failures.push(`Canonical .mun accepts compatibility-only ${extension.name} (${probe}).`)
  } catch (error) {
    if (!/compatibility-only/.test(String(error?.message))) {
      failures.push(`Canonical .mun rejects ${extension.name} without naming it compatibility-only: ${error?.message}`)
    }
  }
}

// Unsupported SwiftUI APIs must not also be claimed.
for (const view of manifest.unsupported.views) {
  if (manifest.views[view.name]?.initializers.some(initializer => initializer.native)) {
    failures.push(`View ${view.name} is listed as unsupported but has native overloads.`)
  }
}
for (const modifier of manifest.unsupported.modifiers) {
  if (manifest.modifiers.some(item => item.name === modifier.name && item.signatures.some(signature => signature.native))) {
    failures.push(`Modifier .${modifier.name} is listed as unsupported but has native overloads.`)
  }
}

// Legacy compatibility graph (`.mun.ts`, React/Vue/DOM renderers).
const probe = Compat.Text("manifest-probe")
for (const modifier of manifest.modifiers) {
  if (!modifier.compat) continue
  if (typeof probe[modifier.name] !== "function") {
    failures.push(`Modifier .${modifier.name} claims a compatibility-graph implementation but ModifiableViewNode has no such method.`)
  }
  if (!Core.swiftUIStaticModifierNames.has(modifier.name)) {
    failures.push(`Compatibility modifier .${modifier.name} is missing from the compiler's static modifier names.`)
  }
}
for (const name of Core.swiftUIStaticModifierNames) {
  if (!manifest.modifiers.some(modifier => modifier.name === name && modifier.compat)) {
    failures.push(`Static modifier ${name} has no compatibility entry.`)
  }
}
for (const [name, spec] of Object.entries(manifest.views)) {
  if (!spec.compat) continue
  const runtime = Compat[name]
  if (typeof runtime !== "function") {
    failures.push(`View ${name} claims a compatibility-graph implementation but @mun/core/compat does not export it.`)
    continue
  }
  const runtimeInitializers = Compat.initializersOf(runtime)
  for (const [index, initializer] of spec.compat.initializers.entries()) {
    const runtimeIndex = initializer.runtimeIndex ?? index
    const target = runtimeInitializers[runtimeIndex]
    if (!target) {
      failures.push(`View ${name} compatibility ${initializer.signature} maps to missing runtime initializer ${runtimeIndex}.`)
      continue
    }
    if (!Array.isArray(target.parameters)) continue
    for (const parameter of initializer.parameters) {
      // An unlabeled source parameter is covered by any runtime parameter of its kind.
      const label = parameter.label
      const covered = target.parameters.some(candidate => candidate.kind === parameter.kind
        && (label === undefined || candidate.label === label || candidate.name === label || candidate.properties?.includes(label)))
      if (!covered) failures.push(`View ${name} compatibility ${initializer.signature} parameter ${label ?? parameter.name ?? parameter.kind} is not represented by runtime initializer ${runtimeIndex}.`)
    }
  }
}

if (failures.length > 0) {
  console.error("SwiftUI manifest consistency check failed:\n")
  for (const failure of failures) console.error(`- ${failure}`)
  process.exitCode = 1
} else {
  console.log(`SwiftUI manifest OK: native ${native.views.length} View overloads, ${native.modifiers.length} modifier overloads, ${native.values.length} value members; ${manifest.modifiers.filter(modifier => modifier.compat).length} compatibility-graph modifiers; ${manifest.extensions.length} Mün extensions.`)
}

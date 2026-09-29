#!/usr/bin/env node
import { execFileSync } from "node:child_process"
import { createHash } from "node:crypto"
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, mkdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, resolve } from "node:path"

function run(command, args) {
  return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim()
}

function argument(name, fallback) {
  const index = process.argv.indexOf(name)
  return index >= 0 ? process.argv[index + 1] ?? fallback : fallback
}

if (process.platform !== "darwin") {
  console.error("SwiftUI API snapshot generation requires macOS with Xcode command-line tools.")
  process.exit(2)
}

const sdkName = argument("--sdk", "macosx")
const outputPath = resolve(argument("--output", "api/swiftui-symbols.snapshot.json"))
const requestedModules = argument("--modules", argument("--module", "SwiftUI,SwiftUICore"))
  .split(",")
  .map(value => value.trim())
  .filter(Boolean)
const sdkPath = run("xcrun", ["--sdk", sdkName, "--show-sdk-path"])
const sdkVersion = run("xcrun", ["--sdk", sdkName, "--show-sdk-version"])
const targetInfo = JSON.parse(run("xcrun", ["swiftc", "-print-target-info"]))
const target = argument("--target", targetInfo?.target?.triple)
if (!target) throw new Error("Unable to determine the Swift compiler target triple.")

const temporary = mkdtempSync(`${tmpdir()}/mun-swiftui-symbols-`)
try {
  const extractedModules = []
  for (const moduleName of requestedModules) {
    try {
      run("xcrun", [
        "swift-symbolgraph-extract",
        "-module-name", moduleName,
        "-target", target,
        "-sdk", sdkPath,
        "-minimum-access-level", "public",
        "-output-dir", temporary,
      ])
      extractedModules.push(moduleName)
    } catch (error) {
      // SwiftUICore is a newer SDK split. Older Xcode releases legitimately do
      // not expose it, so keep the snapshot useful as long as SwiftUI itself
      // was extracted successfully.
      if (moduleName === "SwiftUI") throw error
      console.warn(`Skipping unavailable SwiftUI companion module ${moduleName}.`)
    }
  }

  const files = readdirSync(temporary).filter(name => name.endsWith(".symbols.json")).sort()
  if (files.length === 0) throw new Error("swift-symbolgraph-extract produced no SwiftUI symbol graph files.")

  const symbols = new Map()
  const relationships = []
  for (const file of files) {
    const graph = JSON.parse(readFileSync(resolve(temporary, file), "utf8"))
    const graphModule = graph.module?.name ?? file.replace(/\.symbols\.json$/, "").split("@")[0]
    if (!extractedModules.includes(graphModule)) continue
    for (const symbol of graph.symbols ?? []) {
      if (symbol.accessLevel !== "public") continue
      const precise = symbol.identifier?.precise
      if (!precise) continue
      symbols.set(precise, {
        module: graphModule,
        preciseIdentifier: precise,
        kind: symbol.kind?.identifier,
        title: symbol.names?.title,
        pathComponents: symbol.pathComponents ?? [],
        declaration: (symbol.declarationFragments ?? []).map(fragment => fragment.spelling ?? "").join("").trim(),
        functionSignature: symbol.functionSignature ?? null,
        availability: symbol.availability ?? [],
        spi: symbol.spi ?? false,
      })
    }
    for (const relationship of graph.relationships ?? []) {
      relationships.push({
        module: graphModule,
        kind: relationship.kind,
        source: relationship.source,
        target: relationship.target,
        targetFallback: relationship.targetFallback ?? null,
      })
    }
  }

  const orderedSymbols = [...symbols.values()].sort((left, right) => left.preciseIdentifier.localeCompare(right.preciseIdentifier))
  relationships.sort((left, right) => `${left.source}:${left.kind}:${left.target}`.localeCompare(`${right.source}:${right.kind}:${right.target}`))
  const digest = createHash("sha256").update(JSON.stringify(orderedSymbols)).digest("hex")
  let xcodeVersion = "unknown"
  try { xcodeVersion = run("xcodebuild", ["-version"]).replaceAll("\n", " ") } catch {}

  const snapshot = {
    schemaVersion: 2,
    module: "SwiftUI",
    modules: extractedModules,
    sdk: sdkName,
    sdkVersion,
    target,
    xcodeVersion,
    symbolCount: orderedSymbols.length,
    sha256: digest,
    symbols: orderedSymbols,
    relationships,
  }
  mkdirSync(dirname(outputPath), { recursive: true })
  writeFileSync(outputPath, `${JSON.stringify(snapshot, null, 2)}\n`)
  console.log(`Wrote ${orderedSymbols.length} public ${extractedModules.join(" + ")} symbols to ${outputPath}`)
} finally {
  rmSync(temporary, { recursive: true, force: true })
}

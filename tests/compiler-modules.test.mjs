import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import test from "node:test"
import * as diagnostics from "../packages/compiler/dist/diagnostics.js"
import * as specialization from "../packages/compiler/dist/specialization.js"
import * as scanner from "../packages/compiler/dist/scanner.js"
import * as pipeline from "../packages/compiler/dist/pipeline.js"
import * as vite from "../packages/compiler/dist/vite.js"

test("compiler specialization is an internal, renderer-neutral pass", () => {
  assert.equal(typeof specialization.lowerStaticModifierChains, "function")
  assert.equal(typeof specialization.lowerStaticImportedCalls, "function")
  assert.equal(typeof specialization.foldStaticResults, "function")
  assert.ok(specialization.staticModifierNames.has("padding"))
  const source = readFileSync(new URL("../packages/compiler/dist/specialization.js", import.meta.url), "utf8")
  assert.doesNotMatch(source, /(?:^|[\\"'])react(?:[-/][^\\"']*)?[\\"']/i)
})

test("compiler scanner and lowering pipeline stay focused and renderer-neutral", () => {
  assert.equal(typeof scanner.findBuilder, "function")
  assert.equal(typeof scanner.findRawHtml, "function")
  assert.equal(typeof pipeline.transformMunSource, "function")
  assert.equal(typeof pipeline.hasMunSyntax, "function")
  const sources = [
    readFileSync(new URL("../packages/compiler/dist/scanner.js", import.meta.url), "utf8"),
    readFileSync(new URL("../packages/compiler/dist/pipeline.js", import.meta.url), "utf8"),
  ].join("\n")
  assert.doesNotMatch(sources, /(?:^|[\\"'])(?:react|vue)(?:[-/][^\\"']*)?[\\"']/i)
})

test("compiler diagnostics and Vite adapter stay isolated from the public barrel", () => {
  assert.equal(typeof diagnostics.diagnoseMunSource, "function")
  assert.equal(typeof vite.createMunVitePlugin, "function")
  const sources = [
    readFileSync(new URL("../packages/compiler/dist/diagnostics.js", import.meta.url), "utf8"),
    readFileSync(new URL("../packages/compiler/dist/vite.js", import.meta.url), "utf8"),
  ].join("\n")
  assert.doesNotMatch(sources, /(?:^|[\\"'])(?:react|vue)(?:[-/][^\\"']*)?[\\"']/i)
})

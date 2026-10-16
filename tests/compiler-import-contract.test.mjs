import assert from "node:assert/strict"
import test from "node:test"
import { transformMunSource } from "../packages/compiler/dist/index.js"
import * as core from "../packages/core/dist/compat.js"

function execute(output, bindings) {
  const match = /^import \{ ([^}]+) \} from "@mun\/core\/compat"\n/.exec(output)
  assert.ok(match, "lowering must make generated runtime names resolvable")
  const names = match[1].split(", ")
  assert.equal(new Set(names).size, names.length)
  return Function(...names, ...Object.keys(bindings), output.slice(match[0].length))(
    ...names.map(name => { assert.ok(name in core); return core[name] }), ...Object.values(bindings),
  )
}

test("lowered animation modules execute without ambient Animation/withAnimation globals", () => {
  const expanded = { value: false }
  execute(transformMunSource('withAnimation(.spring(response: 0.4, dampingFraction: 0.8)) { expanded.value = true }', "Imports.mun.ts"), { expanded })
  assert.equal(expanded.value, true)
  let transition
  const text = { contentTransition(value) { transition = value; return this }, animation(value) { assert.ok(value instanceof core.Animation); return this } }
  execute(transformMunSource('Text(String(count)).contentTransition(.numericText(value: count)).animation(.easeInOut, value: count)', "Imports.mun.ts"), { Text: () => text, count: 3 })
  assert.ok(transition)
})

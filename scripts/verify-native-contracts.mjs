// Cross-platform source contracts: never trust checked-in generated fixtures.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
const directory = mkdtempSync(resolve(tmpdir(), 'mun-contracts-'))
function run(command, args, env = process.env) {
  const result = spawnSync(command, args, { stdio: 'inherit', env, timeout: 300_000 })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(`${command} exited ${result.status}`)
}
try {
  for (const [source, suite, variable] of [
    ['NativeProductionSmoke', 'compiler_contract', 'MUN_COMPILER_CONTRACT_IR'],
    ['NativeDemo', 'compiler_contract', 'MUN_COMPILER_CONTRACT_IR'],
    ['NativeControlsStyle', 'native_controls_style', 'MUN_NATIVE_CONTROLS_IR'],
    ['NativeLayoutStyle', 'native_layout_style', 'MUN_NATIVE_UI_IR'],
  ]) {
    const path = resolve(directory, `${source}.json`)
    run(process.execPath, ['bin/mun.mjs', 'compile', `examples/${source}.mun`, path])
    run('cargo', ['test', '--manifest-path', 'native/Cargo.toml', '--locked', '-p', 'mun-runtime', '--test', suite, '--', '--ignored'], { ...process.env, [variable]: path })
  }
} finally { rmSync(directory, { recursive: true, force: true }) }

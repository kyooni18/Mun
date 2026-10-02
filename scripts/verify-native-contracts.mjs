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
    ['NativeSettingsPane', 'native_settings_pane', 'MUN_NATIVE_SETTINGS_IR'],
  ]) {
    const path = resolve(directory, `${source}.json`)
    const test = (name, env, filter) => run('cargo', ['test', '--manifest-path', 'native/Cargo.toml', '--locked', '-p', 'mun-runtime', '--test', name, '--', '--ignored', ...filter], { ...process.env, ...env })
    run(process.execPath, ['bin/mun.mjs', 'compile', `examples/${source}.mun`, path])
    test(suite, { [variable]: path }, suite === 'compiler_contract' ? ['compiler_output_deserializes_into_native_runtime'] : [])
    if (source === 'NativeProductionSmoke') {
      test('compiler_contract', { MUN_KEYED_CONTRACT_IR: path }, ['compiled_keyed_rows_keep_state_by_key'])
    }
  }
} finally { rmSync(directory, { recursive: true, force: true }) }

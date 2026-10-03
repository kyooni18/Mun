// Hot-reload latency benchmark.
//
//   node scripts/benchmark-hot-reload.mjs [--edits N] [--compile-only | --window] [--spacing MS] [--host <mun-native>] [--keep DIR] [--json]
//
// For each case a throwaway project is generated and every edit is compiled
// with the same incremental project compiler `mun dev` uses, then diffed into
// the exact update message `mun dev` would send.
//
//   default         Headless: the recorded update stream is replayed through
//                   `mun-native --dev-replay`, which applies each update with the
//                   dev host's own code path and renders one offscreen frame
//                   through the production renderer (waiting for the GPU). No
//                   window opens.
//   --window        A real windowed dev host over the loopback dev link; adds
//                   the transport round trip and first-presented-frame timings
//                   (`update-presented`). Opens a window; needs a display.
//   --compile-only  Toolchain side only.
//
// --spacing MS (window mode) waits MS after each update is presented before
// sending the next, measuring an idle app like a person saving edits; with the
// default 0, edits arrive back to back and queue behind the previous frame.
//
// --keep DIR (headless) copies each case's initial IR and update stream to
// DIR/<case>.initial.json and DIR/<case>.updates.ndjson for profiling the
// replay outside the script.
//
// All numbers are wall-clock p50 / p95 / max over N edits. Not measured: the
// file watcher/debounce (80 ms by design) and display scan-out after present.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { analyzeCompatibility } from '../bin/hot-reload.mjs'
import { createProgramUpdate } from '../bin/program-patch.mjs'
import { listenForHost } from '../bin/dev-protocol.mjs'
import { createProjectCompiler, discoverProject } from '../bin/project.mjs'
import { stopChild } from '../bin/watch.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)
const option = name => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined }
const edits = Number(option('--edits') ?? 30)
if (!Number.isSafeInteger(edits) || edits < 1 || edits > 10000) throw new Error('--edits must be an integer between 1 and 10000')
const mode = args.includes('--compile-only') ? 'compile' : args.includes('--window') ? 'window' : 'headless'
const asJson = args.includes('--json')
const keep = option('--keep')
const spacing = Number(option('--spacing') ?? 0)
if (!Number.isFinite(spacing) || spacing < 0 || spacing > 5000) throw new Error('--spacing must be between 0 and 5000 ms')
const executable = process.platform === 'win32' ? 'mun-native.exe' : 'mun-native'
const host = option('--host') ?? ['release', 'debug'].map(profile => resolve(root, 'native/target', profile, executable)).find(existsSync)
if (mode !== 'compile' && !host) throw new Error('No native host found: build one or pass --host <path> (or use --compile-only).')

const manifest = name => `manifest_version = 1\nname = "${name}"\nentry = "Sources/App.mun"\nidentifier = "app.mun.bench"\nversion = "1.0.0"\nminimum_mun_version = "0.0.0"\nplatforms = ["macos", "windows", "linux"]\n`
// Each case returns files for edit i; every edit is a compatible change (a
// text literal), so every iteration exercises hot_update.
const cases = {
  'small app': () => ({
    files: i => ({ 'Sources/App.mun': `@main\nstruct Small: View {\n  @State var count: Int = 0\n  var body: some View {\n    VStack(spacing: 12) {\n      Text("Hello \\(${i})")\n      Text("Count: \\(count)")\n      Button("Increase") { count += 1 }\n    }\n  }\n}\n` }),
  }),
  'medium custom-View app': () => ({
    files: i => ({
      'Sources/App.mun': `@main\nstruct Medium: View {\n  var body: some View {\n    VStack(spacing: 8) {\n      Text("Revision ${i}")\n${Array.from({ length: 25 }, (_, n) => `      Card${n}()`).join('\n')}\n    }\n  }\n}\n`,
      'Sources/Cards.mun': Array.from({ length: 25 }, (_, n) => `struct Card${n}: View {\n  @State var on: Bool = false\n  var body: some View {\n    HStack(spacing: 6) {\n      Button("Toggle ${n}") { on.toggle() }\n      Text(on ? "on" : "off")\n    }\n  }\n}\n`).join('\n'),
    }),
  }),
  '1,000-row keyed list': () => ({
    files: i => ({
      'Sources/App.mun': `@main\nstruct Big: View {\n  @State var rows: [Task] = [\n${Array.from({ length: 1000 }, (_, n) => `    { id: "r${n}", title: "Row ${n}" }`).join(',\n')}\n  ]\n  var body: some View {\n    ScrollView() {\n      VStack(spacing: 2) {\n        Text("Revision ${i}")\n        ForEach(rows, id: \\.id) { item in\n          RowView(item: item)\n        }\n      }\n    }\n  }\n}\n\nstruct RowView: View {\n  var item: Task\n  @State var on: Bool = false\n  var body: some View {\n    HStack(spacing: 6) {\n      Button("Toggle") { on.toggle() }\n      Text(item.title)\n    }\n  }\n}\n`,
    }),
  }),
  'cross-file edit': () => ({
    files: i => ({
      'Sources/App.mun': `@main\nstruct Cross: View {\n  var body: some View {\n    VStack {\n      Header()\n      Footer()\n    }\n  }\n}\n`,
      'Sources/Header.mun': `struct Header: View {\n  var body: some View { Text("Header ${i}") }\n}\n`,
      'Sources/Footer.mun': `struct Footer: View {\n  @State var count: Int = 0\n  var body: some View {\n    VStack {\n      Text("Footer \\(count)")\n      Button("Increase") { count += 1 }\n    }\n  }\n}\n`,
    }),
  }),
}

const percentile = (values, p) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.floor(values.length * p))]
const stat = values => values.length ? { p50: percentile(values, 0.5), p95: percentile(values, 0.95), max: Math.max(...values) } : undefined
const fmt = s => s ? `p50 ${s.p50.toFixed(2)} / p95 ${s.p95.toFixed(2)} / max ${s.max.toFixed(2)} ms` : 'n/a'
const ms = micros => micros / 1000
// Structural per-frame counters: retained layout nodes invalidated (of all
// live), primitives culled, forEach expansions reused.
const frameWork = frames => {
  const pick = key => distinct(frames.map(frame => frame[key]).filter(value => value !== undefined))
  return `layout invalidated ${pick('layoutInvalidated')} of ${pick('layoutNodes')} nodes; culled ${pick('culledPrimitives')} primitives${frames.some(frame => 'reusedForEach' in frame) ? `; forEach reused ${pick('reusedForEach')}` : ''}`
}
const distinct = values => { const set = [...new Set(values)]; return set.length === 1 ? `${set[0]} (every edit)` : values.join(', ') }
const written = new Map()
const write = (directory, files) => { for (const [path, source] of Object.entries(files)) { const full = resolve(directory, path); if (written.get(full) === source) continue; mkdirSync(dirname(full), { recursive: true }); writeFileSync(full, source); written.set(full, source) } }

async function launchWindow(directory, program, onEvent) {
  const listener = await listenForHost({ irVersion: program.version, onEvent })
  const ir = resolve(directory, 'program.mun.ir.json')
  writeFileSync(ir, JSON.stringify(program))
  const child = spawn(host, ['--dev', ir], { cwd: directory, env: { ...process.env, MUN_DEV_ENDPOINT: listener.endpoint, MUN_DEV_TOKEN: listener.token }, stdio: 'ignore' })
  let timer
  try {
    const channel = await Promise.race([listener.connection, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('host did not connect in 30 s')), 30000) })])
    return { child, listener, channel }
  } finally { clearTimeout(timer) }
}

async function runCase(name, build) {
  const directory = mkdtempSync(resolve(tmpdir(), 'mun-bench-'))
  let session
  try {
    const spec = build()
    writeFileSync(resolve(directory, 'mun.toml'), manifest('Bench'))
    write(directory, spec.files(0))
    const compiler = createProjectCompiler(discoverProject(directory))
    const initial = compiler.compile()
    const presented = new Map()
    if (mode === 'window') {
      session = await launchWindow(directory, initial.program, message => { if (message.type === 'update-presented') presented.set(message.revision, message) })
    }
    const toolchain = { compile: [], diff: [], roundTrip: [] }
    const counts = { relowered: [], instances: [], affected: [], reparsed: [], rechecked: [], modes: [], wireKiB: [], fullKiB: [] }
    const lines = []
    const perEdit = []
    let running = initial, revision = 0
    for (let i = 1; i <= edits; i++) {
      write(directory, spec.files(i))
      let started = performance.now()
      const next = compiler.compile()
      toolchain.compile.push(performance.now() - started)
      const analysis = analyzeCompatibility(running, next)
      if (analysis.mode !== 'hot') throw new Error(`${name}: edit ${i} unexpectedly needs a restart: ${analysis.reason}`)
      started = performance.now()
      const update = createProgramUpdate(running.program, next.program, { baseRevision: revision, revision: revision + 1, preserve: analysis.preserve })
      const line = JSON.stringify({ type: update.type, ...update.payload })
      toolchain.diff.push(performance.now() - started)
      lines.push(line)
      if (session) {
        started = performance.now()
        const reply = await session.channel.request(update.type, update.payload)
        if (reply.type !== 'update-applied' || reply.revision !== revision + 1) throw new Error(`${name}: edit ${i} not applied: ${reply.message ?? reply.type}`)
        toolchain.roundTrip.push(performance.now() - started)
        if (spacing) await new Promise(resolve => setTimeout(resolve, spacing))
        perEdit.push({ edit: i, roundTripMs: toolchain.roundTrip.at(-1), queueMs: (reply.timings?.queueMicros ?? 0) / 1000, applyMs: (reply.applyMicros ?? 0) / 1000 })
      }
      revision += 1
      const stats = next.stats
      counts.relowered.push(stats.viewDeclarationsRelowered)
      counts.instances.push(`${stats.viewInstancesLowered}/${stats.viewInstancesReused}`)
      counts.affected.push(stats.affectedViews?.length)
      counts.reparsed.push(stats.declarationsReparsed)
      counts.rechecked.push(stats.declarationsRechecked)
      counts.modes.push(update.type)
      counts.wireKiB.push(update.bytes / 1024)
      counts.fullKiB.push(update.fullBytes / 1024)
      running = next
    }

    const stages = {}
    // The first update can arrive while the host is still creating its window
    // and rendering its first frame; it queues behind that startup work. Report
    // it separately so steady-state percentiles describe an already-running app.
    const first = perEdit[0]
    if (first) {
      toolchain.roundTrip = toolchain.roundTrip.slice(1)
      stages.firstUpdateAfterLaunchMs = Number(first.roundTripMs.toFixed(1))
      stages.firstUpdateHostQueueMs = Number(first.queueMs.toFixed(1))
    }
    if (mode === 'headless') {
      const ir = resolve(directory, 'initial.json'), stream = resolve(directory, 'updates.ndjson')
      writeFileSync(ir, JSON.stringify(initial.program))
      writeFileSync(stream, `${lines.join('\n')}\n`)
      if (keep) {
        const slug = name.replace(/[^a-z0-9]+/gi, '-').replace(/^-|-$/g, '').toLowerCase()
        mkdirSync(keep, { recursive: true })
        writeFileSync(resolve(keep, `${slug}.initial.json`), JSON.stringify(initial.program))
        writeFileSync(resolve(keep, `${slug}.updates.ndjson`), `${lines.join('\n')}\n`)
      }
      const replay = spawnSync(host, ['--dev-replay', ir, stream], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      if (replay.status !== 0) throw new Error(`${name}: --dev-replay failed: ${replay.stderr}`)
      const report = JSON.parse(replay.stdout)
      const pick = path => report.updates.map(item => ms(path(item)))
      Object.assign(stages, {
        decode: pick(item => item.update.decodeMicros),
        patch: pick(item => item.update.patchMicros),
        load: pick(item => item.update.loadMicros),
        materialize: pick(item => item.update.materializeMicros),
        reconcile: pick(item => item.update.reconcileMicros),
        layout: pick(item => item.frame.layoutMicros),
        prepare: pick(item => item.frame.prepareMicros),
        submit: pick(item => item.frame.submitMicros),
        gpu: pick(item => item.frame.gpuMicros),
        total: pick(item => item.totalMicros),
      })
      stages.retainedNodes = report.retainedNodes
      stages.frameWork = frameWork(report.updates.map(item => item.frame))
    } else if (mode === 'window') {
      const deadline = Date.now() + 5000
      while (presented.size < edits && Date.now() < deadline) await new Promise(r => setTimeout(r, 20))
      const items = [...presented.values()].filter(item => item.revision > 1)
      const pick = path => items.map(item => ms(path(item)))
      Object.assign(stages, {
        receiveToPresent: pick(item => item.receiveToPresentMicros),
        layout: pick(item => item.frame.layoutMicros),
        prepare: pick(item => item.frame.prepareMicros),
        acquire: pick(item => item.frame.acquireMicros),
        submit: pick(item => item.frame.submitMicros),
        present: pick(item => item.frame.presentMicros),
      })
      stages.firstUpdateReceiveToPresentMs = Number(ms(presented.get(1)?.receiveToPresentMicros ?? 0).toFixed(1))
      stages.frameWork = frameWork(items.map(item => item.frame))
      stages.presentedUpdates = items.length
      stages.skippedFrames = items.reduce((sum, item) => sum + item.skippedFrames, 0)
      stages.superseded = items.reduce((sum, item) => sum + item.supersededRevisions, 0)
    }

    const result = {
      case: name,
      mode,
      toolchain: Object.fromEntries(Object.entries(toolchain).filter(([, v]) => v.length).map(([k, v]) => [k, stat(v)])),
      host: Object.fromEntries(Object.entries(stages).map(([k, v]) => [k, Array.isArray(v) ? stat(v) : v])),
      counts: {
        viewDeclarationsRelowered: distinct(counts.relowered),
        viewInstancesLoweredReused: distinct(counts.instances),
        affectedViews: distinct(counts.affected),
        declarationsReparsed: distinct(counts.reparsed),
        declarationsRechecked: distinct(counts.rechecked),
        updateModes: distinct(counts.modes),
        wireKiB: counts.wireKiB.at(-1),
        fullIrKiB: counts.fullKiB.at(-1),
      },
    }
    if (perEdit.length) result.perEdit = perEdit
    if (asJson) { console.log(JSON.stringify(result)); return }
    console.log(name)
    for (const [key, value] of Object.entries(result.toolchain)) console.log(`  toolchain ${key.padEnd(18)} ${fmt(value)}`)
    for (const [key, value] of Object.entries(result.host)) console.log(`  host ${key.padEnd(30)} ${typeof value === 'object' ? fmt(value) : value}`)
    const c = result.counts
    if (perEdit.length) {
      const slow = [...perEdit].sort((a, b) => b.roundTripMs - a.roundTripMs).slice(0, 3)
      console.log(`  slowest round trips: ${slow.map(item => `edit ${item.edit}: ${item.roundTripMs.toFixed(1)} ms (host queue ${item.queueMs.toFixed(2)}, apply ${item.applyMs.toFixed(2)})`).join('; ')}`)
    }
    console.log(`  update ${c.updateModes}; wire ${c.wireKiB.toFixed(1)} KiB of ${c.fullIrKiB.toFixed(1)} KiB full IR`)
    console.log(`  per edit: declarations reparsed ${c.declarationsReparsed}, rechecked ${c.declarationsRechecked}; Views relowered ${c.viewDeclarationsRelowered}; instances lowered/reused ${c.viewInstancesLoweredReused}; affected ${c.affectedViews}`)
  } finally {
    if (session) { session.channel.close(); session.listener.close(); await stopChild(session.child) }
    rmSync(directory, { recursive: true, force: true })
    for (const path of written.keys()) if (path.startsWith(directory)) written.delete(path)
  }
}

if (!asJson) console.log(`Hot-reload benchmark: ${edits} edits per case, ${mode}${mode === 'compile' ? '' : ` (host ${host})`}, ${process.platform}-${process.arch}`)
const only = option('--case')
for (const [name, build] of Object.entries(cases)) if (!only || name === only) await runCase(name, build)

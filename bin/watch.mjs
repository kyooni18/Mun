import { watch } from 'node:fs'
import { resolve } from 'node:path'
import { discoverProject, compileProject, requirePlatform } from './project.mjs'
import { launchProgram } from './workflow.mjs'

// Injectable scheduler and effects make races testable without wall-clock sleeps.
export function createDevLoop({ compile, launch, stop, report = () => {}, schedule = callback => setTimeout(callback, 80), cancel = clearTimeout }) {
  let timer, running, busy = false, pending = false, closed = false
  const idleWaiters = []
  async function rebuild() {
    if (closed) return
    if (busy) { pending = true; return }
    busy = true
    try {
      const program = await compile()
      if (closed) return
      if (running) { await stop(running); running = undefined }
      if (!closed) { running = await launch(program); report('Relaunched native app (state reset).') }
    } catch (error) { report(error.message) }
    finally {
      busy = false
      for (const resolve of idleWaiters.splice(0)) resolve()
      if (pending && !closed) { pending = false; changed() }
    }
  }
  function changed() {
    if (closed) return
    if (timer !== undefined) cancel(timer)
    timer = schedule(() => { timer = undefined; void rebuild() })
  }
  async function close() {
    closed = true
    if (timer !== undefined) cancel(timer)
    // Wait until an in-flight launch settles, then stop its process.
    if (busy) await new Promise(resolve => idleWaiters.push(resolve))
    if (running) { await stop(running); running = undefined }
  }
  return { changed, rebuild, close }
}

export function stopChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve()
  return new Promise(resolve => {
    const timer = setTimeout(() => child.kill('SIGKILL'), 2000)
    child.once('close', () => { clearTimeout(timer); resolve() })
    child.kill('SIGTERM')
  })
}

export async function develop(project, { env, verbose = false }) {
  requirePlatform(project)
  const loop = createDevLoop({
    compile: () => {
      const start = performance.now()
      project = discoverProject(project.root)
      requirePlatform(project)
      const program = compileProject(project)
      if (verbose) console.log(`Compile + IR: ${(performance.now() - start).toFixed(1)}ms`)
      return program
    },
    launch: program => {
      const child = launchProgram(project, program, env)
      return new Promise((resolve, reject) => { child.once('spawn', () => resolve(child)); child.once('error', reject) })
    },
    stop: stopChild,
    report: message => console.log(message),
  })
  console.log('Mün dev: recompilation + fast relaunch; not state-preserving hot reload. Ctrl-C to stop.')
  const watcher = watch(project.root, { recursive: true }, (_, path) => {
    if (!path || path.split(/[\\/]/u).some(part => part.startsWith('.') || ['node_modules', 'build', 'dist'].includes(part))) return
    if (path.endsWith('.mun') || path === 'mun.toml' || path === 'mun.local.json') {
      if (verbose) console.log(`Changed: ${resolve(project.root, path)}`)
      loop.changed()
    }
  })
  watcher.on('error', error => console.error(`Watch error: ${error.message}`))
  return new Promise(resolve => {
    let closing = false
    const close = async () => {
      if (closing) return
      closing = true
      watcher.close()
      process.removeListener('SIGINT', close); process.removeListener('SIGTERM', close)
      await loop.close()
      resolve(0)
    }
    process.once('SIGINT', close); process.once('SIGTERM', close)
    void loop.rebuild()
  })
}

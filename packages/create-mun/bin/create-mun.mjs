#!/usr/bin/env node

// `npm/pnpm create vune-ui <directory>` invokes the create-vune-ui binary with
// the directory as its first argument. Reuse the canonical CLI so both entry
// points always scaffold the same project.
process.argv = [
  process.argv[0],
  process.argv[1],
  'create',
  ...process.argv.slice(2),
]

let cliSpecifier
try {
  cliSpecifier = import.meta.resolve('vune-ui/cli')
} catch {
  // Allows the workspace source package to be exercised before pnpm creates
  // its node_modules link. Published packages resolve the dependency above.
  cliSpecifier = new URL('../../../bin/vune-ui.mjs', import.meta.url).href
}

await import(cliSpecifier)

import { performance } from 'node:perf_hooks'
import { createElement } from 'react'
import { Text, VStack, modifiedContent } from '../packages/core/dist/index.js'

const ci = process.env.MUN_BENCH_CI === '1'
const defaultCounts = process.env.MUN_BENCH_CI === '1' ? [100, 1000] : [100, 1000, 10000]
const itemCounts = (process.env.MUN_BENCH_ITEMS ?? defaultCounts.join(','))
  .split(',')
  .map(value => Number(value.trim()))
  .filter(value => Number.isFinite(value) && value > 0)
const depths = [1, 5, 10, 20]
const rounds = Number(process.env.MUN_BENCH_ROUNDS ?? (process.env.MUN_BENCH_CI === '1' ? 2 : 5))
const maxRatio = Number(process.env.MUN_BENCH_MAX_RATIO)
const baseRatio = Number(process.env.MUN_BENCH_BASE_RATIO ?? (Number.isFinite(maxRatio) ? maxRatio : Number.NaN))
const depthRatio = Number(process.env.MUN_BENCH_DEPTH_RATIO ?? 0)
const flatRatio = Number(process.env.MUN_BENCH_FLAT_RATIO ?? 1.5)
const results = []

function measure(name, itemCount, factory) {
  const samples = []
  for (let round = 0; round < rounds; round += 1) {
    const start = performance.now()
    factory()
    samples.push(performance.now() - start)
  }
  const average = samples.reduce((sum, sample) => sum + sample, 0) / samples.length
  results.push({ name, itemCount, average })
  console.log(`${name}: ${average.toFixed(2)} ms (${itemCount} items, ${rounds} rounds)`)
  return average
}

const modifierSteps = [
  element => element.padding(2),
  element => element.margin(1),
  element => element.background('Canvas'),
  element => element.foreground('CanvasText'),
  element => element.fontSize(14),
  element => element.bold(),
  element => element.style({ lineHeight: 1.2 }),
  element => element.className('bench'),
  element => element.withProps({ 'data-bench': true }),
  element => element.keyed('bench'),
]

const rawStyle = {
  padding: '2px',
  margin: '1px',
  background: 'Canvas',
  color: 'CanvasText',
  borderRadius: '4px',
  opacity: 0.99,
  fontSize: '14px',
  fontWeight: 500,
  lineHeight: 1.2,
  textAlign: 'left',
  flexGrow: 1,
  flexShrink: 1,
  flex: '0 1 auto',
  flexWrap: 'nowrap',
  order: 0,
  alignItems: 'stretch',
  justifyContent: 'flex-start',
  position: 'relative',
  overflow: 'visible',
  cursor: 'default',
}

const modifierRecords = [
  { name: 'padding', arguments: [2] },
  { name: 'margin', arguments: [1] },
  { name: 'background', arguments: ['Canvas'] },
  { name: 'foreground', arguments: ['CanvasText'] },
  { name: 'fontSize', arguments: [14] },
  { name: 'bold', arguments: [] },
  { name: 'style', arguments: [{ lineHeight: 1.2 }] },
  { name: 'className', arguments: ['bench'] },
  { name: 'withProps', arguments: [{ 'data-bench': true }] },
  { name: 'keyed', arguments: ['bench'] },
]

for (const itemCount of itemCounts) {
  const raw = measure('raw React style', itemCount, () => {
    VStack(...Array.from({ length: itemCount }, (_, index) => createElement('span', {
      key: index,
      style: rawStyle,
    }, String(index))))
  })

  for (const depth of depths) {
    const average = measure(`Mun modifier chain depth ${depth}`, itemCount, () => {
      VStack(...Array.from({ length: itemCount }, (_, index) => {
        let element = Text(String(index))
        for (let step = 0; step < depth; step += 1) element = modifierSteps[step % modifierSteps.length](element)
        return element
      }))
    })
    if (Number.isFinite(baseRatio)) {
      const ratio = average / Math.max(raw, 0.001)
      const budget = baseRatio + depthRatio * depth
      if (ratio > budget) {
        throw new Error(`Mun modifier chain exceeded ${budget}x at ${itemCount} items and depth ${depth}: ${ratio.toFixed(2)}x`)
      }
    }
  }

  const chained = measure('Mun chained modifier construction', itemCount, () => {
    for (let index = 0; index < itemCount; index += 1) {
      let element = Text(String(index))
      for (const step of modifierSteps) element = step(element)
    }
  })
  const flat = measure('Mun flat modifier construction', itemCount, () => {
    for (let index = 0; index < itemCount; index += 1) {
      modifiedContent(Text(String(index)), modifierRecords)
    }
  })
  const flatResult = flat / Math.max(chained, 0.001)
  results.push({ name: 'flat modifier ratio', itemCount, average: flatResult })
  console.log(`flat modifier ratio at ${itemCount}: ${flatResult.toFixed(2)}x (budget ${flatRatio}x chained)`)
  if (ci && flatResult > flatRatio) throw new Error(`Flat modifier construction exceeded ${flatRatio}x chained: ${flatResult.toFixed(2)}x`)
}

if (results.some(result => !Number.isFinite(result.average))) {
  throw new Error('Modifier benchmark produced a non-finite measurement')
}

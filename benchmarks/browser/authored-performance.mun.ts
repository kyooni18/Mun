import { Button, Element, ForEach, State } from "@vune-ui/core"

let benchmarkCount = 5000
let benchmarkMiddle = 2500

export function configureAuthoredPerformance(count: number) {
  benchmarkCount = count
  benchmarkMiddle = Math.floor(count / 2)
}

function initialRows() {
  return Array.from({ length: benchmarkCount }, (_, id) => ({ id, value: String(id) }))
}

/** Production benchmark fixture written as ordinary Vune source. */
export struct AuthoredPerformanceList: View {
  @State var items: any = initialRows()

  var body: some View { Element("main", null,
    Button("Single") {
      items.value = items.value.map((item, index) => index === benchmarkMiddle
        ? ({ ...item, value: `next-${index}` })
        : item)
    },
    Button("Full") {
      items.value = items.value.map((item, index) => ({ ...item, value: `next-${index}` }))
    },
    ForEach(items.value, item => item.id, item => Element("span", { "data-row": item.id }, item.value)),
  ) }
}

import { Binding, Button, Element, ForEach, Grid, LazyVStack, ProgressView, State, Text, TextField, Toggle, VStack } from "vune-ui"
import { view } from "@vune-ui/react"

type ShowcaseItem = { id: string; title: string; detail: string }

const query = State("")
const enabled = State(true)
const loading = State(false)
const refreshes = State(0)
const items = State<ShowcaseItem[]>([
  { id: "compiler", title: "Compiler", detail: "AST lowering and source maps" },
  { id: "runtime", title: "Runtime", detail: "State and View identity" },
  { id: "renderer", title: "Renderer", detail: "React, Vue, and Web parity" },
  { id: "tooling", title: "Tooling", detail: "Vite and editor integration" },
])

struct MetricCard: View {
  let label: string
  let value: string
  init(_ label: string, value: string) {
    self.label = label
    self.value = value
  }
  var body: some View {
    VStack(spacing: 4) {
      Text(label).className("showcase-metric-label")
      Text(value).className("showcase-metric-value")
    }.className("showcase-metric")
  }
}

export default view(() => VStack(spacing: 18) {
  const normalizedQuery = query.value.trim().toLowerCase()
  const filtered = normalizedQuery
    ? items.value.filter(item => `${item.title} ${item.detail}`.toLowerCase().includes(normalizedQuery))
    : items.value
  const refreshLabel = loading.value ? "Refreshing…" : "Refresh"

  <header class="showcase-hero" data-testid="showcase-hero">
    <span class="showcase-kicker">VUNE SHOWCASE</span>
  </header>

  Text("Framework health dashboard")
    .className("showcase-title")
  Text("A medium-sized Vune app exercising state, builders, collections, modifiers, HTML, and async actions.")
    .className("showcase-subtitle")

  Grid({ columns: 3 }) {
    MetricCard("Visible", value: String(filtered.length))
    MetricCard("Refreshes", value: String(refreshes.value))
    MetricCard("Mode", value: enabled.value ? "Enabled" : "Paused")
  }.className("showcase-metrics")

  VStack(spacing: 10) {
    TextField(Binding(query), "Filter modules")
      .withProps({ "aria-label": "Filter modules", "data-testid": "showcase-filter" })
      .className("showcase-input")
    Toggle("Enable live updates", Binding(enabled))
      .withProps({ "data-testid": "showcase-enabled" })
  }.className("showcase-controls")

  Grid({ columns: 2 }) {
    Button(refreshLabel) {
      if (!loading.value) {
        loading.value = true
        setTimeout(() => {
          refreshes.value += 1
          loading.value = false
        }, 20)
      }
    }
    Button("Reorder") {
      items.value = [...items.value.slice(1), items.value[0]]
    }
  }.className("showcase-actions")

  ProgressView(loading.value ? 0.5 : 1, { max: 1 })
    .withProps({ "aria-label": "Refresh progress", "data-testid": "showcase-progress" })

  LazyVStack({ alignment: "leading", spacing: 8, estimatedItemSize: 56, overscan: 2 }) {
    ForEach(filtered, key: (item) => item.id) { item in
      Element("article", { className: "showcase-row", "data-row": item.id },
        Text(item.title).className("showcase-row-title"),
        Text(item.detail).className("showcase-row-detail")
      )
    }
  }.withProps({ "data-testid": "showcase-list" })
}
  .className("showcase-page")
  .withProps({ "data-testid": "showcase-root" }))

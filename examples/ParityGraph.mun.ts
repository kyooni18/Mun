import { Binding, Button, Element, ForEach, GeometryReader, LazyVStack, State, Text, TextField, Toggle, VStack, defineView, initializer } from "vune-ui"

const count = State(0)
const name = State("Vune")
const enabled = State(false)
const items = State([{ id: "a" }, { id: "b" }])

const ParityRow = defineView("ParityRow", {
  initializers: [initializer("ParityRow(id)", args => args.length === 1, args => ({ id: args[0] }))],
  state: () => ({ taps: State(0) }),
  body: ({ id, taps }) => Element("button", { "data-row": id, onclick: () => { taps.value += 1 } }, `${id}:${taps.value}`),
})

const ParityGraph = defineView("ParityGraph", {
  initializers: [initializer("ParityGraph()", args => args.length === 0)],
  body: () => VStack(
    Text(`Count: ${count.value}`).withProps({ "data-testid": "count" }),
    Button("Increment") { count.value += 1 },
    TextField(Binding(name), "Name").withProps({ "aria-label": "Name", "data-testid": "name" }),
    Toggle("Enabled", Binding(enabled)).withProps({ "data-testid": "enabled" }),
  Button("Reorder") { items.value = [items.value[1], items.value[0]] },
  ForEach(items.value) { item in
    ParityRow(item.id)
    },
    Element("x-vune-parity", { "data-testid": "custom-element" }, Text("Custom")),
    GeometryReader() { geometry in
      Text(`${geometry.size.width}`).withProps({ "data-testid": "geometry" })
    },
    LazyVStack() {
      Text("Lazy content").withProps({ "data-testid": "lazy-content" })
    },
  ).withProps({ "data-testid": "parity-root" }),
})

export default ParityGraph

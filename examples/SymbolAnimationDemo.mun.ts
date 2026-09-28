import {
  Animation,
  Button,
  HStack,
  Image,
  State,
  Text,
  VStack,
  VectorSymbol,
} from "vune-ui"
import { Pause, Play, Volume2, VolumeX } from "@lucide/icons"

const phase = State(false)
const count = State(98)

const play = VectorSymbol.fromLucide(Play)
const pause = VectorSymbol.fromLucide(Pause)
const volume = VectorSymbol.fromLucide(Volume2)
const muted = VectorSymbol.fromLucide(VolumeX)

const customSearch = VectorSymbol.fromSVGNodes([
  ["circle", { cx: 11, cy: 11, r: 6.5, fill: "none", stroke: "currentColor", "stroke-width": 2 }],
  ["line", { x1: 16, y1: 16, x2: 21, y2: 21, stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round" }],
], { name: "custom.search", viewBox: "0 0 24 24" })

const customClose = VectorSymbol.fromSVGNodes([
  ["line", { x1: 5, y1: 5, x2: 19, y2: 19, stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round" }],
  ["line", { x1: 19, y1: 5, x2: 5, y2: 19, stroke: "currentColor", "stroke-width": 2, "stroke-linecap": "round" }],
], { name: "custom.close", viewBox: "0 0 24 24" })

function toggleDemo() {
  phase.value = !phase.value
  count.value = count.value >= 102 ? 98 : count.value + 1
}

if (!new URLSearchParams(globalThis.location?.search ?? "").has("manual")) {
  setInterval(toggleDemo, 1400)
}

struct SymbolAnimationDemo: View {
  var body: some View {
    VStack() {
      VStack() {
        Text("Vune Symbol Animation")
          .className("symbol-demo-title")
        Text("Real icon-pack geometry, spring topology morphing, custom SVGs, and richer text transitions")
          .className("symbol-demo-subtitle")
      }.className("symbol-demo-heading")

      HStack() {
        VStack() {
          Text("Lucide Play ↔ Pause")
            .className("symbol-demo-label")
          Image(phase.value ? pause : play, { alt: phase.value ? "Pause" : "Play" })
            .className("symbol-demo-icon")
            .contentTransition(.symbolEffect(.automatic))
            .animation(Animation.spring(0.48, 0.7), phase.value)
          Text("@lucide/icons · topology split")
            .className("symbol-demo-code")
        }.className("symbol-demo-card")

        VStack() {
          Text("Lucide Volume ↔ Mute")
            .className("symbol-demo-label")
          Image(phase.value ? muted : volume, { alt: phase.value ? "Muted" : "Volume" })
            .className("symbol-demo-icon")
            .contentTransition(.symbolEffect(.magicReplace(fallback: .downUp)))
            .animation(Animation.spring(0.5, 0.72), phase.value)
          Text("@lucide/icons · full geometry morph")
            .className("symbol-demo-code")
        }.className("symbol-demo-card")
      }.className("symbol-demo-row")

      HStack() {
        VStack() {
          Text("Custom SVG nodes")
            .className("symbol-demo-label")
          Image(phase.value ? customClose : customSearch, { alt: phase.value ? "Close" : "Search" })
            .className("symbol-demo-icon")
            .contentTransition(.symbolEffect(.magicReplace(fallback: .opacity)))
            .animation(Animation.spring(0.46, 0.74), phase.value)
          Text("circle/line → normalized paths")
            .className("symbol-demo-code")
        }.className("symbol-demo-card")

        VStack() {
          Text("Text interpolate")
            .className("symbol-demo-label")
          Text(phase.value ? "Connected" : "Connecting")
            .className("symbol-demo-text-value")
            .contentTransition(.interpolate)
            .animation(Animation.spring(0.42, 0.78), phase.value)
          Text("grapheme matching + spring motion")
            .className("symbol-demo-code")
        }.className("symbol-demo-card")
      }.className("symbol-demo-row")

      HStack() {
        VStack() {
          Text("Blur replace")
            .className("symbol-demo-label")
          Text(phase.value ? "Ready" : "Loading")
            .className("symbol-demo-text-value")
            .contentTransition(.blurReplace(radius: 9))
            .animation(Animation.spring(0.46, 0.8), phase.value)
          Text("blur + crossfade + settle")
            .className("symbol-demo-code")
        }.className("symbol-demo-card")

        VStack() {
          Text("Directional push")
            .className("symbol-demo-label")
          Text(phase.value ? "Following" : "Follow")
            .className("symbol-demo-text-value")
            .contentTransition(.push(from: .trailing))
            .animation(Animation.spring(0.4, 0.76), phase.value)
          Text("leading/trailing/up/down")
            .className("symbol-demo-code")
        }.className("symbol-demo-card")
      }.className("symbol-demo-row")

      HStack() {
        VStack() {
          Text("Scale replace")
            .className("symbol-demo-label")
          Text(phase.value ? "Sent" : "Send")
            .className("symbol-demo-text-value")
            .contentTransition(.scale(scale: 0.82))
            .animation(Animation.spring(0.38, 0.7), phase.value)
          Text("scale + opacity spring")
            .className("symbol-demo-code")
        }.className("symbol-demo-card")

        VStack() {
          Text("Numeric text")
            .className("symbol-demo-label")
          Text(String(count.value))
            .className("symbol-demo-number")
            .contentTransition(.numericText(value: count.value))
            .animation(Animation.spring(0.38, 0.76), count.value)
          Text("direction-aware rolling")
            .className("symbol-demo-code")
        }.className("symbol-demo-card")
      }.className("symbol-demo-row")

      Button("Replay") {
        toggleDemo()
      }
        .className("symbol-demo-button")
        .withProps({ "data-testid": "symbol-demo-replay" })
    }
    .className("symbol-demo-shell")
    .withProps({ "data-testid": "symbol-animation-demo" })
  }
}

export default SymbolAnimationDemo()

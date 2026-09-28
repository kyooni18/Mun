import { Button, State, Text, VStack } from "vune-ui"
import { view } from "@vune-ui/react"

const count = State(0)

export default view(() => VStack(spacing: 12) {
  Text(`Count: ${count.value}`)
  Button("Increment") {
    count.value += 1
  }
})

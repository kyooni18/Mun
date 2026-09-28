import { Button, State, Text, VStack } from "vune-ui"

const count = State(0)

struct WebCounter: View {
  var body: some View {
    VStack() {
      Text(`Count: ${count.value}`).fontSize(24).bold()
      Text("This graph is rendered by the direct Web adapter.")
      Button("Increment") {
        count.value += 1
      }
    }
  }
}

export default WebCounter()

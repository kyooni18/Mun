import { Button, State, Text, VStack } from '@vune-ui/core'
import './App.css'

const count = State(0)

struct __VUNE_PROJECT_APP_NAME__: View {
  var body: some View {
    VStack(spacing: 12) {
      Text('Hello, Vune')
      Text(`Count: ${count.value}`)
      Button('Increase') { count.value += 1 }
    }
  }
}

export default __VUNE_PROJECT_APP_NAME__()

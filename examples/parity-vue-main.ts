import { createApp } from "vue"
import { MunView } from "@mun-ui/vue"
import graph from "./ParityGraph.mun"
import "./parity.css"

createApp(MunView, { render: () => graph() }).mount("#app")

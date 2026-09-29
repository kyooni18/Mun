import { createElement } from "react"
import { createRoot } from "react-dom/client"
import { view } from "@mun/react"
import graph from "./ParityGraph.mun"
import "./parity.css"

createRoot(document.getElementById("app")!).render(createElement(view(() => graph())))

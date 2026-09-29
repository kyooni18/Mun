import { mount } from "@mun/web"
import graph from "./ParityGraph.mun"
import "./parity.css"

mount(graph(), document.getElementById("app")!)

import { mount } from "@mun/web"
import App from "./App.mun"

mount(App, document.getElementById("app")!, { hydrate: true })

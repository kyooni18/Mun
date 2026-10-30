import { mount } from "@mun-ui/web"
import App from "./App.mun"

mount(App, document.getElementById("app")!, { hydrate: true })

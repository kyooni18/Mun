import { mount } from "@mun-ui/web"
import App from "./App.mun"

// Deployment boundary only: application behavior is in the Mun modules.
mount(App, document.getElementById("app")!, { hydrate: true })

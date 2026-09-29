import {
  defineView,
  initializer,
  initializerKinds,
  resolveBuilderInput,
  type ModifiableViewNode,
  type TypedViewConstructor,
  type ViewBuilderClosure,
  type ViewValue,
  viewElement,
  viewFragment,
} from "./graph.js"
import { isBinding, type BindingRef } from "./state.js"
import { Text } from "./views.js"

export interface NavigationStackProps { readonly content: ViewValue[] }
interface NavigationStackCall { (content: ViewBuilderClosure): ModifiableViewNode }
export const NavigationStack = defineView<NavigationStackProps>("NavigationStack", {
  initializers: [initializer("NavigationStack(@ViewBuilder content)", args => args.length === 1 && typeof args[0] === "function", args => ({ content: resolveBuilderInput(args[0]) }), [initializerKinds.viewBuilder(true, "content")])],
  body: ({ content }) => viewElement("main", { "data-mun": "NavigationStack" }, content),
}) as TypedViewConstructor<NavigationStackProps, NavigationStackCall>

export interface NavigationLinkProps { readonly destination: string; readonly label: ViewValue[] }
interface NavigationLinkCall {
  (destination: string, label: string): ModifiableViewNode
  (destination: string, label: ViewBuilderClosure): ModifiableViewNode
}
export const NavigationLink = defineView<NavigationLinkProps>("NavigationLink", {
  initializers: [
    initializer("NavigationLink(destination, label)", args => args.length === 2 && typeof args[0] === "string" && typeof args[1] === "string", args => ({ destination: args[0] as string, label: [Text(args[1] as string)] }), [initializerKinds.value(true, "destination", undefined, "string"), initializerKinds.value(true, "label", undefined, "string")]),
    initializer("NavigationLink(destination, @ViewBuilder label)", args => args.length === 2 && typeof args[0] === "string" && typeof args[1] === "function", args => ({ destination: args[0] as string, label: resolveBuilderInput(args[1]) }), [initializerKinds.value(true, "destination", undefined, "string"), initializerKinds.viewBuilder(true, "label")]),
  ],
  body: ({ destination, label }) => viewElement("a", { href: destination, "data-mun": "NavigationLink" }, label),
}) as TypedViewConstructor<NavigationLinkProps, NavigationLinkCall>

export interface SheetProps { readonly isPresented: BindingRef<boolean>; readonly content: ViewValue[] }
interface SheetCall { (isPresented: BindingRef<boolean>, content: ViewBuilderClosure): ModifiableViewNode }
export const Sheet = defineView<SheetProps>("Sheet", {
  initializers: [initializer("Sheet(isPresented, @ViewBuilder content)", args => args.length === 2 && isBinding(args[0]) && typeof args[1] === "function", args => ({ isPresented: args[0] as BindingRef<boolean>, content: resolveBuilderInput(args[1]) }), [initializerKinds.binding(true, "isPresented", "boolean"), initializerKinds.viewBuilder(true, "content")])],
  body: ({ isPresented, content }) => isPresented.value
    ? viewElement("dialog", {
        role: "dialog",
        "data-mun": "Sheet",
        "data-mun-presentation": "modal",
        "aria-modal": true,
        onCancel: () => { isPresented.value = false },
        onClose: () => { if (isPresented.value) isPresented.value = false },
      }, content)
    : viewFragment([]),
}) as TypedViewConstructor<SheetProps, SheetCall>

export interface AlertProps { readonly isPresented: BindingRef<boolean>; readonly title: string; readonly message?: string }
interface AlertCall { (isPresented: BindingRef<boolean>, title: string, message?: string): ModifiableViewNode }
export const Alert = defineView<AlertProps>("Alert", {
  initializers: [initializer("Alert(isPresented, title, message?)", args => args.length >= 2 && args.length <= 3 && isBinding(args[0]) && typeof args[1] === "string" && (args[2] === undefined || typeof args[2] === "string"), args => ({ isPresented: args[0] as BindingRef<boolean>, title: args[1] as string, message: args[2] as string | undefined }), [initializerKinds.binding(true, "isPresented", "boolean"), initializerKinds.value(true, "title", undefined, "string"), initializerKinds.value(false, "message", undefined, "string")])],
  body: ({ isPresented, title, message }) => isPresented.value
    ? viewElement("dialog", {
        role: "alertdialog",
        "data-mun": "Alert",
        "data-mun-presentation": "modal",
        "aria-modal": true,
        onCancel: () => { isPresented.value = false },
        onClose: () => { if (isPresented.value) isPresented.value = false },
      }, [Text(title), ...(message === undefined ? [] : [Text(message)])])
    : viewFragment([]),
}) as TypedViewConstructor<AlertProps, AlertCall>

export interface MenuProps { readonly label: string; readonly content: ViewValue[] }
interface MenuCall { (label: string, content: ViewBuilderClosure): ModifiableViewNode }
export const Menu = defineView<MenuProps>("Menu", {
  initializers: [initializer("Menu(label, @ViewBuilder content)", args => args.length === 2 && typeof args[0] === "string" && typeof args[1] === "function", args => ({ label: args[0] as string, content: resolveBuilderInput(args[1]) }), [initializerKinds.value(true, "label", undefined, "string"), initializerKinds.viewBuilder(true, "content")])],
  body: ({ label, content }) => viewElement("details", { "data-mun": "Menu" }, [Text(label), viewElement("div", { role: "menu" }, content)]),
}) as TypedViewConstructor<MenuProps, MenuCall>

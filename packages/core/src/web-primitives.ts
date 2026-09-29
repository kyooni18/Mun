import {
  defineBuiltinView,
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

function eventValue(event: unknown): string {
  const target = (event as { readonly target?: { readonly value?: unknown } } | null)?.target
  return typeof target?.value === "string" ? target.value : target?.value == null ? "" : String(target.value)
}

function eventText(event: unknown): string {
  const target = (event as { readonly currentTarget?: { readonly textContent?: unknown } } | null)?.currentTarget
  return typeof target?.textContent === "string" ? target.textContent : ""
}

export interface TextEditorProps {
  readonly text: BindingRef<string>
  readonly placeholder?: string
  readonly rows?: number
}
interface TextEditorCall { (text: BindingRef<string>, placeholder?: string, rows?: number): ModifiableViewNode }
export const TextEditor = defineBuiltinView<TextEditorProps>(
  "TextEditor",
  [initializer(
    "TextEditor(text, placeholder?, rows?)",
    args => args.length >= 1 && args.length <= 3 && isBinding(args[0]),
    args => ({ text: args[0] as BindingRef<string>, placeholder: args[1] as string | undefined, rows: args[2] as number | undefined }),
    [initializerKinds.binding(true, "text", "string"), initializerKinds.value(false, "placeholder", undefined, "string"), initializerKinds.value(false, "rows", undefined, "number")],
  )],
  ({ text, placeholder, rows }) => viewElement("textarea", {
    "data-mun": "TextEditor",
    value: text.value,
    placeholder,
    rows,
    onInput: (event: unknown) => { text.value = eventValue(event) },
  }),
) as TypedViewConstructor<TextEditorProps, TextEditorCall>

export interface FilePickerProps {
  readonly accept?: string
  readonly multiple?: boolean
  readonly disabled?: boolean
  readonly onPick: (files: unknown) => unknown
}
interface FilePickerCall { (onPick: (files: unknown) => unknown, accept?: string, multiple?: boolean): ModifiableViewNode }
export const FilePicker = defineBuiltinView<FilePickerProps>(
  "FilePicker",
  [initializer(
    "FilePicker(onPick, accept?, multiple?)",
    args => args.length >= 1 && args.length <= 3 && typeof args[0] === "function",
    args => ({ onPick: args[0] as (files: unknown) => unknown, accept: args[1] as string | undefined, multiple: args[2] as boolean | undefined }),
    [initializerKinds.action(true, "onPick", "function"), initializerKinds.value(false, "accept", undefined, "string"), initializerKinds.value(false, "multiple", undefined, "boolean")],
  )],
  ({ accept, multiple, disabled, onPick }) => viewElement("input", {
    "data-mun": "FilePicker",
    type: "file",
    accept,
    multiple,
    disabled,
    onChange: (event: unknown) => onPick((event as { readonly target?: { readonly files?: unknown } } | null)?.target?.files ?? null),
  }),
) as TypedViewConstructor<FilePickerProps, FilePickerCall>

export interface ContentEditableProps {
  readonly text: BindingRef<string>
  readonly plaintextOnly?: boolean
}
interface ContentEditableCall { (text: BindingRef<string>, plaintextOnly?: boolean): ModifiableViewNode }
export const ContentEditable = defineBuiltinView<ContentEditableProps>(
  "ContentEditable",
  [initializer(
    "ContentEditable(text, plaintextOnly?)",
    args => args.length >= 1 && args.length <= 2 && isBinding(args[0]),
    args => ({ text: args[0] as BindingRef<string>, plaintextOnly: args[1] as boolean | undefined }),
    [initializerKinds.binding(true, "text", "string"), initializerKinds.value(false, "plaintextOnly", undefined, "boolean")],
  )],
  ({ text, plaintextOnly = true }) => viewElement("div", {
    "data-mun": "ContentEditable",
    contenteditable: plaintextOnly ? "plaintext-only" : "true",
    role: "textbox",
    onInput: (event: unknown) => { text.value = eventText(event) },
  }, [text.value]),
) as TypedViewConstructor<ContentEditableProps, ContentEditableCall>

export interface CanvasProps {
  readonly width?: number
  readonly height?: number
  readonly reference?: (canvas: unknown) => void
}
interface CanvasCall { (width?: number, height?: number, reference?: (canvas: unknown) => void): ModifiableViewNode }
export const Canvas = defineBuiltinView<CanvasProps>(
  "Canvas",
  [initializer(
    "Canvas(width?, height?, reference?)",
    args => args.length <= 3,
    args => ({ width: args[0] as number | undefined, height: args[1] as number | undefined, reference: args[2] as ((canvas: unknown) => void) | undefined }),
    [initializerKinds.value(false, "width", undefined, "number"), initializerKinds.value(false, "height", undefined, "number"), initializerKinds.action(false, "reference", "function")],
  )],
  ({ width, height, reference }) => viewElement("canvas", { "data-mun": "Canvas", width, height, ref: reference }),
) as TypedViewConstructor<CanvasProps, CanvasCall>

export interface VideoProps {
  readonly src: string
  readonly controls?: boolean
  readonly autoplay?: boolean
  readonly loop?: boolean
  readonly muted?: boolean
  readonly poster?: string
}
interface VideoCall { (src: string, controls?: boolean): ModifiableViewNode }
export const Video = defineBuiltinView<VideoProps>(
  "Video",
  [initializer("Video(src, controls?)", args => args.length >= 1 && args.length <= 2 && typeof args[0] === "string", args => ({ src: args[0] as string, controls: args[1] as boolean | undefined }), [initializerKinds.value(true, "src", undefined, "string"), initializerKinds.value(false, "controls", undefined, "boolean")])],
  props => viewElement("video", { "data-mun": "Video", ...props }),
) as TypedViewConstructor<VideoProps, VideoCall>

export interface AudioProps { readonly src: string; readonly controls?: boolean; readonly autoplay?: boolean; readonly loop?: boolean; readonly muted?: boolean }
interface AudioCall { (src: string, controls?: boolean): ModifiableViewNode }
export const Audio = defineBuiltinView<AudioProps>(
  "Audio",
  [initializer("Audio(src, controls?)", args => args.length >= 1 && args.length <= 2 && typeof args[0] === "string", args => ({ src: args[0] as string, controls: args[1] as boolean | undefined }), [initializerKinds.value(true, "src", undefined, "string"), initializerKinds.value(false, "controls", undefined, "boolean")])],
  props => viewElement("audio", { "data-mun": "Audio", ...props }),
) as TypedViewConstructor<AudioProps, AudioCall>

export interface SvgProps { readonly viewBox?: string; readonly width?: number | string; readonly height?: number | string; readonly content: ViewValue[] }
interface SvgCall { (viewBox: string, content: ViewBuilderClosure): ModifiableViewNode }
export const Svg = defineBuiltinView<SvgProps>(
  "Svg",
  [initializer("Svg(viewBox, @ViewBuilder content)", args => args.length === 2 && typeof args[0] === "string" && typeof args[1] === "function", args => ({ viewBox: args[0] as string, content: resolveBuilderInput(args[1]) }), [initializerKinds.value(true, "viewBox", undefined, "string"), initializerKinds.viewBuilder(true, "content")])],
  ({ viewBox, width, height, content }) => viewElement("svg", { "data-mun": "Svg", viewBox, width, height, xmlns: "http://www.w3.org/2000/svg" }, content),
) as TypedViewConstructor<SvgProps, SvgCall>

export interface PathProps { readonly d: string; readonly fill?: string; readonly stroke?: string; readonly strokeWidth?: number | string }
interface PathCall { (d: string): ModifiableViewNode }
export const Path = defineBuiltinView<PathProps>(
  "Path",
  [initializer("Path(d)", args => args.length === 1 && typeof args[0] === "string", args => ({ d: args[0] as string }), [initializerKinds.value(true, "d", undefined, "string")])],
  props => viewElement("path", { "data-mun": "Path", ...props }),
) as TypedViewConstructor<PathProps, PathCall>

export interface FocusScopeProps { readonly content: ViewValue[]; readonly restoreFocus?: boolean }
interface FocusScopeCall { (content: ViewBuilderClosure): ModifiableViewNode }
export const FocusScope = defineBuiltinView<FocusScopeProps>(
  "FocusScope",
  [initializer("FocusScope(@ViewBuilder content)", args => args.length === 1 && typeof args[0] === "function", args => ({ content: resolveBuilderInput(args[0]) }), [initializerKinds.viewBuilder(true, "content")])],
  ({ content, restoreFocus = true }) => viewElement("div", { "data-mun": "FocusScope", "data-mun-focus-scope": restoreFocus ? "restore" : "contain" }, content),
) as TypedViewConstructor<FocusScopeProps, FocusScopeCall>

export interface PopoverProps { readonly isPresented: BindingRef<boolean>; readonly content: ViewValue[] }
interface PopoverCall { (isPresented: BindingRef<boolean>, content: ViewBuilderClosure): ModifiableViewNode }
export const Popover = defineBuiltinView<PopoverProps>(
  "Popover",
  [initializer("Popover(isPresented, @ViewBuilder content)", args => args.length === 2 && isBinding(args[0]) && typeof args[1] === "function", args => ({ isPresented: args[0] as BindingRef<boolean>, content: resolveBuilderInput(args[1]) }), [initializerKinds.binding(true, "isPresented", "boolean"), initializerKinds.viewBuilder(true, "content")])],
  ({ isPresented, content }) => isPresented.value ? viewElement("div", {
    "data-mun": "Popover",
    "data-mun-presentation": "popover",
    popover: "auto",
    role: "dialog",
    onToggle: (event: { newState?: string }) => { if (event.newState === "closed" && isPresented.value) isPresented.value = false },
  }, content) : viewFragment([]),
) as TypedViewConstructor<PopoverProps, PopoverCall>

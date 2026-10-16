/** Shared URL-attribute policy. This is not an HTML/CSS or resource sandbox. */
const navigationAttributes = new Set(["href", "action", "formaction", "cite", "ping", "xlink:href"])
const resourceAttributes = new Set(["src", "poster", "background", "data", "longdesc", "manifest"])

export function isSafeUrlAttribute(name: string, value: unknown): boolean {
  name = name.toLowerCase()
  if (!navigationAttributes.has(name) && !resourceAttributes.has(name)) return true
  const text = String(value)
  if (name === "ping") return text.split(/\s+/).every(url => isSafeUrlAttribute("href", url))
  // WHATWG URL parsing strips ASCII tab/newline anywhere and leading C0/space.
  // Inspect the scheme only: substrings, entities and percent escapes in a path
  // are not schemes (SSR escapes ampersands before the HTML parser sees them).
  const candidate = text.replace(/[\t\n\r]/g, "").replace(/^[\x00-\x20]+/, "")
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(candidate)?.[1]?.toLowerCase()
  if (!scheme) return true
  if (scheme === "http" || scheme === "https") return true
  if (navigationAttributes.has(name)) return scheme === "mailto" || scheme === "tel" || scheme === "sms"
  if (scheme === "blob") return true
  // Only inert raster images; SVG/HTML data URLs can contain active documents.
  return name !== "data" && scheme === "data" && /^data:image\/(?:png|gif|jpeg|webp|avif|bmp|x-icon);base64,[a-z0-9+/=\s]*$/i.test(candidate)
}

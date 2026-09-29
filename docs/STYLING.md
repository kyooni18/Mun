# Mün styling

Canonical Mün styling is semantic and backend-neutral. A View describes visual
and layout intent; it does not describe CSS.

The compiler lowers supported modifiers into Semantic UI IR. Native backends map
those values to native layout/scene properties. The Web backend may translate
the same values into CSS internally, but CSS is not part of the Mün language
contract.

## Layout intent

Use Mün layout containers and modifiers:

```mun
VStack(spacing: 16) {
  Text("Mün")
  Text("Native-first UI")
}
.padding(24)
.frame(width: 360)
```

`VStack`, `HStack`, layout spacing, padding, alignment, and frame constraints
express relationships. A backend is responsible for implementing those
relationships in its own layout system.

Numbers in canonical Mün layout are semantic dimensions. They are not defined
as CSS pixels.

## Visual intent

Use semantic visual modifiers:

```mun
Rectangle()
  .frame(width: 240, height: 96)
  .background("#6750A4")
  .cornerRadius(18)
```

The current Semantic UI IR carries background, foreground, corner radius,
dimensions, padding, and stack spacing directly. More visual properties should
be added to the IR as semantic concepts rather than by adding browser-specific
style keys to core.

## Motion

Motion is also semantic:

```mun
Rectangle()
  .frame(width: expanded.value ? 320 : 160, height: 96)
  .background("#6750A4")
  .cornerRadius(18)
  .animation(Animation.spring(0.48, 0.82), expanded.value)
```

The compiler records the affected semantic property, trigger, and animation
plan. Native execution and Web lowering consume the same motion intent.

`withAnimation` and `withTransaction` use the same renderer-neutral
transaction model.

## Backend-specific styling

Browser-only styling belongs to the Web compatibility/backend surface. Existing
React/Vue/Web integrations may continue to support classes, inline browser
styles, stylesheets, and framework-specific escape hatches, but those APIs are
not canonical Mün styling and must not be added to Semantic UI IR as CSS.

When a capability is useful on every platform, model the capability in Mün
semantics first and let each backend lower it appropriately.

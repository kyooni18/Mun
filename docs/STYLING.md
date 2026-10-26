# Mun styling for the web

Author layout and visual behavior in `.mun` using Views and ordered modifiers.
The web renderer translates the existing core graph into HTML/CSS. Native
Semantic UI IR is an experimental consumer, not a restriction on web styling.

```mun
VStack(spacing: 16) {
  Text("Mun")
  Text("A web application")
}
.padding(24)
.frame(width: 360)
.background("#f4f4f6")
.cornerRadius(18)
```

The current web runtime interprets numeric spacing, padding and frame lengths as
CSS pixels. APIs accepting string lengths pass supported CSS lengths through;
that support is API-specific. Stack layout uses browser flex layout. Full typed
responsive styling, grid, interaction/pseudo-element themes and a consistent unit
system are later work, not implied by this example.

Modifiers apply in source order. A modifier may update props, add a style or
introduce a wrapper when layout, painting or clipping needs another box. Do not
assume chains with the same modifier names in different orders are equivalent.
`withAnimation`/`withTransaction` preserve the existing transaction model.

For web-specific layout, `Element` accepts typed HTML attributes and style props:

```mun
Element("main", { style: { maxWidth: "40rem", margin: "2rem auto" } }) {
  Text("Profile")
}
```

Existing `.className(...)`, `.style(...)`, object styles and external stylesheets
remain integration surfaces. A stylesheet/host file is not needed for ordinary
behavior in the first milestone. The planned typed style library will grow from
these existing capabilities; it is not implemented by this milestone.

See [language reference](LANGUAGE_REFERENCE.md), [capabilities](CAPABILITIES.md)
and [native architecture](NATIVE_ARCHITECTURE.md) for the relevant boundaries.

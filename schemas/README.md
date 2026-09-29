# Mün Semantic UI IR schemas

`semantic-ui-ir-v1.schema.json` defines the serialized v1 contract between the Mün compiler and backend consumers. It is a wire-format contract, not a platform-specific rendering model.

A v1 program has exactly one root `Window`. Descendants are content nodes (`column`, `row`, `conditional`, `text`, `panel`, and `action`). Platform windows are not ordinary child views, so a nested `Window` is invalid v1 IR.

The compiler must emit `version: 1` and `sourceLanguage: "mun"`. Consumers must reject unsupported versions or source languages before evaluating state, layout, actions, or motion.

The motion property list is also an ABI. `propertyMask` uses the bit position assigned by the ordered `munMotionPropertyNames` list in `@mun/core`. Reordering existing properties changes existing mask meanings and is therefore a breaking wire-format change. New properties must only be emitted after every supported consumer understands their name, bit, value representation, and semantics.

Within one IR version, producers must not start emitting a field or node kind until all supported consumers can interpret it consistently. Renaming or removing fields, changing value representations, changing node meaning, or reassigning motion bits requires a new IR version.

The TypeScript semantic types, this schema, and native runtime deserialization must stay in lockstep. The schema is intentionally strict so drift is discovered during development instead of being silently ignored by a backend.

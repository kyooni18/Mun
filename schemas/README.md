# Mün Semantic UI IR schemas

`semantic-ui-ir-v1.schema.json` defines the serialized v1 contract between the Mün compiler and backend consumers. It is a wire-format contract, not a platform-specific rendering model.

A v1 program has exactly one root `Window`. Descendants are content nodes (`column`, `row`, `overlay`, `scroll`, `conditional`, `text`, `panel`, `textField`, `radioGroup`, and `action`). Platform windows are not ordinary child views, so a nested `Window` is invalid v1 IR.

The compiler must emit `version: 1` and `sourceLanguage: "mun"`. Consumers must reject unsupported versions or source languages before evaluating state, layout, actions, or motion.

The motion property list is also an ABI. `propertyMask` uses the bit position assigned by the ordered `munMotionPropertyNames` list in `@mun/core`. Reordering existing properties changes existing mask meanings and is therefore a breaking wire-format change. New properties must only be emitted after every supported consumer understands their name, bit, value representation, and semantics.

Within one IR version, producers must not start emitting a field or node kind until all supported consumers can interpret it consistently. Renaming or removing fields, changing value representations, changing node meaning, or reassigning motion bits requires a new IR version.

The TypeScript semantic types, this schema, and native runtime deserialization must stay in lockstep. The schema is intentionally strict so drift is discovered during development instead of being silently ignored by a backend.

The native runtime (`mun-runtime`) bundles this file and evaluates it against every program before deserializing it: unknown fields, unknown node/expression/action kinds, nested windows and malformed shapes are load errors that name the nearest node identity and the JSON path of the field. It then checks references the schema cannot express (declared and unique state names, text bindings to string state, unique radio option values, `item` expressions inside their `forEach`, item-scoped state naming an existing `forEach`). An unsupported `version` or `sourceLanguage` is reported before any field validation.

`forEach` nodes render one instance of their children per collection item, keyed by `keyPath`. Item identity is the key, never the index: node identities gain a key segment, and states declared with `scope` exist once per live key and are released when the key leaves the collection. Duplicate or invalid keys are errors.

Scroll nodes own an explicit vertical/horizontal viewport. Offsets are runtime-owned, not serialized state or renderer commands. Content extent comes from layout; presentation clips, input hit testing, and accessibility geometry share that viewport.

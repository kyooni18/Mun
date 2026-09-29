/**
 * Compatibility module: built-in Views are renderer-independent and are owned
 * by @mun/core. Keeping this path avoids breaking existing React imports.
 */
export {
  BindingValue,
  Button,
  Divider,
  Element,
  ForEach,
  Group,
  HStack,
  LazyHStack,
  LazyVStack,
  List,
  Section,
  Spacer,
  Text,
  VStack,
  ZStack,
} from "@mun/core/compat"
export type { HStackOptions, VStackOptions, ZStackOptions } from "@mun/core/compat"

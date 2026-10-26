/**
 * Opt-in: progressive (variable-radius) blur. Bundled with `@mun/ui`, never
 * imported implicitly; `.mun` files import it explicitly like any ES module.
 * The implementation lives in the internal `@mun/progressive-blur` module, so
 * old and new import paths share one module instance.
 */
export * from "@mun/progressive-blur"

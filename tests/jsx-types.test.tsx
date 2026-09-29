/** @jsxImportSource ../src */

const intrinsic = (
  <div
    id="root"
    padding={12}
    frame={{ maxWidth: 'infinity', alignment: 'center' }}
    background="Canvas"
  >
    Mun
  </div>
)

// @ts-expect-error modifier values use Mun's Length type, not arbitrary objects
const invalid = <div padding={{ value: 12 }} />

export { intrinsic, invalid }

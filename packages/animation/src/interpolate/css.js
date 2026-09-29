import { interpolateColor } from './color.js';
import { interpolateTransform } from './transform.js';

export * from './color.js';
export * from './transform.js';

export function interpolateNumber(from, to) {
  const a = Number(from);
  const b = Number(to);
  if (!Number.isFinite(a) || !Number.isFinite(b)) throw new TypeError('Numeric interpolation requires finite numbers.');
  return (progress) => a + (b - a) * progress;
}

/**
 * Lean CSS-oriented interpolator. Unlike the broad interpolate entry point,
 * this module intentionally does not statically import SVG path or material
 * interpolation, so DOM-only consumers do not pay for those feature families.
 */
export function createInterpolator(from, to, options = {}) {
  if (typeof options.interpolate === 'function') return (progress) => options.interpolate(from, to, progress);
  if (typeof from === 'number' && typeof to === 'number') return interpolateNumber(from, to);
  if (options.type === 'transform' || (typeof from === 'object' && from !== null && typeof to === 'object' && to !== null && ('x' in from || 'scale' in from || 'rotate' in from))) {
    return interpolateTransform(from, to, options.transform);
  }
  if (options.type === 'color') return interpolateColor(from, to, options.color);
  if (options.type === 'path' || options.type === 'material') {
    throw new TypeError(`The CSS interpolator does not include ${options.type} interpolation. Import from @mun/animation/interpolate for that feature.`);
  }
  if (typeof from === 'string' && typeof to === 'string') {
    try { return interpolateColor(from, to, options.color); } catch {}
    try { return interpolateTransform(from, to, options.transform); } catch {}
  }
  throw new TypeError('No CSS interpolator is available for these values. Pass options.type or options.interpolate.');
}

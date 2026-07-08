// Shared helpers for emitting well-formed, injection-safe SVG. Both SVG exporters
// (`annotation/annotationSvg.ts` and `slide/slideVector.ts`) interpolate values
// that can originate from the public API or a loaded document, so numbers must
// never serialize as `NaN` and strings must never be able to terminate an
// attribute and inject markup.

/**
 * Serialize a coordinate/length for SVG: rounded to 2dp, with any non-finite
 * value (NaN, Infinity) collapsed to `0`. An `NaN` in a path `d` or a `viewBox`
 * makes the whole document unrenderable in most viewers.
 */
export function svgNumber(n: number): string {
  if (!Number.isFinite(n)) return '0'
  return (Math.round(n * 100) / 100).toString()
}

/** Escape the five XML entities so a value cannot break out of an attribute. */
export function escapeXmlAttr(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;')
}

// A conservative allowlist of the CSS color forms we emit or expect. Anything
// matching these cannot contain a quote, angle bracket, or semicolon, so a match
// is safe to interpolate verbatim. Validation (not escaping) is used because an
// escaped-but-invalid color would render as nothing anyway, with no hint why.
const CSS_NAMED = /^[a-z]+$/i
const CSS_HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i
const CSS_FUNC = /^(?:rgba?|hsla?)\(\s*[0-9.,%\s/+-]+\)$/i

/**
 * Validate a caller-supplied CSS color string. Accepts named colors, `#hex`
 * (3/4/6/8 digit), and `rgb()/rgba()/hsl()/hsla()` with numeric arguments.
 * Anything else returns `fallback` — a color is never partially escaped into
 * the output, so a hostile value cannot inject markup.
 */
export function safeCssColor(color: string, fallback = 'none'): string {
  if (typeof color !== 'string') return fallback
  const c = color.trim()
  if (CSS_HEX.test(c) || CSS_FUNC.test(c) || CSS_NAMED.test(c)) return c
  return fallback
}

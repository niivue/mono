/**
 * Centered text overlay for a canvas, used when no graphics backend could
 * initialize so the user sees guidance instead of a blank canvas.
 *
 * A DOM element is used rather than drawing on the canvas: a failed WebGPU/WebGL2
 * `getContext` attempt can lock the canvas's context type, blocking a 2D fallback.
 * The overlay is positioned over the canvas via its offset within `offsetParent`.
 */
const overlays = new WeakMap<HTMLCanvasElement, HTMLElement>()

/**
 * Shown when neither WebGPU nor WebGL2 could initialize — usually because the
 * browser's hardware acceleration is off (no GPU adapter, no WebGL2 context).
 * Offers the two concrete fixes a user can apply themselves.
 */
export const GRAPHICS_UNAVAILABLE_MESSAGE = [
  'Graphics initialization failed.',
  ' - Fix 1 (Preferred): Enable "Use graphics acceleration when available" in browser settings.',
  ' - Fix 2 (No GPU): In Chrome, enable chrome://flags/#enable-unsafe-swiftshader (software fallback; for testing, may reduce security).',
].join('\n')

/** Remove any message overlay previously shown for `canvas`. */
export function clearCanvasMessage(canvas: HTMLCanvasElement): void {
  const prev = overlays.get(canvas)
  if (prev) {
    prev.remove()
    overlays.delete(canvas)
  }
}

/** Show (or replace) a centered, multi-line message overlaying `canvas`. No-op if
 *  the canvas isn't in the document (no host to attach the overlay to). */
export function showCanvasMessage(
  canvas: HTMLCanvasElement,
  message: string,
): void {
  clearCanvasMessage(canvas)
  const common = [
    'display:flex',
    'align-items:center',
    'justify-content:center',
    'box-sizing:border-box',
    'margin:0',
    'padding:16px',
    'background:rgba(0,0,0,0.78)',
    'pointer-events:none',
    'z-index:10',
  ]
  const overlay = document.createElement('div')
  overlay.setAttribute('role', 'alert')
  // `offsetLeft/Top` are relative to `offsetParent`, so only that pairing is
  // self-consistent. When there's an offsetParent, position within it; otherwise
  // (e.g. a fixed-position canvas / unusual layout) pin to <body> using the canvas's
  // viewport rect + scroll, which is always correct.
  const offsetParent = canvas.offsetParent as HTMLElement | null
  let host: HTMLElement
  if (offsetParent) {
    host = offsetParent
    overlay.style.cssText = [
      'position:absolute',
      `left:${canvas.offsetLeft}px`,
      `top:${canvas.offsetTop}px`,
      `width:${canvas.offsetWidth}px`,
      `height:${canvas.offsetHeight}px`,
      ...common,
    ].join(';')
  } else {
    const r = canvas.getBoundingClientRect()
    if (r.width === 0 && r.height === 0) return // not laid out -> nothing to cover
    host = document.body
    overlay.style.cssText = [
      'position:absolute',
      `left:${r.left + window.scrollX}px`,
      `top:${r.top + window.scrollY}px`,
      `width:${r.width}px`,
      `height:${r.height}px`,
      ...common,
    ].join(';')
  }
  // Inner box: left-aligned, whitespace preserved so the fix list stays readable.
  const box = document.createElement('div')
  box.textContent = message
  box.style.cssText = [
    'max-width:46em',
    'white-space:pre-wrap',
    'text-align:left',
    'margin:0',
    'color:#fff',
    'font:14px/1.5 system-ui,sans-serif',
  ].join(';')
  overlay.appendChild(box)
  host.appendChild(overlay)
  overlays.set(canvas, overlay)
}

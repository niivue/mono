// Display settings shared by the slide example pages.

// WebKit (Safari, and every iOS browser) runs WebGPU about 4x slower with
// anti-aliasing on (#381), so it defaults off there and on elsewhere;
// ?aa=on|off overrides.
const isWebKit =
  /AppleWebKit/.test(navigator.userAgent) &&
  !/Chrome|Chromium|Edg\//.test(navigator.userAgent) // iOS Edge (EdgiOS) is WebKit
const aaParam = new URLSearchParams(location.search).get('aa')
export const isAntiAlias = aaParam ? aaParam === 'on' : !isWebKit

// WebGPU unless ?backend=webgl2.
export function backendFromUrl() {
  const raw = new URLSearchParams(window.location.search).get('backend')
  return raw === 'webgl2' ? 'webgl2' : 'webgpu'
}

// The Retina control (native device pixels vs CSS pixels) only matters on a
// high-DPI display. A media query matches one ratio, so it is re-registered
// after each change: the window moved to another display, or the browser zoomed.
export function watchRetina(control, onChange = () => {}) {
  control.hidden = window.devicePixelRatio <= 1
  matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener(
    'change',
    () => {
      watchRetina(control, onChange)
      onChange()
    },
    { once: true },
  )
}

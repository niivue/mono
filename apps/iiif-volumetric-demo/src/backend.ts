// Runtime backend selection for the IIIF NiiVue demos.
//
// Reads `?backend=webgl2|webgpu` from the URL. Defaults to webgl2 so
// browsers without WebGPU keep working; users can opt in to WebGPU via
// the toggle wired into nav.ts.

export type Backend = 'webgl2' | 'webgpu'

const DEFAULT_BACKEND: Backend = 'webgl2'

// `pageDefault` lets a page (tile-range.html: webgpu) differ from the default.
export function getBackendFromUrl(
  pageDefault: Backend = DEFAULT_BACKEND,
): Backend {
  if (typeof window === 'undefined') return pageDefault
  const params = new URLSearchParams(window.location.search)
  const raw = params.get('backend')
  if (raw === 'webgpu' || raw === 'webgl2') return raw
  return pageDefault
}

export function isWebGpuAvailable(): boolean {
  return typeof navigator !== 'undefined' && 'gpu' in navigator
}

// Returns the URL the page would have if `backend` were selected, keeping
// every other query param. Always explicit, so the nav carries the choice to
// pages with another default.
export function backendSwitchUrl(backend: Backend): string {
  const url = new URL(window.location.href)
  url.searchParams.set('backend', backend)
  return url.toString()
}

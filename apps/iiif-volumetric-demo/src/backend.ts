// Runtime backend selection for the IIIF NiiVue demos.
//
// Reads `?backend=webgl2|webgpu` from the URL. Defaults to webgl2 so
// browsers without WebGPU keep working; users can opt in to WebGPU via
// the toggle wired into nav.ts.

export type Backend = 'webgl2' | 'webgpu'

const DEFAULT_BACKEND: Backend = 'webgl2'

export function getBackendFromUrl(): Backend {
  if (typeof window === 'undefined') return DEFAULT_BACKEND
  const params = new URLSearchParams(window.location.search)
  const raw = params.get('backend')
  if (raw === 'webgpu' || raw === 'webgl2') return raw
  return DEFAULT_BACKEND
}

export function isWebGpuAvailable(): boolean {
  return typeof navigator !== 'undefined' && 'gpu' in navigator
}

// Returns the URL the page would have if `backend` were selected. Preserves
// every other query param. webgl2 is the implicit default, so we drop the
// param entirely in that case to keep URLs tidy.
export function backendSwitchUrl(backend: Backend): string {
  const url = new URL(window.location.href)
  if (backend === DEFAULT_BACKEND) {
    url.searchParams.delete('backend')
  } else {
    url.searchParams.set('backend', backend)
  }
  return url.toString()
}

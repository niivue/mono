import { VOLUME_RENDER_MODE } from '@/NVConstants'

/**
 * Compile-time specialization of the volume ray-march shader (WGSL `override`
 * constants, GLSL `#define`s). Each flag is ANDed with the runtime test it
 * guards, so clearing a flag is only valid when that test is already false: a
 * variant renders identically, but the shader compiler can drop the dead
 * per-sample branches. Inactive clip planes alone cost ~20% of a 3D frame when
 * left to a runtime test.
 */
const RENDER_VARIANT_FLAGS = [
  'HAS_CLIP',
  'IS_CUTAWAY',
  'IS_MIP',
  'CUBIC',
  'NEEDS_GRADIENT',
  'HAS_OVERLAY',
  'HAS_PAQD',
  'HAS_DRAWING',
  'CHUNKED',
  'IS_SLICES',
] as const

/** Every flag set: the unspecialized shader, valid for any draw. */
export const GENERIC_RENDER_VARIANT = (1 << RENDER_VARIANT_FLAGS.length) - 1

export type RenderVariantState = {
  clipPlanes: ArrayLike<number>
  isClipCutaway: boolean
  renderMode: number
  cubic: boolean
  gradientAmount: number
  gradientOpacity: number
  silhouette: number
  hasOverlay?: boolean
  hasPaqd?: boolean
  hasDrawing?: boolean
}

/** Variant key for a single (non-chunked) volume draw. */
export function renderVariantKey(s: RenderVariantState): number {
  let hasClip = false
  // Mirror the shader's float32 test: only |depth| > 1 disables a plane, so
  // NaN (and 1 + 1e-10, which rounds to 1) count as active.
  for (let i = 3; i < s.clipPlanes.length; i += 4) {
    hasClip ||= !(Math.abs(Math.fround(s.clipPlanes[i])) > 1)
  }
  const bits = [
    hasClip,
    s.isClipCutaway,
    s.renderMode === VOLUME_RENDER_MODE.MAXIMUM,
    s.cubic,
    s.gradientAmount > 0 || s.gradientOpacity > 0 || s.silhouette > 0,
    s.hasOverlay,
    s.hasPaqd,
    s.hasDrawing,
    false,
    s.renderMode === VOLUME_RENDER_MODE.SLICES,
  ]
  return bits.reduce((key, on, i) => (on ? key | (1 << i) : key), 0)
}

/** WebGPU pipeline `constants` for a variant key. */
export function renderVariantConstants(key: number): Record<string, number> {
  return Object.fromEntries(
    RENDER_VARIANT_FLAGS.map((name, i) => [name, (key >> i) & 1]),
  )
}

/** GLSL `#define` block for a variant key. */
export function renderVariantDefines(key: number): string {
  return RENDER_VARIANT_FLAGS.map(
    (name, i) => `#define ${name} ${(key >> i) & 1 ? 'true' : 'false'}\n`,
  ).join('')
}

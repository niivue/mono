/**
 * Compile-time specialization of the volume ray-march shader (WGSL `override`
 * constants, GLSL `#define`s). Each flag is ANDed with the runtime test it
 * guards, so clearing a flag is only valid when that test is already false: a
 * variant renders identically, but the shader compiler can drop the dead
 * per-sample branches. Inactive clip planes alone cost ~20% of a 3D frame when
 * left to a runtime test.
 */
export const RENDER_VARIANT_FLAGS = [
  'HAS_CLIP',
  'IS_CUTAWAY',
  'IS_MIP',
  'CUBIC',
  'NEEDS_GRADIENT',
  'HAS_OVERLAY',
  'HAS_PAQD',
  'HAS_DRAWING',
  'CHUNKED',
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
  hasOverlay: boolean
  hasPaqd: boolean
  hasDrawing: boolean
}

/** Variant key for a single (non-chunked) volume draw. */
export function renderVariantKey(s: RenderVariantState): number {
  let hasClip = false
  // The shader treats a plane with |depth| > 1 as disabled.
  for (let i = 3; i < s.clipPlanes.length; i += 4) {
    if (Math.abs(s.clipPlanes[i] ?? 2) <= 1) hasClip = true
  }
  const bits = [
    hasClip,
    s.isClipCutaway,
    s.renderMode > 0.5,
    s.cubic,
    s.gradientAmount > 0 || s.gradientOpacity > 0 || s.silhouette > 0,
    s.hasOverlay,
    s.hasPaqd,
    s.hasDrawing,
    false,
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

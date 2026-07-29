// Pure explode-offset math for the 3D crosshair. Split out of NVCrosshair.ts so
// it is testable under the Bun unit runner: NVCrosshair pulls in the mesh module
// graph, which uses Vite's `import.meta.glob` and cannot be imported by Bun.

import { type mat4, vec3, vec4 } from 'gl-matrix'
import type NVModel from '@/NVModel'
import type { NVImage } from '@/NVTypes'
import { explodeOffsetMMAtFrac } from '@/volume/ChunkExplode'

const _crossSrc = vec4.fromValues(0, 0, 0, 1)
const _crossTex = vec4.create()

/**
 * World-mm shift to apply to the 3D crosshair so it tracks an exploded block.
 * Returns [0,0,0] unless `volume` is a chunked, exploded plan; then it is the
 * explode offset of the block containing the crosshair.
 *
 * `crosshairMM` is the crosshair in world mm (`model.scene2mm(scene.crosshairPos)`)
 * and `mm2tex` the background volume's mm -> texture-fraction matrix. Both are
 * needed because `explodeOffsetMMAtFrac` indexes the chunk plan by VOLUME TEXTURE
 * fraction, not scene fraction: the two spaces only coincide when the scene AABB
 * is exactly the background volume's extent, which extra meshes, multiple volumes,
 * or an origin flip all break. mm is the common ground (the same conversion the
 * annotation path in `view/NVAnnotation.ts` makes).
 */
export function crosshairExplodeOffset(
  volume: NVImage | undefined,
  crosshairMM: ArrayLike<number>,
  mm2tex: mat4 | null,
): [number, number, number] {
  if (volume?.chunkPlan && volume?.chunkExplode && volume?.matRAS && mm2tex) {
    _crossSrc[0] = crosshairMM[0]
    _crossSrc[1] = crosshairMM[1]
    _crossSrc[2] = crosshairMM[2]
    vec4.transformMat4(_crossTex, _crossSrc, mm2tex)
    return explodeOffsetMMAtFrac(
      volume.chunkPlan,
      volume.chunkExplode,
      volume.matRAS,
      [_crossTex[0], _crossTex[1], _crossTex[2]],
    )
  }
  return [0, 0, 0]
}

/**
 * `crosshairExplodeOffset` for the scene's active volume. Bails before converting
 * the crosshair to mm when there is no exploded chunk plan — the common case, and
 * this runs on every crosshair update in both backends.
 */
export function crosshairExplodeOffsetForModel(
  model: NVModel,
): [number, number, number] {
  const volume = model.volumes[0]
  if (!volume?.chunkPlan || !volume?.chunkExplode) return [0, 0, 0]
  return crosshairExplodeOffset(
    volume,
    model.scene2mm(model.scene.crosshairPos),
    model.mm2tex,
  )
}

/** Translate an mm point by an offset (returns the input unchanged when zero). */
export function applyCrosshairOffset(p: vec3, off: ArrayLike<number>): vec3 {
  if (off[0] === 0 && off[1] === 0 && off[2] === 0) return p
  return vec3.fromValues(p[0] + off[0], p[1] + off[1], p[2] + off[2])
}

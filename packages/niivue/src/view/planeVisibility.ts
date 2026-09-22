/**
 * CPU twin of the SLICES plane-visibility rule the shaders share: sampleSlice
 * in gl/renderShader.ts and wgpu/render.wgsl draws a plane, and
 * planeLayerVisible in gl/depthPickShader.ts and wgpu/depthPick.ts picks on it.
 *
 * A chunked volume has no single GPU texture the pick shader can sample, so its
 * SLICES pick runs on the CPU (NVTransforms.rayPlaneFirstVisibleMM) with a
 * sampler that says whether the plane is visible at an mm point. With clip dark
 * on, a plane is visible where the base volume is, and ALSO where a PAQD label
 * or a drawing voxel is painted over transparent base: sampleSlice draws both,
 * so the pick has to see both, or a click on a visible label leaves the
 * crosshair where it was.
 */

/** Visibility at an mm point: greater than zero means the plane is drawn there. */
export type PlaneSampler = (x: number, y: number, z: number) => number

/**
 * RGBA8 voxels in RAS order, stretched over the volume's mm box the way the GPU
 * textures are: the drawing shares the background grid, and the PAQD layer is
 * resliced onto it by preparePaqdOverlayData.
 */
export interface RgbaGrid {
  data: Uint8Array
  dims: ArrayLike<number>
}

/**
 * PAQD easing: piecewise-linear alpha from the primary label's probability,
 * with `volumePaqdUniforms` as [t0, t1, y1, y2]. The same function as
 * paqdEaseAlpha in the two shader preambles; keep the three in step.
 */
export function paqdEaseAlpha(alpha: number, u: ArrayLike<number>): number {
  const t0 = u[0]
  const t1 = 0.5 * (u[0] + u[1])
  const t2 = u[1]
  const y1 = Math.abs(u[2])
  const y2 = Math.abs(u[3])
  if (alpha <= t0) return 0
  if (alpha <= t1) return mix(0, y1, (alpha - t0) / (t1 - t0))
  if (alpha <= t2) return mix(y1, y2, (alpha - t1) / (t2 - t1))
  return y2
}

function mix(a: number, b: number, t: number): number {
  return a * (1 - t) + b * t
}

/**
 * Whether a raw PAQD voxel is drawn, from its blue (primary probability) and
 * alpha (secondary probability) bytes: the shaders' `total > 0.004` floor on
 * the two probabilities, then a non-zero eased alpha.
 */
export function paqdVoxelVisible(
  b: number,
  a: number,
  uniforms: ArrayLike<number>,
): boolean {
  // The shaders read the bytes back as [0, 1] texels.
  const pb = b / 255
  const pa = a / 255
  return pb + pa > 0.004 && paqdEaseAlpha(pb, uniforms) > 0
}

/**
 * Byte offset of the nearest voxel to an mm point in a grid stretched over the
 * box [lo, hi], or -1 outside the box. The same floor-and-clamp the shaders'
 * texelFetch / textureLoad take.
 */
export function rgbaGridOffset(
  grid: RgbaGrid,
  lo: ArrayLike<number>,
  hi: ArrayLike<number>,
  x: number,
  y: number,
  z: number,
): number {
  const mm = [x, y, z]
  let idx = 0
  let stride = 1
  for (let i = 0; i < 3; i++) {
    const d = grid.dims[i]
    if (!(d >= 1)) return -1
    const f = (mm[i] - lo[i]) / (hi[i] - lo[i] || 1)
    if (!(f >= 0 && f <= 1)) return -1
    idx += Math.min(d - 1, Math.floor(f * d)) * stride
    stride *= d
  }
  return idx * 4
}

/**
 * The complete clip-dark visibility rule for a SLICES plane: the base volume's
 * own sampler, or a drawn PAQD voxel, or a painted drawing voxel.
 *
 * Without a base sampler there is nothing to reject (the caller treats
 * `undefined` as "every crossing is visible"), so the layers cannot narrow it
 * and `undefined` is returned unchanged. Without any layer the base sampler is
 * returned as is.
 */
export function composePlaneVisibility(opts: {
  lo: ArrayLike<number>
  hi: ArrayLike<number>
  base?: PlaneSampler
  drawing?: RgbaGrid | null
  paqd?: { grid: RgbaGrid; uniforms: ArrayLike<number> } | null
}): PlaneSampler | undefined {
  const { lo, hi, base, drawing, paqd } = opts
  if (!base) return undefined
  if (!drawing && !paqd) return base
  return (x, y, z) => {
    const v = base(x, y, z)
    if (v > 0) return v
    if (paqd) {
      const o = rgbaGridOffset(paqd.grid, lo, hi, x, y, z)
      if (
        o >= 0 &&
        paqdVoxelVisible(
          paqd.grid.data[o + 2],
          paqd.grid.data[o + 3],
          paqd.uniforms,
        )
      ) {
        return 1
      }
    }
    if (drawing) {
      const o = rgbaGridOffset(drawing, lo, hi, x, y, z)
      if (o >= 0 && drawing.data[o + 3] > 0) return 1
    }
    return 0
  }
}

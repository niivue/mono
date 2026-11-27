import type { mat4, vec3 } from 'gl-matrix'
import * as NVTransforms from '@/math/NVTransforms'
import * as NVConstants from '@/NVConstants'
import type NVModel from '@/NVModel'
import type { SliceTile } from '@/view/NVSliceLayout'
import * as NVSliceLayout from '@/view/NVSliceLayout'
import { isVolumeDrawn, stackPickSampler } from '@/view/NVVolumeVisibility'
import { composePlaneVisibility, type RgbaGrid } from '@/view/planeVisibility'
import { chunkExplodeEnabled, pickExplodedVoxel } from '@/volume/ChunkExplode'
import { residentPickSampler } from '@/volume/utils'

/**
 * A tile's [mvp, model, normal, rayDir], as the render loop builds them.
 * `clipSpaceZeroToOne`: WebGPU depth range (true) or WebGL2's -1..1 (false).
 */
export function tilePickMatrices(
  tile: SliceTile,
  isRender: boolean,
  md: NVModel,
  clipSpaceZeroToOne: boolean,
): [mat4, mat4, mat4, vec3] {
  const ltwh = tile.leftTopWidthHeight as number[]
  if (isRender && tile.renderOrientation !== undefined && tile.screen) {
    // Mosaic render tile: use same MVP as render loop (origin-centered, tile angles)
    const screen = tile.screen as { mnMM: number[]; mxMM: number[] }
    return NVTransforms.calculateMvpMatrix2D(
      ltwh,
      screen.mnMM,
      screen.mxMM,
      tile.azimuth as number,
      tile.elevation as number,
      NVSliceLayout.isSliceMirrored(tile.axCorSag, md.layout),
      md.volumes[0]?.obliqueRAS,
      md.pivot3D,
      undefined,
      clipSpaceZeroToOne,
    )
  }
  if (isRender) {
    return NVTransforms.calculateMvpMatrix(
      ltwh,
      md.scene.azimuth,
      md.scene.elevation,
      md._renderPivotMM ?? md.pivot3D,
      md.furthestFromPivot,
      md.scene.scaleMultiplier,
      md.volumes[0]?.obliqueRAS,
      md.scene.renderPan,
    ) as [mat4, mat4, mat4, vec3]
  }
  const screen = tile.screen as { mnMM: number[]; mxMM: number[] }
  const pan = NVSliceLayout.slicePanUV(md.scene.pan2Dxyzmm, tile.axCorSag)
  return NVTransforms.calculateMvpMatrix2D(
    ltwh,
    screen.mnMM,
    screen.mxMM,
    tile.azimuth as number,
    tile.elevation as number,
    NVSliceLayout.isSliceMirrored(tile.axCorSag, md.layout),
    md.volumes[0]?.obliqueRAS,
    undefined,
    pan,
    clipSpaceZeroToOne,
    tile.clipRot,
  )
}

/**
 * CPU pick for a chunked / multi-LOD volume in a render tile. Chunked volumes
 * have no single whole-volume texture, so the GPU depth pass cannot sample
 * them; this picks against the volume's mm bounding box instead and returns
 * the near-surface entry under the cursor — enough to move the crosshair (and
 * thus the multi-LOD focus) in a 3D render.
 *
 * Returns the hit in mm, `null` to stop the pick (exploded miss), or
 * `undefined` to fall through to the GPU pass, which also picks meshes.
 */
export function pickChunkedVolumeMM(
  md: NVModel,
  normalizedX: number,
  normalizedY: number,
  mvpMatrix: mat4,
  isStack: boolean,
  drawingPickGrid: RgbaGrid | null,
  paqdPickGrid: RgbaGrid | null,
): [number, number, number] | null | undefined {
  const vol = md.volumes[0]
  // A hidden background is not drawn, so it must not answer a pick; a
  // channel stack answers from any drawn channel (#370).
  const pickSampler = isStack
    ? stackPickSampler(md.volumes)
    : // A resident chunked volume has no streamed sampler, but its
      // voxels are on the CPU: without one the pick stops at its box.
      (vol?.pickSampler ?? (vol && residentPickSampler(vol)) ?? undefined)
  if (
    !vol?.extentsMin ||
    !vol?.extentsMax ||
    !(isStack ? md.volumes.some(isVolumeDrawn) : isVolumeDrawn(vol))
  ) {
    return undefined
  }
  const near = NVTransforms.unprojectScreen(
    normalizedX,
    normalizedY,
    0,
    mvpMatrix,
  )
  const far = NVTransforms.unprojectScreen(
    normalizedX,
    normalizedY,
    1,
    mvpMatrix,
  )
  // SLICES draws three crosshair planes, so the pick lands on the nearest
  // VISIBLE plane crossing rather than on the near surface — the same rule
  // the GPU shaders use for a non-chunked volume.
  //
  // A miss must NOT fall through to the surface fallbacks below: in this
  // mode the volume's near surface is not on screen, so landing the
  // crosshair there would teleport all three planes to a voxel the user
  // never clicked. It drops to the GPU pass instead, which is the only
  // one that picks MESHES.
  //
  // ponytail: un-exploded only, and the planes are the mm-axis ones, as
  // the bounding box around them already is -- an oblique volume's true
  // planes are tilted. Exploded blocks displace the planes with them, so
  // they keep the block pick below. Give either its own plane maths if
  // someone picks in one of those views.
  if (
    md.volume.renderMode === NVConstants.VOLUME_RENDER_MODE.SLICES &&
    !chunkExplodeEnabled(vol.chunkExplode)
  ) {
    const planeMM = NVTransforms.rayPlaneFirstVisibleMM(
      near,
      far,
      vol.extentsMin,
      vol.extentsMax,
      md.scene2mm(md.scene.crosshairPos),
      // Without alpha clipping the plane is a solid slab, so every
      // in-box crossing is visible and there is nothing to reject. With
      // it, the base volume's own sampler is widened by the PAQD and
      // drawing layers the render paints over transparent base.
      md.volume.isAlphaClipDark
        ? composePlaneVisibility({
            lo: vol.extentsMin,
            hi: vol.extentsMax,
            base: pickSampler,
            drawing: drawingPickGrid,
            paqd: paqdPickGrid
              ? { grid: paqdPickGrid, uniforms: md.volume.paqdUniforms }
              : null,
          })
        : undefined,
    )
    return planeMM ?? undefined
  }
  if (
    // Exploded view: blocks are displaced, so the un-exploded bounding box
    // no longer matches what's on screen. Pick against each block's
    // exploded AABB (first window-visible voxel in the hit block) and map
    // the recovered un-exploded voxel back to mm for the crosshair.
    vol.chunkPlan &&
    vol.matRAS &&
    chunkExplodeEnabled(vol.chunkExplode)
  ) {
    const matRAS = vol.matRAS
    const base = pickSampler
    const sample = base
      ? (vx: number, vy: number, vz: number): number => {
          const mm = NVTransforms.vox2mm(null, [vx, vy, vz], matRAS as mat4)
          return base(mm[0], mm[1], mm[2])
        }
      : undefined
    const picked = pickExplodedVoxel(
      vol.chunkPlan,
      matRAS,
      vol.chunkExplode,
      [near[0], near[1], near[2]],
      [far[0] - near[0], far[1] - near[1], far[2] - near[2]],
      {
        sample,
        threshold: 0,
        clipPlanes: md.clipPlanes,
        isCutaway: md.scene.isClipPlaneCutaway,
      },
    )
    if (!picked) return null
    const mm = NVTransforms.vox2mm(null, picked.voxel, matRAS as mat4)
    return [mm[0], mm[1], mm[2]]
  }
  // With a CPU sampler (the streamed volume's coarse floor, or
  // app-supplied data), march to the first window-visible voxel.
  // Without one — or when the ray crosses nothing visible — land on the
  // bounding-box / clip surface, which is what the GPU shader does with
  // its own miss.
  const hitMM =
    (pickSampler
      ? NVTransforms.rayMarchFirstVisibleMM(
          near,
          far,
          vol.extentsMin,
          vol.extentsMax,
          pickSampler,
          md.clipPlanes,
          md.scene.isClipPlaneCutaway,
        )
      : null) ??
    NVTransforms.rayBoxEntryMM(
      near,
      far,
      vol.extentsMin,
      vol.extentsMax,
      md.clipPlanes,
      md.scene.isClipPlaneCutaway,
    )
  return hitMM ?? undefined
}

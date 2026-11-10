/**
 * Direction-of-travel prediction for chunk streaming.
 *
 * The upload pump already looks ahead, but only into a queue we have ALREADY
 * decided we need (`CHUNK_PREFETCH_WINDOW`): that is pipeline lookahead, not
 * prediction. Neuroglancer extrapolates the navigation state and fetches chunks
 * for where the view is GOING. This is the same idea, measured in the one space
 * both backends already share -- the chunk grid.
 *
 * Each frame the view hands over its working set (the chunks it just asked to
 * have resident). The centroid of that set in grid coordinates moves when the
 * view moves: a slice scrub marches it along the slice axis, a pan slides it
 * across the plane. Smooth that motion, extrapolate it a few frames forward,
 * and the prediction is the SAME footprint translated by the resulting whole-
 * chunk step -- the next slabs along the scrub, or the tiles about to come in
 * from the leading edge of a pan.
 *
 * A multi-LOD octree plan has no grid (`gridDims` [1,1,1], every `gridIndex`
 * [0,0,0]), so there travel is measured in common-grid voxels from brick
 * centres, and each brick predicts its same-level neighbour as many of its own
 * sizes ahead as the travel covers (coarse bricks usually stay put).
 *
 * Two properties keep the prediction honest:
 *
 * - It reads only the working set, so it costs one pass over a list the caller
 *   already has and needs nothing from the camera plumbing. That is also why it
 *   lands identically on both backends.
 * - It returns chunk indices to FETCH, never to make resident. The caller
 *   speculates with leftover fetch capacity after the real working set has been
 *   served, so a guess can never delay or evict a chunk the view can see.
 *
 * A settled view predicts nothing, and so does a jump (a dataset switch, a
 * crosshair teleport): a step that large is not travel, and following it would
 * spend the fetch budget on the wrong side of the volume.
 *
 * Note that "settled" means the working set has not moved SINCE IT LAST MOVED,
 * not that it failed to move this frame. Interaction is bursty -- a wheel step
 * lands in one frame and the next comes thirty frames later -- so the velocity
 * is carried across the idle frames rather than decayed away between steps.
 */

import type { ChunkPlan, Vec3i } from './chunking'

/**
 * Frames of travel to extrapolate. Long enough that a fetch started now has
 * landed by the time the view arrives, short enough that a direction change
 * costs at most a few wasted reads.
 */
const LOOKAHEAD_FRAMES = 3

/** Largest whole-chunk step prediction will extrapolate on any axis. */
const MAX_STEP_CHUNKS = 3

/**
 * A one-frame move of more than this many chunks on an axis is a jump, not
 * travel -- see the module note. The velocity is dropped rather than followed.
 */
const JUMP_CHUNKS = 4

/**
 * Weight of the newest measurement in the smoothed velocity. Low enough that
 * one jittery frame cannot swing the direction, high enough that a scrub is
 * followed within a frame or two of starting.
 */
const VELOCITY_SMOOTHING = 0.5

/**
 * Centroid movement below this many chunks is no movement at all: a rounding
 * wobble from a chunk entering the working set at its edge, not travel.
 */
const STILL_EPSILON = 1e-3

/** Zero-length result, shared so a settled view allocates nothing. */
const NO_PREDICTION: readonly number[] = []

/**
 * Tracks how a chunked volume's working set is travelling across its grid and
 * names the chunks the view is about to want. One instance per chunked volume;
 * the state is the last centroid and a smoothed velocity, both in chunks.
 */
export class ChunkTravelPredictor {
  private _center: [number, number, number] | null = null
  /** In chunks for a grid plan, in common voxels for an octree plan. */
  private readonly _velocity: [number, number, number] = [0, 0, 0]
  /** Jump/still threshold scale: 1 for a grid, mean brick dims for an octree. */
  private readonly _unit: [number, number, number] = [1, 1, 1]
  private _indexPlan: ChunkPlan | null = null
  private _index: Map<number, number> | null = null

  /**
   * Forget the current travel. Call when the working set stops being
   * comparable to the last one -- a new plan, a new volume -- so a stale
   * velocity cannot be extrapolated across the discontinuity.
   */
  reset(): void {
    this._center = null
    this._velocity[0] = 0
    this._velocity[1] = 0
    this._velocity[2] = 0
    this._unit.fill(1)
    this._indexPlan = null
    this._index = null
  }

  /**
   * A plan swap for the same volume. A refocused octree on the same common
   * grid keeps its velocity, since a focus that follows the view swaps plans
   * as it moves; any other swap resets. The centre is not kept: the new plan
   * covers the same view with other bricks, so their centroid moves even when
   * the view does not, and the next frame only sets a new baseline.
   */
  replan(from: ChunkPlan, to: ChunkPlan): void {
    const [fx, fy, fz] = from.volumeDims
    const [tx, ty, tz] = to.volumeDims
    if (
      isOctreePlan(from) &&
      isOctreePlan(to) &&
      fx === tx &&
      fy === ty &&
      fz === tz
    ) {
      this._center = null
    } else this.reset()
  }

  /**
   * Record this frame's working set and return the chunks the view is
   * predicted to ask for next, in the order they were given (the caller orders
   * its working set view-centre-outward, so the most central prediction comes
   * first). Empty for a settled view, a jump, or the first frame of a set.
   *
   * @param plan      The volume's chunk plan.
   * @param requested Chunk indices the working set asked for this frame.
   * @param max       Most indices to return.
   */
  predict(
    plan: ChunkPlan,
    requested: readonly number[],
    max: number,
  ): readonly number[] {
    if (requested.length === 0 || max < 1) {
      // An empty working set says nothing about travel -- the view may simply
      // be off the volume -- so hold the last velocity rather than resetting.
      return NO_PREDICTION
    }
    const octree = isOctreePlan(plan)
    // Grid plans measure in chunks; an earlier octree plan's unit must not leak.
    if (!octree) this._unit.fill(1)
    const center = octree
      ? brickCentroid(plan, requested, this._unit)
      : centroidOf(plan, requested)
    if (!center) return NO_PREDICTION
    const previous = this._center
    this._center = center
    if (!previous) return NO_PREDICTION

    for (let a = 0; a < 3; a++) {
      if (Math.abs(center[a] - previous[a]) <= JUMP_CHUNKS * this._unit[a]) {
        continue
      }
      // A discontinuity, not travel. Drop the velocity so the next frame
      // measures afresh instead of extrapolating across the gap.
      this._velocity[0] = 0
      this._velocity[1] = 0
      this._velocity[2] = 0
      return NO_PREDICTION
    }
    if (
      Math.abs(center[0] - previous[0]) < STILL_EPSILON * this._unit[0] &&
      Math.abs(center[1] - previous[1]) < STILL_EPSILON * this._unit[1] &&
      Math.abs(center[2] - previous[2]) < STILL_EPSILON * this._unit[2]
    ) {
      // Travel is measured per MOVE, not per frame. A scrub is discrete -- one
      // wheel step, then idle frames until the next -- so a still frame holds
      // the velocity instead of decaying it. Decaying would mean prediction
      // only ever fired during a continuous drag, which is the one case that
      // needs it least.
      return NO_PREDICTION
    }
    if (octree) {
      for (let a = 0; a < 3; a++) {
        const delta = center[a] - previous[a]
        this._velocity[a] += (delta - this._velocity[a]) * VELOCITY_SMOOTHING
      }
      return this._predictBricks(plan, requested, max)
    }
    const step: Vec3i = [0, 0, 0]
    let moved = false
    for (let a = 0; a < 3; a++) {
      const delta = center[a] - previous[a]
      this._velocity[a] += (delta - this._velocity[a]) * VELOCITY_SMOOTHING
      const ahead = Math.round(this._velocity[a] * LOOKAHEAD_FRAMES)
      step[a] = Math.max(-MAX_STEP_CHUNKS, Math.min(MAX_STEP_CHUNKS, ahead))
      if (step[a] !== 0) moved = true
    }
    if (!moved) return NO_PREDICTION
    return translateChunkSet(plan, requested, step, max)
  }

  /**
   * Octree look-ahead: each requested brick steps by the travel measured in its
   * own sizes, walking face neighbours one brick at a time, and names the
   * same-level brick it lands on.
   */
  private _predictBricks(
    plan: ChunkPlan,
    requested: readonly number[],
    max: number,
  ): readonly number[] {
    if (this._indexPlan !== plan) {
      this._index = faceIndex(plan)
      this._indexPlan = plan
    }
    const index = this._index as Map<number, number>
    const already = new Set(requested)
    const out: number[] = []
    for (const ci of requested) {
      const desc = plan.chunks[ci]
      if (!desc) continue
      let cur = ci
      for (let a = 0; a < 3 && cur >= 0; a++) {
        const dims = desc.voxelDims[a]
        const ahead = Math.round((this._velocity[a] * LOOKAHEAD_FRAMES) / dims)
        const step = Math.max(
          -MAX_STEP_CHUNKS,
          Math.min(MAX_STEP_CHUNKS, ahead),
        )
        for (let k = 0; k < Math.abs(step); k++) {
          const c = plan.chunks[cur]
          const [x, y, z] = c.voxelOrigin
          // Forward: the neighbour starts where this brick ends. Backward: it
          // ends where this brick starts (tag a + 1), whatever its size.
          const next =
            step > 0
              ? index.get(
                  faceKey(
                    plan,
                    a === 0 ? x + c.voxelDims[0] : x,
                    a === 1 ? y + c.voxelDims[1] : y,
                    a === 2 ? z + c.voxelDims[2] : z,
                    0,
                  ),
                )
              : index.get(faceKey(plan, x, y, z, a + 1))
          if (
            next === undefined ||
            plan.chunks[next].sourceLevel !== desc.sourceLevel
          ) {
            cur = -1
            break
          }
          cur = next
        }
      }
      if (cur < 0 || already.has(cur)) continue
      already.add(cur)
      out.push(cur)
      if (out.length >= max) break
    }
    return out
  }
}

/**
 * A multi-LOD octree plan: many bricks, but the placeholder 1x1x1 grid. One
 * too large for faceKey to stay exact is left to the grid path, which predicts
 * nothing for it, rather than predicting wrong bricks.
 */
function isOctreePlan(plan: ChunkPlan): boolean {
  const [gx, gy, gz] = plan.gridDims
  const [vx, vy, vz] = plan.volumeDims
  return (
    gx * gy * gz === 1 &&
    plan.chunks.length > 1 &&
    (vx + 1) * (vy + 1) * (vz + 1) * 4 <= Number.MAX_SAFE_INTEGER
  )
}

/**
 * A common-grid corner plus a tag, packed into one exact number.
 *
 * ponytail: exact while (vx+1)(vy+1)(vz+1)*4 < 2^53, i.e. up to ~130k voxels
 * an axis; a bigger common grid needs a two-level key.
 */
function faceKey(
  plan: ChunkPlan,
  x: number,
  y: number,
  z: number,
  tag: number,
): number {
  const [vx, vy] = plan.volumeDims
  return (x + (vx + 1) * (y + (vy + 1) * z)) * 4 + tag
}

/**
 * Face-neighbour index, built once per plan: each brick under its origin (tag
 * 0) and under its far face on each axis (tags 1..3). Octree leaves are
 * disjoint and same-level neighbours share the other two origins, so a key
 * names at most one brick.
 */
function faceIndex(plan: ChunkPlan): Map<number, number> {
  const index = new Map<number, number>()
  plan.chunks.forEach((c, i) => {
    const [x, y, z] = c.voxelOrigin
    const [dx, dy, dz] = c.voxelDims
    index.set(faceKey(plan, x, y, z, 0), i)
    index.set(faceKey(plan, x + dx, y, z, 1), i)
    index.set(faceKey(plan, x, y + dy, z, 2), i)
    index.set(faceKey(plan, x, y, z + dz, 3), i)
  })
  return index
}

/**
 * Volume-weighted mean of brick centres, in common voxels, so a window over
 * mixed levels moves with the window rather than with its many fine bricks.
 * Writes the unweighted mean brick dims to `unit`. Null when no index names a
 * brick of this plan.
 */
function brickCentroid(
  plan: ChunkPlan,
  indices: readonly number[],
  unit: [number, number, number],
): [number, number, number] | null {
  let sx = 0
  let sy = 0
  let sz = 0
  let sw = 0
  let dx = 0
  let dy = 0
  let dz = 0
  let n = 0
  for (const ci of indices) {
    const desc = plan.chunks[ci]
    if (!desc) continue
    const [ox, oy, oz] = desc.voxelOrigin
    const [wx, wy, wz] = desc.voxelDims
    const w = wx * wy * wz
    sx += (ox + wx / 2) * w
    sy += (oy + wy / 2) * w
    sz += (oz + wz / 2) * w
    sw += w
    dx += wx
    dy += wy
    dz += wz
    n++
  }
  if (n === 0) return null
  unit[0] = dx / n
  unit[1] = dy / n
  unit[2] = dz / n
  return [sx / sw, sy / sw, sz / sw]
}

/**
 * The mean grid position of a set of chunks, in chunks. Null when no index in
 * the set names a chunk of this plan (a set left over from another plan).
 */
function centroidOf(
  plan: ChunkPlan,
  indices: readonly number[],
): [number, number, number] | null {
  let sx = 0
  let sy = 0
  let sz = 0
  let n = 0
  for (const ci of indices) {
    const desc = plan.chunks[ci]
    if (!desc) continue
    sx += desc.gridIndex[0]
    sy += desc.gridIndex[1]
    sz += desc.gridIndex[2]
    n++
  }
  if (n === 0) return null
  return [sx / n, sy / n, sz / n]
}

/**
 * Translate a set of chunks by a whole-chunk grid step, dropping the ones that
 * leave the grid and the ones already in the set (those are the working set's
 * job, not the prediction's). Input order is preserved.
 */
export function translateChunkSet(
  plan: ChunkPlan,
  indices: readonly number[],
  step: Vec3i,
  max: number,
): readonly number[] {
  const [gx, gy, gz] = plan.gridDims
  const already = new Set(indices)
  const out: number[] = []
  for (const ci of indices) {
    const desc = plan.chunks[ci]
    if (!desc) continue
    const x = desc.gridIndex[0] + step[0]
    const y = desc.gridIndex[1] + step[1]
    const z = desc.gridIndex[2] + step[2]
    if (x < 0 || y < 0 || z < 0 || x >= gx || y >= gy || z >= gz) continue
    const next = (z * gy + y) * gx + x
    if (already.has(next)) continue
    already.add(next)
    out.push(next)
    if (out.length >= max) break
  }
  return out
}

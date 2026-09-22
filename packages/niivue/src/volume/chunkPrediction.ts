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
  private readonly _velocity: [number, number, number] = [0, 0, 0]

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
    const center = centroidOf(plan, requested)
    if (!center) return NO_PREDICTION
    const previous = this._center
    this._center = center
    if (!previous) return NO_PREDICTION

    for (let a = 0; a < 3; a++) {
      if (Math.abs(center[a] - previous[a]) <= JUMP_CHUNKS) continue
      // A discontinuity, not travel. Drop the velocity so the next frame
      // measures afresh instead of extrapolating across the gap.
      this._velocity[0] = 0
      this._velocity[1] = 0
      this._velocity[2] = 0
      return NO_PREDICTION
    }
    if (
      Math.abs(center[0] - previous[0]) < STILL_EPSILON &&
      Math.abs(center[1] - previous[1]) < STILL_EPSILON &&
      Math.abs(center[2] - previous[2]) < STILL_EPSILON
    ) {
      // Travel is measured per MOVE, not per frame. A scrub is discrete -- one
      // wheel step, then idle frames until the next -- so a still frame holds
      // the velocity instead of decaying it. Decaying would mean prediction
      // only ever fired during a continuous drag, which is the one case that
      // needs it least.
      return NO_PREDICTION
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

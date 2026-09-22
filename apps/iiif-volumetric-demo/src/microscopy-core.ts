// Pure logic of the microscopy hub (microscopy.ts): dataset grouping and
// filtering, display-window calculation, segmentation shell generation,
// opacity policy, and the load serializer. No DOM, no NiiVue instance — this
// module is what the Bun unit suite exercises.

import type { TypedVoxelArray } from '@niivue/niivue'

export type Shape3 = [number, number, number]

export interface ApiVolume {
  id: string
  format: string
  shape: Shape3
  dtype: string
  spacing: Shape3
  channel: number | null
  channelName: string | null
  dataset: string
  levels?: unknown[]
}

export interface Dataset {
  key: string
  format: string
  shape: Shape3
  spacing: Shape3
  channels: ApiVolume[]
}

// Which family of channels the sidebar lists.
export type Family = 'all' | 'raw' | 'seg'

// A segmentation mask is a filled solid where a fluorescence channel is sparse,
// so the same overlay opacity that reads well for `_raw` buries everything
// under `_seg`. Fade masks further than raw channels.
export const SEG_OPACITY_SCALE = 0.5

// Whole-volume load budget. Bigger sources belong on the streaming pages, which
// fetch a level/region at a time instead of the entire array.
export const MAX_WHOLE_VOLUME_VOXELS = 64_000_000

// Allen ships each tagged structure twice: the raw fluorescence image and the
// segmentation derived from it, distinguished only by a `_raw` / `_seg` suffix
// on the channel name. Nothing in the volume metadata separates them (both are
// uint8 at the same shape), so the suffix is the only signal available — and
// the two need opposite display treatment, since a mask has no internal
// texture to window against.
export function isSegChannel(entry: ApiVolume): boolean {
  return /_seg$/i.test(entry.channelName ?? '')
}

export function matchesFamily(entry: ApiVolume, family: Family): boolean {
  if (family === 'all') return true
  return isSegChannel(entry) === (family === 'seg')
}

export function visibleChannels(d: Dataset, family: Family): ApiVolume[] {
  return d.channels.filter((entry) => matchesFamily(entry, family))
}

export function voxels(shape: Shape3): number {
  return shape[0] * shape[1] * shape[2]
}

// One dataset per `dataset` key, channels in channel order.
export function groupDatasets(volumes: ApiVolume[]): Dataset[] {
  const byKey = new Map<string, ApiVolume[]>()
  for (const v of volumes) {
    const list = byKey.get(v.dataset)
    if (list) list.push(v)
    else byKey.set(v.dataset, [v])
  }
  const out: Dataset[] = []
  for (const [key, entries] of byKey) {
    entries.sort((a, b) => (a.channel ?? 0) - (b.channel ?? 0))
    const first = entries[0]
    out.push({
      key,
      format: first.format,
      shape: first.shape,
      spacing: first.spacing,
      channels: entries,
    })
  }
  out.sort((a, b) => a.key.localeCompare(b.key))
  return out
}

// A microscopy source qualifies only when one channel is small enough to fetch
// whole - the page auto-loads channels on open, so an uncapped multi-channel
// source would fire huge whole-volume requests unprompted.
export function isLoadableHere(d: Dataset): boolean {
  if (d.format === 'nifti') return false
  return voxels(d.shape) <= MAX_WHOLE_VOLUME_VOXELS
}

/**
 * Replace a label mask with its surface shell.
 *
 * A mask is a filled solid, and a filled solid is opaque along any ray that
 * crosses it — so in the 3D render the largest structure (the nucleus of
 * `DNA_seg`) hides everything inside it no matter how far its alpha is turned
 * down. Alpha only controls how fast a ray saturates, not whether it does.
 *
 * Keeping only the labelled voxels that touch an unlabelled 6-neighbour turns
 * each mask into an outline in the 2D slices and a hollow shell in the 3D
 * render, which is what makes a whole segmentation stack legible at once.
 *
 * `floor` is the background level (`globalMin`), which the interior is reset to
 * rather than to zero: the display windows above the floor, so the emptied
 * interior has to land on it to read as background. `globalMin` / `globalMax`
 * are unchanged by this, since the shell keeps both extremes.
 *
 * Returns a NEW array rather than editing in place. Both backends cache the
 * uploaded source texture against `img.buffer` identity
 * (`prepareOrientTextureCache`), so an in-place edit is invisible to the GPU —
 * the cache reuses the texture it already has and nothing on screen changes.
 */
export function hollowMask(
  img: TypedVoxelArray,
  dims: [number, number, number],
  floor: number,
): TypedVoxelArray {
  const [nx, ny, nz] = dims
  const rowStride = nx
  const sliceStride = nx * ny
  const src = img
  const out = img.slice()
  for (let z = 0; z < nz; z++) {
    for (let y = 0; y < ny; y++) {
      for (let x = 0; x < nx; x++) {
        const i = x + y * rowStride + z * sliceStride
        if (src[i] <= floor) continue
        // A voxel on a volume face has no neighbour beyond it. Treat the
        // outside as unlabelled so a structure clipped by the field of view
        // still closes instead of opening into a hole.
        const interior =
          x > 0 &&
          x < nx - 1 &&
          y > 0 &&
          y < ny - 1 &&
          z > 0 &&
          z < nz - 1 &&
          src[i - 1] > floor &&
          src[i + 1] > floor &&
          src[i - rowStride] > floor &&
          src[i + rowStride] > floor &&
          src[i - sliceStride] > floor &&
          src[i + sliceStride] > floor
        if (interior) out[i] = floor
      }
    }
  }
  return out
}

/**
 * Opacity for a loaded channel at its stack position.
 *
 * Volume 0 is niivue's base layer and is normally drawn opaque, which is right
 * for a raw fluorescence channel. It is wrong for a mask: a segmentation is a
 * filled solid, so an opaque one hides every channel stacked on it — that is
 * what made a seg-only selection render as a single flat blob, with the whole
 * nucleus of `DNA_seg` swallowing the structures inside it. When the base layer
 * is a mask, fade it like the rest.
 *
 * A hollowed mask is the opposite case and takes the plain overlay opacity: a
 * one-voxel shell occludes almost nothing and barely overlaps its neighbours,
 * so it does not need the extra fade a filled one does — and at the fade a
 * filled stack wants, a shell is too thin to see at all.
 */
export function opacityFor(
  entry: ApiVolume | undefined,
  index: number,
  overlayOpacity: number,
  hollow: boolean,
): number {
  const seg = entry ? isSegChannel(entry) : false
  if (!seg) return index === 0 ? 1 : overlayOpacity
  return hollow ? overlayOpacity : overlayOpacity * SEG_OPACITY_SCALE
}

/**
 * Intensities bracketing the top `lowFrac` / `highFrac` of a channel's voxels.
 *
 * A 256-bin histogram over the channel's own range, walked from the bright end.
 * Bin resolution is plenty here: the source is uint8, so the bins land on the
 * actual sample values rather than approximating them.
 *
 * Both fractions are of the whole volume, not of the above-floor voxels, which
 * is what makes one constant work across channels: a sparse structure and a
 * dense one differ mostly in how many voxels sit above the floor, and taking a
 * fixed share of the total lets the sparse one keep proportionally more of its
 * own signal.
 */
export function percentileWindow(
  img: TypedVoxelArray,
  min: number,
  max: number,
  lowFrac: number,
  highFrac: number,
): { calMin: number; calMax: number } {
  const range = max - min
  if (!(range > 0)) return { calMin: min, calMax: max }
  const bins = new Uint32Array(256)
  const scale = 255 / range
  for (let i = 0; i < img.length; i++) {
    const b = Math.round((img[i] - min) * scale)
    bins[b < 0 ? 0 : b > 255 ? 255 : b]++
  }
  const lowTarget = img.length * lowFrac
  const highTarget = img.length * highFrac
  const value = (bin: number): number => min + (bin * range) / 255
  let seen = 0
  let calMax = max
  let calMin = min
  // An explicit flag, not a `calMax === max` sentinel: when the saturation
  // crossing lands in the TOP bin, value(255) equals max, so a sentinel
  // re-matches on the next bin and silently slides calMax one bin low.
  let maxSet = false
  for (let b = 255; b >= 0; b--) {
    seen += bins[b]
    if (!maxSet && seen >= highTarget) {
      calMax = value(b)
      maxSet = true
    }
    if (seen >= lowTarget) {
      calMin = value(b)
      break
    }
  }
  // A channel flat enough that one bin crosses both targets would collapse to a
  // zero-width window, which paints every voxel at the top of the colormap.
  // Reset BOTH ends: when the crossing lands in the top bin (clipped
  // saturation), calMin is already max, so widening calMax alone cannot help.
  if (calMax <= calMin) {
    calMin = min
    calMax = max
  }
  return { calMin, calMax }
}

// Overlay opacity is a per-channel gain in an additive blend, so N channels at
// a fixed opacity sum toward white: at the 0.6 that suits a two-channel view, a
// full 16-channel stack blows out its dense core. Scale the default with the
// count (verified: 16 raw Allen channels are legible near 0.12, unreadable at
// 0.6). Anchored so the common 2-channel case still lands on 0.6. Once the user
// moves the slider it is theirs, and this stops overriding it.
//
// Hollowed masks are exempt: shells cover a small fraction of the voxels and
// hardly overlap, so the sum stays far from saturation however many are
// stacked, and scaling them down just makes them invisible.
export function suggestedOpacity(
  entries: ApiVolume[],
  hollow: boolean,
): number {
  if (entries.length < 2) return 0.6
  if (hollow && entries.every(isSegChannel)) return 0.6
  return Math.min(0.6, Math.max(0.12, 1.2 / entries.length))
}

/**
 * Serialize async loads so the LATEST scheduled one always commits last.
 *
 * A bare version token is not enough for viewer loads: it can gate the
 * post-load bookkeeping, but the load itself (`nv.loadVolumes`) mutates the
 * shared viewer the moment it resolves — an old request finishing after a
 * newer one would replace the scene, then bail at the token check, leaving the
 * screen showing one selection and the bookkeeping describing another.
 *
 * Chaining every load through one promise removes that interleaving: loads run
 * strictly one at a time in schedule order, so the newest scheduled load is
 * always the last to touch the viewer. A load that is superseded while still
 * QUEUED is skipped outright (never runs, never mutates); one superseded while
 * RUNNING finishes its viewer mutation but skips its bookkeeping via
 * `isCurrent`, and the newer load then overwrites the viewer right after.
 *
 * A rejected task does not break the chain; later loads still run.
 */
export class SerialLoadQueue {
  private chain: Promise<void> = Promise.resolve()
  private latest = 0

  schedule(task: (isCurrent: () => boolean) => Promise<void>): Promise<void> {
    this.latest += 1
    const token = this.latest
    const isCurrent = (): boolean => token === this.latest
    const run = this.chain.then(async () => {
      if (!isCurrent()) return // superseded while queued: skip entirely
      await task(isCurrent)
    })
    this.chain = run.catch(() => {})
    return run
  }
}

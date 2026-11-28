import type NiiVue from '@niivue/niivue'
import type { NVImage, VolumeFrameSource } from '@niivue/niivue'
import type { OhifCineService, OhifServicesManager } from './ohif-types'

// A dynamic series (4D PET) converts to one 4D NIfTI. Cornerstone shares one
// dynamic volume between panes and steps its time point for all of them; here
// every pane shows a 3D volume of the current frame, read from one shared
// buffer through a core frame source, so N panes hold one copy of the series.

// NIfTI datatype -> typed array.
type View = new (b: ArrayBuffer, offset: number, n: number) => ArrayLike<number>
const ARRAYS: Record<number, View> = {
  2: Uint8Array,
  4: Int16Array,
  8: Int32Array,
  16: Float32Array,
  64: Float64Array,
  256: Int8Array,
  512: Uint16Array,
  768: Uint32Array,
}

/**
 * Split a 4D uncompressed NIfTI-1 (little-endian, as dcm2niix writes) into a
 * 3D file of frame 0 and a frame source over all frames, grouped by `series`.
 * Null when `image` is not 4D.
 */
export async function split4D(
  image: File,
  series?: string,
): Promise<{ image: File; frames: VolumeFrameSource } | null> {
  const buf = await image.arrayBuffer()
  const view = new DataView(buf)
  if (view.getInt32(0, true) !== 348) return null
  const dim = (i: number) => view.getInt16(40 + 2 * i, true)
  const count = dim(4)
  const View = ARRAYS[view.getInt16(70, true)]
  if (dim(0) < 4 || count < 2 || !View) return null
  const offset = view.getFloat32(108, true)
  const bytes = view.getInt16(72, true) / 8
  const voxels = dim(1) * dim(2) * dim(3)
  const frameBytes = voxels * bytes
  // Frames are views into `buf` (NIfTI-1 vox_offset is a multiple of 16).
  const head = buf.slice(0, offset)
  const headView = new DataView(head)
  headView.setInt16(40, 3, true)
  headView.setInt16(48, 1, true)
  const frames = Math.min(
    count,
    Math.floor((buf.byteLength - offset) / frameBytes),
  )
  return {
    image: new File([head, buf.slice(offset, offset + frameBytes)], image.name),
    frames: {
      count: frames,
      frame: 0,
      // A refreshed display set may have another shape: its own group.
      group: seriesGroup(
        series && `${series}:${dim(1)}x${dim(2)}x${dim(3)}x${frames}`,
      ),
      load: async (f) => new View(buf, offset + f * frameBytes, voxels),
    },
  }
}

// One group per display set: a reconversion (the conversion cache keeps four)
// must rejoin the panes already showing that series. A group no pane shows is
// not rejoined, so a reopen starts fresh: its frame and computed result are
// stale. Weak, so a group (and the buffers its computed result holds) lives
// only as long as a volume or a pending load holds it; eager pruning raced
// loadVolumes, which emits volumeRemoved before its new volume is shown.
const groups = new Map<string, WeakRef<object>>()
const seriesGroup = (series: string | undefined): object => {
  if (series === undefined) return {}
  const old = groups.get(series)?.deref()
  const group = old && isShown(old) ? old : {}
  groups.set(series, new WeakRef(group))
  return group
}
const isShown = (group: object): boolean =>
  [...panes.values()].some((nv) =>
    nv.volumes.some((v) => v.frameSource?.group === group),
  )

/** The frame-source volume (base or overlay) a pane shows, if any. */
const sourceVolume = (nv: NiiVue): NVImage | undefined =>
  nv.volumes.find((v) => v.frameSource)

// Every pane showing a 4D series, for frame sync and cine.
const panes = new Map<string, NiiVue>()
const listeners = new Set<() => void>()
// The frame each series shows, for panes that load it later.
const current = new WeakMap<object, number>()

/** Show `frame` of the series `group` on every pane holding it. */
export async function setFrame(group: object, frame: number): Promise<unknown> {
  if (computedShown.has(group)) await showFrames(group)
  current.set(group, frame)
  const steps: Promise<void>[] = []
  for (const nv of panes.values())
    for (const v of nv.volumes)
      if (v.frameSource?.group === group && v.id)
        steps.push(nv.setFrame4D(v.id, frame))
  return Promise.all(steps)
}

// A computed volume (kinetics.ts) shown in place of a series' frame: written
// into each pane's frame buffer, requantized to its datatype with its own
// scaling; the series' scaling is kept here until the frame returns. The
// result stays for panes joining meanwhile.
interface Computed {
  data: Float32Array
  min: number
  max: number
  /** Per datatype: requantized samples, slope, intercept. */
  raw: Map<unknown, [ArrayLike<number>, number, number]>
  saved: Map<NVImage, [number, number]>
}
const computedShown = new WeakMap<object, Computed>()
/** Each volume's last computed upload: a newer one waits for it to land. */
const uploads = new WeakMap<NVImage, Promise<unknown>>()
const INT_RANGE = new Map<unknown, [number, number]>([
  [Int8Array, [-128, 127]],
  [Uint8Array, [0, 255]],
  [Int16Array, [-32768, 32767]],
  [Uint16Array, [0, 65535]],
  [Int32Array, [-(2 ** 31), 2 ** 31 - 1]],
  [Uint32Array, [0, 2 ** 32 - 1]],
])

const groupVolumes = (group: object) =>
  [...panes.values()].flatMap((nv) =>
    nv.volumes.flatMap((v, i) =>
      v.frameSource?.group === group ? [{ nv, v, i }] : [],
    ),
  )

/** The series' scl_slope/inter (its own while a computed volume is shown). */
export function frameScale(group: object, v: NVImage): [number, number] {
  return (
    computedShown.get(group)?.saved.get(v) ?? [
      v.hdr?.scl_slope || 1,
      v.hdr?.scl_inter || 0,
    ]
  )
}

export const isComputedShown = (group: object): boolean =>
  computedShown.has(group)

/** Show scaled `data` (native order, one frame) on every pane of `group`. */
export async function showComputed(
  group: object,
  data: Float32Array,
): Promise<void> {
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  for (const x of data) {
    if (x < min) min = x
    if (x > max) max = x
  }
  const saved = computedShown.get(group)?.saved ?? new Map()
  const c: Computed = { data, min, max, raw: new Map(), saved }
  computedShown.set(group, c)
  // Paused as cornerstone's swap to a computed display set stops the cine.
  for (const id of groupPanes(group))
    cineService?.setCine?.({ id, isPlaying: false })
  const volumes = groupVolumes(group)
  // A frame step still loading would land over the computed samples.
  for (const { nv, v } of volumes) cancelFrame(nv, v)
  // The shown frame is the one to return to.
  const shown = volumes[0]?.v.frameSource?.frame
  if (shown !== undefined) current.set(group, shown)
  for (const { nv, v, i } of volumes) {
    // A newer compute (or showFrames) took over while a pane updated.
    if (computedShown.get(group) !== c) return
    await installComputed(group, c, nv, v, i)
  }
}

/** Abort `v`'s pending frame request (setFrame4D to its own frame does). */
function cancelFrame(nv: NiiVue, v: NVImage): void {
  if (v.id && v.frameSource)
    void nv.setFrame4D(v.id, v.frameSource.frame).catch(() => {})
}

/** Write `c` into volume `i` of `nv`, keeping its series' scaling. */
async function installComputed(
  group: object,
  c: Computed,
  nv: NiiVue,
  v: NVImage,
  i: number,
): Promise<void> {
  if (!v.img || !v.hdr) return
  if (!c.saved.has(v)) c.saved.set(v, frameScale(group, v))
  const type = v.img.constructor
  let entry = c.raw.get(type)
  if (!entry) {
    const range = INT_RANGE.get(type)
    if (!range) entry = [c.data, 1, 0]
    else {
      const [lo, hi] = range
      const { data, min, max } = c
      const s = max > min ? (max - min) / (hi - lo) : 1
      const b = min - s * lo
      const q = new (type as Int16ArrayConstructor)(data.length)
      for (let k = 0; k < data.length; k++)
        q[k] = Math.round(((data[k] as number) - b) / s)
      entry = [q, s, b]
    }
    c.raw.set(type, entry)
  }
  // An older upload landing after this one would leave its voxels under these scales.
  await uploads.get(v)
  if (computedShown.get(group) !== c) return
  v.hdr.scl_slope = entry[1]
  v.hdr.scl_inter = entry[2]
  const done = nv.updateVolumeData(i, entry[0])
  uploads.set(
    v,
    done.catch(() => {}),
  )
  await done
  // The crosshair readout follows locationChange: re-sample it (setFrame4D does).
  nv.createOnLocationChange()
}

/** Back from a computed volume to the series' shown frame. */
export async function showFrames(group: object): Promise<void> {
  const saved = computedShown.get(group)?.saved
  computedShown.delete(group)
  if (!saved) return
  // The group's frame: a step cancelled midway left panes on their own.
  const frame = current.get(group)
  for (const { nv, v, i } of groupVolumes(group)) {
    const scale = saved.get(v)
    if (!scale || !v.hdr || !v.frameSource) continue
    ;[v.hdr.scl_slope, v.hdr.scl_inter] = scale
    if (frame !== undefined && frame !== v.frameSource.frame && v.id) {
      await nv.setFrame4D(v.id, frame)
      continue
    }
    const signal = new AbortController().signal
    const data = await v.frameSource.load(v.frameSource.frame, signal)
    await uploads.get(v)
    // A compute shown during the load owns the volumes now.
    if (computedShown.has(group)) return
    await nv.updateVolumeData(i, data)
    nv.createOnLocationChange()
  }
}

/** The 4D series of a pane (its frame source), when it shows one. */
export function paneFrames(viewportId: string | undefined) {
  const nv = viewportId === undefined ? undefined : panes.get(viewportId)
  return nv && sourceVolume(nv)?.frameSource
}

/** The panes showing the series `group`. */
export const groupPanes = (group: object): string[] =>
  [...panes.keys()].filter((id) => paneFrames(id)?.group === group)

/** The first pane showing a 4D series (the panel's fallback target). */
export const anyFramesPane = (): string | undefined =>
  [...panes.keys()].find((id) => paneFrames(id))

/** Called after every frame change, late-pane catch-up included (the panel's readout). */
export function onFrame(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// One clock for every 4D pane. OHIF's cineService has no change event for
// setCine, so the clock reads its state each animation frame: a playing pane
// steps its series at the pane's frameRate, as cornerstone's dynamic cine.
let cineService: OhifCineService | undefined
let raf = 0
const due = new Map<object, number>()
const pending = new Set<object>()

function tick(now: number) {
  raf = anyFramesPane() ? requestAnimationFrame(tick) : 0
  const cines = cineService?.getState?.()?.cines ?? {}
  const stepped = new Set<object>()
  for (const id of panes.keys()) {
    const cine = cines[id]
    const frames = cine?.isPlaying && paneFrames(id)
    // A computed volume holds until the panel's 4D button or a frame step.
    if (!frames || stepped.has(frames.group) || computedShown.has(frames.group))
      continue
    stepped.add(frames.group)
    const period = 1000 / Math.min(50, Math.max(1, cine.frameRate ?? 24))
    const next = due.get(frames.group) ?? now
    if (now < next || pending.has(frames.group)) continue
    // Keep the cadence across late frames, but never queue a burst.
    due.set(frames.group, Math.max(next + period, now - period))
    pending.add(frames.group)
    void setFrame(frames.group, (frames.frame + 1) % frames.count)
      .catch(() => {})
      .finally(() => pending.delete(frames.group))
  }
  for (const g of due.keys()) if (!stepped.has(g)) due.delete(g)
}

/** Bring a late volume to its series' frame, then its computed volume if shown. */
async function catchUp(nv: NiiVue, v: NVImage): Promise<void> {
  const source = v.frameSource
  const group = source?.group
  if (!source || !group || !v.id) return
  const f = current.get(group)
  // The frame first: one landing later would overwrite computed samples.
  // A reload of the display set may have fewer frames than the one remembered.
  if (f && f < source.count) await nv.setFrame4D(v.id, f)
  const c = computedShown.get(group)
  if (c && !c.saved.has(v))
    await installComputed(group, c, nv, v, nv.volumes.indexOf(v))
}

/**
 * Join frame sync and the cine clock; the returned function leaves. The pane
 * writes the frame it shows to `data-frame` on `element` (e2e evidence).
 */
export function joinFrames(
  viewportId: string,
  nv: NiiVue,
  servicesManager: OhifServicesManager | undefined,
  element: HTMLElement | null,
): () => void {
  cineService = servicesManager?.services?.cineService
  panes.set(viewportId, nv)
  // Set while this pane catches up to the series frame after a load.
  let catchingUp = false
  const onFrameChange = () => {
    const source = sourceVolume(nv)?.frameSource
    // A frame NiiVue changed itself (hotkey, graph click) becomes the series frame.
    if (source && !catchingUp && current.get(source.group) !== source.frame)
      void setFrame(source.group, source.frame).catch(() => {})
    if (element && source) {
      element.dataset.frame = String(source.frame)
      element.dataset.frames = String(source.count)
    } else if (element) {
      delete element.dataset.frame
      delete element.dataset.frames
    }
    for (const l of listeners) l()
  }
  // A late pane (stage switch, fusion overlay) joins the series' frame.
  const onVolumeLoaded = () => {
    const v = sourceVolume(nv)
    if (v?.id && v.frameSource) {
      catchingUp = true
      void catchUp(nv, v)
        .catch(() => {})
        .finally(() => {
          catchingUp = false
        })
    }
    // The cine clock runs only while some pane shows a 4D series.
    if (v && !raf) raf = requestAnimationFrame(tick)
    onFrameChange()
  }
  nv.addEventListener('frameChange', onFrameChange)
  nv.addEventListener('volumeLoaded', onVolumeLoaded)
  // Removing the last 4D volume must hide the panel's frame controls.
  nv.addEventListener('volumeRemoved', onFrameChange)
  return () => {
    nv.removeEventListener('frameChange', onFrameChange)
    nv.removeEventListener('volumeLoaded', onVolumeLoaded)
    nv.removeEventListener('volumeRemoved', onFrameChange)
    if (panes.get(viewportId) === nv) panes.delete(viewportId)
    if (element) {
      delete element.dataset.frame
      delete element.dataset.frames
    }
    // destroy() emits no volumeRemoved: an unmounted 4D pane must still hide the panel's controls.
    for (const l of listeners) l()
  }
}

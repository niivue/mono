import type NiiVue from '@niivue/niivue'
import type { NVImage, VolumeFrameSource } from '@niivue/niivue'
import type { OhifServicesManager } from './ohif-types'

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
 * 3D file of frame 0 and a frame source over all frames. Null when `image` is
 * not 4D.
 */
export async function split4D(
  image: File,
): Promise<{ image: File; frames: VolumeFrameSource } | null> {
  const view = new DataView(await image.slice(0, 352).arrayBuffer())
  if (view.byteLength < 352 || view.getInt32(0, true) !== 348) return null
  const dim = (i: number) => view.getInt16(40 + 2 * i, true)
  const count = dim(4)
  const View = ARRAYS[view.getInt16(70, true)]
  if (dim(0) < 4 || count < 2 || !View) return null
  const offset = view.getFloat32(108, true)
  const bytes = view.getInt16(72, true) / 8
  const voxels = dim(1) * dim(2) * dim(3)
  const frameBytes = voxels * bytes
  const data = await image.slice(offset).arrayBuffer()
  const head = await image.slice(0, offset).arrayBuffer()
  const headView = new DataView(head)
  headView.setInt16(40, 3, true)
  headView.setInt16(48, 1, true)
  return {
    image: new File([head, data.slice(0, frameBytes)], image.name),
    frames: {
      count: Math.min(count, Math.floor(data.byteLength / frameBytes)),
      frame: 0,
      group: {},
      load: async (f) => new View(data, f * frameBytes, voxels),
    },
  }
}

/** The frame-source volume (base or overlay) a pane shows, if any. */
const sourceVolume = (nv: NiiVue): NVImage | undefined =>
  nv.volumes.find((v) => v.frameSource)

// Every pane showing a 4D series, for frame sync and cine.
const panes = new Map<string, NiiVue>()
const listeners = new Set<() => void>()
// The frame each series shows, for panes that load it later.
const current = new WeakMap<object, number>()

/** Show `frame` of the series `group` on every pane holding it. */
export function setFrame(group: object, frame: number): Promise<unknown> {
  current.set(group, frame)
  const steps: Promise<void>[] = []
  for (const nv of panes.values())
    for (const v of nv.volumes)
      if (v.frameSource?.group === group && v.id)
        steps.push(nv.setFrame4D(v.id, frame))
  return Promise.all(steps).finally(() => {
    for (const l of listeners) l()
  })
}

/** The 4D series of a pane (its frame source), when it shows one. */
export function paneFrames(viewportId: string | undefined) {
  const nv = viewportId === undefined ? undefined : panes.get(viewportId)
  const source = nv && sourceVolume(nv)?.frameSource
  return (
    source && { group: source.group, frame: source.frame, count: source.count }
  )
}

/** The first pane showing a 4D series (the panel's fallback target). */
export const anyFramesPane = (): string | undefined =>
  [...panes.keys()].find((id) => paneFrames(id))

/** Called after every frame step (the panel's readout). */
export function onFrame(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

type Cine = { isPlaying?: boolean; frameRate?: number }
interface CineServiceLike {
  getState?: () => { cines?: Record<string, Cine> } | undefined
}

// One clock for every 4D pane. OHIF's cineService has no change event for
// setCine, so the clock reads its state each animation frame: a playing pane
// steps its series at the pane's frameRate, as cornerstone's dynamic cine.
let cineService: CineServiceLike | undefined
let raf = 0
const due = new Map<object, number>()
const pending = new Set<object>()

function tick(now: number) {
  raf = panes.size ? requestAnimationFrame(tick) : 0
  const cines = cineService?.getState?.()?.cines ?? {}
  const stepped = new Set<object>()
  for (const id of panes.keys()) {
    const cine = cines[id]
    const frames = cine?.isPlaying && paneFrames(id)
    if (!frames || stepped.has(frames.group)) continue
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
  cineService = servicesManager?.services?.cineService as CineServiceLike
  panes.set(viewportId, nv)
  const onFrameChange = () => {
    const source = sourceVolume(nv)?.frameSource
    if (!element || !source) return
    element.dataset.frame = String(source.frame)
    element.dataset.frames = String(source.count)
  }
  // A late pane (stage switch, fusion overlay) joins the series' frame.
  const onVolumeLoaded = () => {
    const v = sourceVolume(nv)
    const f = v?.frameSource && current.get(v.frameSource.group)
    if (v?.id && f) void nv.setFrame4D(v.id, f).catch(() => {})
    onFrameChange()
    for (const l of listeners) l()
  }
  nv.addEventListener('frameChange', onFrameChange)
  nv.addEventListener('volumeLoaded', onVolumeLoaded)
  if (!raf) raf = requestAnimationFrame(tick)
  return () => {
    nv.removeEventListener('frameChange', onFrameChange)
    nv.removeEventListener('volumeLoaded', onVolumeLoaded)
    if (panes.get(viewportId) === nv) panes.delete(viewportId)
    if (element) {
      delete element.dataset.frame
      delete element.dataset.frames
    }
  }
}

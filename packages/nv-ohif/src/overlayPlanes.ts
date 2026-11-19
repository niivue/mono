import type NiiVue from '@niivue/niivue'
import type { OhifExtensionManager } from './ohif-types'
import { toolMode } from './segEdit'

// OHIF's ImageOverlayViewer (enabled by default in the basic modes) draws a
// DICOM image's overlay planes (60xx). dcm2niix writes each as a uint8
// `<stem>_ROI<n>.nii` on the image grid; the pane shows the first as its
// drawing while the tool is Enabled in its group and no SEG holds the drawing.
// A 4D image's plane is 4D too (one volume per frame, a two-frame surview):
// the pane shows the plane's volume for the frame it shows.
// ponytail: first plane only (one is typical); merge planes if a study needs it.

type Planes = {
  files: File[]
  em: OhifExtensionManager | undefined
  toolGroupId: string
}
const planes = new WeakMap<NiiVue, Planes>()
// The plane drawing each pane shows; a drawing that replaced it is not ours.
const shown = new WeakMap<NiiVue, NiiVue['drawingVolume']>()
// drawingGeneration of a plane load still reading.
const pending = new WeakMap<NiiVue, number>()
// Holds on each pane's drawing (SEG, RTSTRUCT, PT label): planes stay off
// until the last releases.
const holds = new WeakMap<NiiVue, number>()
const held = (nv: NiiVue) => (holds.get(nv) ?? 0) > 0
// The SEG/RTSTRUCT holds among them: those own the drawing, even while loading.
const ownerHolds = new WeakMap<NiiVue, number>()

/** Whether a SEG or RTSTRUCT shows, or is loading, `nv`'s drawing. */
export const drawingOwned = (nv: NiiVue) => (ownerHolds.get(nv) ?? 0) > 0
// The frame each pane's plane drawing was loaded for.
const shownFrame = new WeakMap<NiiVue, number>()
const listening = new WeakSet<NiiVue>()
// Volumes per plane file, once read: a 3D plane never reloads on a frame step.
const planeFrames = new WeakMap<File, number>()

const NII_HEADER = 348
const paneFrame = (nv: NiiVue): number => {
  const v = nv.volumes[0]
  return v?.frameSource?.frame ?? v?.frame4D ?? 0
}

/**
 * Volume `t` of a 4D NIfTI-1 uint8 plane as a 3D .nii (header with dim[0] 3,
 * dim[4] 1, then that volume's bytes); undefined past its last volume. A 3D,
 * gzipped or unreadable plane comes back as is: loadDrawing reads its first
 * volume.
 */
export async function planeFrame(
  file: File,
  t: number,
): Promise<File | undefined> {
  if (t === 0 || file.name.endsWith('.gz')) return file
  const head = new Uint8Array(await file.slice(0, NII_HEADER).arrayBuffer())
  if (head.length < NII_HEADER) return file
  const dv = new DataView(head.buffer)
  const le = dv.getInt32(0, true) === NII_HEADER
  if (!le && dv.getInt32(0, false) !== NII_HEADER) return file
  const dim = (i: number) => dv.getInt16(40 + 2 * i, le)
  const frames = dim(0) >= 4 ? dim(4) : 1
  planeFrames.set(file, frames)
  if (frames > 1 && t >= frames) return undefined
  if (dv.getInt16(70, le) !== 2 || t >= frames) return file
  const offset = Math.floor(dv.getFloat32(108, le))
  const frameBytes = dim(1) * dim(2) * dim(3)
  const header = new Uint8Array(await file.slice(0, offset).arrayBuffer())
  const hv = new DataView(header.buffer)
  hv.setInt16(40, 3, le)
  hv.setInt16(48, 1, le)
  const start = offset + t * frameBytes
  return new File([header, file.slice(start, start + frameBytes)], file.name)
}

function closeOwn(nv: NiiVue): void {
  if (pending.has(nv) && pending.get(nv) === nv.drawingGeneration)
    nv.cancelDrawingLoad()
  pending.delete(nv)
  if (shown.has(nv) && nv.drawingVolume === shown.get(nv)) nv.closeDrawing()
  shown.delete(nv)
  shownFrame.delete(nv)
}

/**
 * Give `nv`'s drawing to a SEG/RT: drops the plane synchronously, before the
 * SEG reads drawingGeneration. The release shows the planes again. A PT label
 * passes `owner` false: it gives way to a SEG/RT (drawingOwned).
 */
export function holdOverlayPlanes(nv: NiiVue, owner = true): () => void {
  holds.set(nv, (holds.get(nv) ?? 0) + 1)
  if (owner) ownerHolds.set(nv, (ownerHolds.get(nv) ?? 0) + 1)
  closeOwn(nv)
  let released = false
  return () => {
    if (released) return
    released = true
    holds.set(nv, (holds.get(nv) ?? 1) - 1)
    if (owner) ownerHolds.set(nv, (ownerHolds.get(nv) ?? 1) - 1)
    if (held(nv)) return
    const p = planes.get(nv)
    if (p) void refreshOverlayPlanes(nv, p.em, p.toolGroupId)
  }
}

/** Show or hide `nv`'s overlay planes by the tool's mode in its group. */
export async function refreshOverlayPlanes(
  nv: NiiVue,
  em: OhifExtensionManager | undefined,
  toolGroupId: string,
): Promise<void> {
  const plane = planes.get(nv)?.files[0]
  if (!plane || held(nv)) return
  const frame = paneFrame(nv)
  const file = frame ? await planeFrame(plane, frame) : plane
  // Re-read after the await: a release, swap or frame step meanwhile wins.
  if (planes.get(nv)?.files[0] !== plane || held(nv)) return
  if (paneFrame(nv) !== frame) return refreshOverlayPlanes(nv, em, toolGroupId)
  const on = toolMode(em, toolGroupId, 'ImageOverlayViewer') === 'Enabled'
  if (!file) {
    // No plane for this frame: show none, and reload when the pane steps back.
    closeOwn(nv)
    if (on) shownFrame.set(nv, frame)
    return
  }
  if (on && !nv.drawingVolume) {
    // Straight to loadDrawing (no await before it): core's drawing generation
    // guard starts there, so a segmentation made meanwhile is not overwritten.
    // loadDrawing arms the pen; an overlay plane is display only, so a drag on
    // the pane must not paint into it.
    const armed = nv.drawIsEnabled
    const load = nv.loadDrawing(file)
    const generation = nv.drawingGeneration
    pending.set(nv, generation)
    // Not loaded: a segmentation superseded it and owns the pen.
    const loaded = await load
    if (pending.get(nv) === generation) pending.delete(nv)
    if (!loaded) return
    if (!armed) nv.drawIsEnabled = false
    if (
      planes.get(nv)?.files[0] === plane &&
      paneFrame(nv) === frame &&
      !held(nv) &&
      toolMode(em, toolGroupId, 'ImageOverlayViewer') === 'Enabled'
    ) {
      shown.set(nv, nv.drawingVolume)
      shownFrame.set(nv, frame)
      return
    }
    // Superseded mid-load (another image, or the tool turned off): drop it
    // and show what holds now.
    nv.closeDrawing()
    return refreshOverlayPlanes(nv, em, toolGroupId)
  } else if (!on) closeOwn(nv)
}

/** The overlay planes of the image `nv` now shows (none clears them). */
export function setOverlayPlanes(
  nv: NiiVue,
  files: File[] | undefined,
  em: OhifExtensionManager | undefined,
  toolGroupId: string,
): Promise<void> {
  if (planes.get(nv)?.files !== files) closeOwn(nv)
  planes.set(nv, { files: files ?? [], em, toolGroupId })
  if (!listening.has(nv)) {
    listening.add(nv)
    // A 4D plane steps with the pane: swap the drawing to the new frame's.
    nv.addEventListener('frameChange', () => {
      const p = planes.get(nv)
      const plane = p?.files[0]
      if (!plane || shownFrame.get(nv) === paneFrame(nv)) return
      if (planeFrames.get(plane) === 1 || plane.name.endsWith('.gz')) return
      if (!shownFrame.has(nv) && !pending.has(nv)) return
      closeOwn(nv)
      void refreshOverlayPlanes(nv, p.em, p.toolGroupId)
    })
  }
  return refreshOverlayPlanes(nv, em, toolGroupId)
}

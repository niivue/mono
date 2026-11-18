import type NiiVue from '@niivue/niivue'
import type { OhifExtensionManager } from './ohif-types'
import { toolMode } from './segEdit'

// OHIF's ImageOverlayViewer (enabled by default in the basic modes) draws a
// DICOM image's overlay planes (60xx). dcm2niix writes each as a uint8
// `<stem>_ROI<n>.nii` on the image grid; the pane shows the first as its
// drawing while the tool is Enabled in its group and no SEG holds the drawing.
// A 4D image's plane is 4D too (one volume per frame, a two-frame surview):
// loadDrawing keeps its first volume, the frame the pane shows first.
// ponytail: first plane only (one is typical); merge planes if a study needs it.
// ponytail: first frame's overlay only; follow the frame if a study steps them.

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
// Panes whose drawing a SEG or RTSTRUCT owns: planes stay off.
const held = new WeakSet<NiiVue>()

function closeOwn(nv: NiiVue): void {
  if (pending.get(nv) === nv.drawingGeneration) nv.cancelDrawingLoad()
  pending.delete(nv)
  if (shown.has(nv) && nv.drawingVolume === shown.get(nv)) nv.closeDrawing()
  shown.delete(nv)
}

/**
 * Give `nv`'s drawing to a SEG/RT: drops the plane synchronously, before the
 * SEG reads drawingGeneration. The release shows the planes again.
 */
export function holdOverlayPlanes(nv: NiiVue): () => void {
  held.add(nv)
  closeOwn(nv)
  return () => {
    held.delete(nv)
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
  const file = planes.get(nv)?.files[0]
  if (!file || held.has(nv)) return
  const on = toolMode(em, toolGroupId, 'ImageOverlayViewer') === 'Enabled'
  if (on && !nv.drawingVolume) {
    // Straight to loadDrawing (no await before it): core's drawing generation
    // guard starts there, so a segmentation made meanwhile is not overwritten.
    // A 4D plane shows its first volume.
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
      planes.get(nv)?.files[0] === file &&
      !held.has(nv) &&
      toolMode(em, toolGroupId, 'ImageOverlayViewer') === 'Enabled'
    ) {
      shown.set(nv, nv.drawingVolume)
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
  return refreshOverlayPlanes(nv, em, toolGroupId)
}

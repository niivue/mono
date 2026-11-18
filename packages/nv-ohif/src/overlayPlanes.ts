import type NiiVue from '@niivue/niivue'
import type { OhifExtensionManager } from './ohif-types'
import { toolMode } from './segEdit'

// OHIF's ImageOverlayViewer (enabled by default in the basic modes) draws a
// DICOM image's overlay planes (60xx). dcm2niix writes each as a uint8
// `<stem>_ROI<n>.nii` on the image grid; the pane shows the first as its
// drawing while the tool is Enabled in its group and no SEG holds the drawing.
// ponytail: first plane only (one is typical); merge planes if a study needs it.

const planes = new WeakMap<NiiVue, File[]>()
const shown = new WeakSet<NiiVue>()

/** Show or hide `nv`'s overlay planes by the tool's mode in its group. */
export async function refreshOverlayPlanes(
  nv: NiiVue,
  em: OhifExtensionManager | undefined,
  toolGroupId: string,
): Promise<void> {
  const file = planes.get(nv)?.[0]
  if (!file) return
  const on = toolMode(em, toolGroupId, 'ImageOverlayViewer') === 'Enabled'
  if (on && !nv.drawingVolume) {
    if (!(await nv.loadDrawing(file))) return
    if (
      planes.get(nv)?.[0] === file &&
      toolMode(em, toolGroupId, 'ImageOverlayViewer') === 'Enabled'
    ) {
      shown.add(nv)
      return
    }
    // Superseded mid-load (another image, or the tool turned off): drop it
    // and show what holds now.
    nv.closeDrawing()
    return refreshOverlayPlanes(nv, em, toolGroupId)
  } else if (!on && shown.has(nv)) {
    nv.closeDrawing()
    shown.delete(nv)
  }
}

/** The overlay planes of the image `nv` now shows (none clears them). */
export function setOverlayPlanes(
  nv: NiiVue,
  files: File[] | undefined,
  em: OhifExtensionManager | undefined,
  toolGroupId: string,
): Promise<void> {
  if (shown.has(nv) && planes.get(nv) !== files) {
    nv.closeDrawing()
    shown.delete(nv)
  }
  planes.set(nv, files ?? [])
  return refreshOverlayPlanes(nv, em, toolGroupId)
}

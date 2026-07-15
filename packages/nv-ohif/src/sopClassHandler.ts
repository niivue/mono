import type { OhifDisplaySet, OhifSopClassHandlerEntry } from './ohif-types'

export const NIIVUE_SOP_CLASS_HANDLER_NAME = 'niivue-wsi'
// The fully-qualified module id a mode references in `sopClassHandlers` /
// `displaySetsToDisplay` (format: `<extensionId>.sopClassHandlerModule.<name>`).
export const NIIVUE_SOP_CLASS_HANDLER_ID =
  '@niivue/nv-ohif.sopClassHandlerModule.niivue-wsi'

// VL Whole Slide Microscopy Image Storage. NiiVue renders these as a tiled
// deep-zoom via NVSlide (see wsiTileSource / NiivueViewport's `wsi` branch).
const VL_WHOLE_SLIDE_MICROSCOPY_IMAGE_STORAGE = '1.2.840.10008.5.1.4.1.1.77.1.6'

interface WsiInstance extends Record<string, unknown> {
  imageId?: string
  SeriesInstanceUID?: string
  StudyInstanceUID?: string
  SeriesDescription?: string
  SeriesNumber?: unknown
  SOPClassUID?: string
}

/**
 * Build the NiiVue display set for a whole-slide (SM) series. Unlike OHIF's
 * built-in `DicomMicroscopySopClassHandler`, this does NOT set
 * `viewportType: WHOLE_SLIDE` — that field forces OHIF's own microscopy
 * viewport and would override the mode's viewport routing. Omitting it lets the
 * series land in the NiiVue viewport, which renders it with NVSlide.
 *
 * A mode that wants NiiVue to own whole-slide imaging registers this handler in
 * its `sopClassHandlers` (and `displaySetsToDisplay`) INSTEAD of OHIF's
 * `wsiSopClassHandler`; otherwise both handlers claim the SM SOP class and two
 * competing display sets are produced.
 */
export function getNiivueSopClassHandlerModule(): OhifSopClassHandlerEntry[] {
  return [
    {
      name: NIIVUE_SOP_CLASS_HANDLER_NAME,
      sopClassUids: [VL_WHOLE_SLIDE_MICROSCOPY_IMAGE_STORAGE],
      getDisplaySetsFromSeries: (
        instances: ReadonlyArray<Record<string, unknown>>,
      ): ReadonlyArray<OhifDisplaySet> => {
        if (!instances || instances.length === 0) return []
        const first = instances[0] as WsiInstance
        const seriesUID = String(first.SeriesInstanceUID ?? '')
        // One imageId per pyramid level (each level is a multi-frame instance).
        const imageIds = instances
          .map((inst) => (inst as WsiInstance).imageId)
          .filter((id): id is string => typeof id === 'string')
        const description = String(
          first.SeriesDescription ?? 'Whole-slide image',
        )
        const displaySet: OhifDisplaySet = {
          // Deterministic so repeated derivation reuses one display set rather
          // than registering duplicates; suffixed to stay distinct from any
          // other handler that keys a display set off the same series.
          displaySetInstanceUID: `${seriesUID}-niivue-wsi`,
          SOPClassHandlerId: NIIVUE_SOP_CLASS_HANDLER_ID,
          Modality: 'SM',
          SeriesInstanceUID: seriesUID,
          StudyInstanceUID: String(first.StudyInstanceUID ?? ''),
          SeriesDescription: description,
          SeriesNumber: first.SeriesNumber,
          SOPClassUID: first.SOPClassUID,
          numImageFrames: 0,
          numInstances: instances.length,
          instances,
          imageIds,
          label: description,
        }
        return [displaySet]
      },
    },
  ]
}

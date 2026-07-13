import type { OhifDisplaySet, OhifSopClassHandlerEntry } from './ohif-types'

export const NIIVUE_SOP_CLASS_HANDLER_NAME = 'niivue-sop-class-handler'

// Phase-1 stub. NIfTI/volume-URL display sets are created by the data source, not by
// SOP-class routing, so this claims no SOP classes yet (empty list = nothing routed
// through it). Phase 2 (DICOM) will list the SOP Class UIDs NiiVue should render and
// implement getDisplaySetsFromSeries to build a NiiVue-renderable display set from a
// DICOM series' instances. Kept registered so the wiring is in place.
export function getNiivueSopClassHandlerModule(): OhifSopClassHandlerEntry[] {
  return [
    {
      name: NIIVUE_SOP_CLASS_HANDLER_NAME,
      // Phase 2: e.g. Enhanced MR/CT, Secondary Capture, or NIfTI-derived classes.
      sopClassUids: [],
      getDisplaySetsFromSeries: (): ReadonlyArray<OhifDisplaySet> => [],
    },
  ]
}

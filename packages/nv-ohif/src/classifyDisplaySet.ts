import { retrieveInstanceUrlFromImageId } from './dicomWadoRs'
import { displaySetToNiivue } from './displaySetToNiivue'
import type { OhifDisplaySet } from './ohif-types'

// How NiivueViewport should load a given display set. The viewport is a router:
//   - 'nifti'        a NIfTI/volume URL  -> nv.loadVolumes([{ url }])           (Phase 1)
//   - 'dicom-volume' a volumetric DICOM series (CT/MR/...) -> dcm2niix -> NIfTI (Phase 2)
//   - 'wsi'          whole-slide / large tiled 2D (SM) -> NVSlide              (Phase 2b)
//   - 'unsupported'  nothing we can render yet
export type NiivueLoadKind = 'nifti' | 'dicom-volume' | 'wsi' | 'unsupported'

// DICOM whole-slide microscopy and other large tiled 2D modalities go to NVSlide,
// not dcm2niix (dcm2niix is for cross-sectional volumes).
const WSI_MODALITIES = new Set(['SM'])

// Derived and non-image objects (segmentations, RT structures/plans/records,
// reports, presentation states, key-object selections, registrations, documents,
// fiducials, waveforms, audio) that dcm2niix cannot turn into a useful volume.
// RTDOSE is a dose grid, so it stays on the dcm2niix path (owner Q8).
const DERIVED_MODALITIES = new Set([
  'SEG',
  'RTSTRUCT',
  'RTPLAN',
  'RTRECORD',
  'PLAN',
  'SR',
  'PR',
  'KO',
  'REG',
  'DOC',
  'FID',
  'ECG',
  'HD',
  'AU',
])

function hasWadoInstances(ds: OhifDisplaySet): boolean {
  const instances = ds.instances
  if (!instances || instances.length === 0) return false
  return instances.some((inst) => {
    const id = inst.imageId
    return typeof id === 'string' && retrieveInstanceUrlFromImageId(id) !== null
  })
}

/**
 * Decide which NiiVue load path a display set takes. Pure; drives the viewport's
 * branching and is unit-tested against representative display-set shapes.
 */
export function classifyDisplaySet(ds: OhifDisplaySet): NiivueLoadKind {
  // A direct NIfTI/volume URL is the cheapest, most direct path.
  if (displaySetToNiivue(ds) !== null) return 'nifti'

  const modality = typeof ds.Modality === 'string' ? ds.Modality : undefined
  if (modality && DERIVED_MODALITIES.has(modality)) return 'unsupported'
  if (modality && WSI_MODALITIES.has(modality) && hasWadoInstances(ds)) {
    return 'wsi'
  }

  // Any other DICOMweb series we can pull P10 bytes for -> dcm2niix.
  if (hasWadoInstances(ds)) return 'dicom-volume'

  return 'unsupported'
}

/** The viewport shows displaySets[0] only (owner Q7); name the rest. */
export function extraDisplaySetsNote(
  displaySets: ReadonlyArray<OhifDisplaySet>,
): string | undefined {
  const names = displaySets
    .slice(1)
    .map(
      (ds) =>
        ds.SeriesDescription ||
        ds.Modality ||
        ds.displaySetInstanceUID ||
        'unnamed series',
    )
  return names.length > 0
    ? `Not shown (one series per viewport): ${names.join(', ')}.`
    : undefined
}

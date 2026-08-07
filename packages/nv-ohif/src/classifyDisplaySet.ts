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
  if (modality && WSI_MODALITIES.has(modality) && hasWadoInstances(ds)) {
    return 'wsi'
  }

  // Any other DICOMweb series we can pull P10 bytes for -> dcm2niix.
  if (hasWadoInstances(ds)) return 'dicom-volume'

  return 'unsupported'
}

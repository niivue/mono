import type { ImageFromUrlOptions } from '@niivue/niivue'
import type { OhifDisplaySet } from './ohif-types'

// Phase 1 (NIfTI) data bridge: turn an OHIF display set into the NiiVue volume load
// spec, or null when it is not something we can load yet (e.g. a DICOM series — that
// is Phase 2, building an NVImage from cornerstone's in-memory volume).
//
// A NIfTI/volume display set is data-source dependent, so we probe a few shapes:
//   1. a direct `url` on the display set,
//   2. a `url` on the first instance,
// accepting only URLs NiiVue can load by extension (NIfTI + the other volume formats
// NiiVue reads). DICOM (`.dcm`, DICOMweb `wado`/`dicomweb` refs, no extension) is
// deliberately rejected here and handled in Phase 2.

const NIIVUE_URL_EXTS = [
  '.nii',
  '.nii.gz',
  '.nrrd',
  '.nhdr',
  '.mgh',
  '.mgz',
  '.mha',
  '.mhd',
  '.mif',
  '.npy',
  '.head',
  '.brik',
]

function looksLikeNiivueVolumeUrl(url: string): boolean {
  const path = url.split(/[?#]/)[0]?.toLowerCase() ?? ''
  return NIIVUE_URL_EXTS.some((ext) => path.endsWith(ext))
}

function firstString(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined
}

/**
 * Extract a NiiVue load spec from an OHIF display set, or null if this display set is
 * not a Phase-1 (NIfTI/volume-URL) case.
 */
export function displaySetToNiivue(
  displaySet: OhifDisplaySet,
): ImageFromUrlOptions | null {
  const name =
    firstString(displaySet.SeriesDescription) ??
    firstString(displaySet.SeriesInstanceUID) ??
    'series'

  const direct = firstString(displaySet.url)
  if (direct && looksLikeNiivueVolumeUrl(direct)) {
    return { url: direct, name }
  }

  const firstInstance = displaySet.instances?.[0]
  const instanceUrl = firstInstance ? firstString(firstInstance.url) : undefined
  if (instanceUrl && looksLikeNiivueVolumeUrl(instanceUrl)) {
    return { url: instanceUrl, name }
  }

  return null
}

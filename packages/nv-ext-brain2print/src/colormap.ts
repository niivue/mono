/**
 * Label colormap for the `subcortical` and `tissue_fast` models.
 *
 * Inlined from the legacy `colormap_tissue_subcortical.json` so the lib has
 * no JSON-fetch step. Index 0 is "Unknown" (transparent background).
 */

import type { ColorMap } from '@niivue/niivue'

export const COLORMAP_TISSUE_SUBCORTICAL: ColorMap = {
  R: [
    0, 245, 205, 120, 196, 220, 230, 0, 122, 236, 12, 204, 42, 119, 220, 103,
    255, 165,
  ],
  G: [
    0, 245, 62, 18, 58, 248, 148, 118, 186, 13, 48, 182, 204, 159, 216, 255,
    165, 42,
  ],
  B: [
    0, 245, 78, 134, 250, 164, 34, 14, 220, 176, 255, 142, 164, 176, 20, 255, 0,
    42,
  ],
  // Index 0 ("Unknown") is transparent so the background brain shows through;
  // remaining labels are fully opaque. (Mirrors makeLabelLut's default.)
  A: [
    0, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255,
    255, 255, 255,
  ],
  I: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17],
  labels: [
    'Unknown',
    'Cerebral-White-Matter',
    'Cerebral-Cortex',
    'Lateral-Ventricle',
    'Inferior-Lateral-Ventricle',
    'Cerebellum-White-Matter',
    'Cerebellum-Cortex',
    'Thalamus',
    'Caudate',
    'Putamen',
    'Pallidum',
    '3rd-Ventricle',
    '4th-Ventricle',
    'Brain-Stem',
    'Hippocampus',
    'Amygdala',
    'Accumbens-area',
    'VentralDC',
  ],
}

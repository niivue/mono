// Cornerstone volume-rendering presets (VIEWPORT_PRESETS, as named by OHIF
// hanging protocols' `displayPreset`) mapped to NiiVue's CT colormaps, which
// carry their own Hounsfield window. Presets without an analogue (MIP, MR,
// DTI) keep the default colormap and window.
const NIIVUE_VR_PRESETS: Record<string, string> = {
  'CT-AAA': 'ct_artery',
  'CT-Air': 'ct_airways',
  'CT-Bone': 'ct_bones',
  'CT-Bones': 'ct_bones',
  'CT-Cardiac': 'ct_cardiac',
  'CT-Chest-Contrast-Enhanced': 'ct_w_contrast',
  'CT-Chest-Vessels': 'ct_vessels',
  'CT-Coronary-Arteries': 'ct_cardiac',
  'CT-Cropped-Volume-Bone': 'ct_bones',
  'CT-Fat': 'ct_soft_tissue',
  'CT-Liver-Vasculature': 'ct_vessels',
  'CT-Lung': 'ct_airways',
  'CT-Muscle': 'ct_muscles',
  'CT-Pulmonary-Arteries': 'ct_vessels',
  'CT-Soft-Tissue': 'ct_soft_tissue',
}

/**
 * The NiiVue colormap for a hanging protocol's `displayPreset`, which is a
 * preset name or a per-modality map (`{ CT: 'CT-Bone', default: ... }`).
 */
export function displayPresetColormap(
  displaySetOptions: ReadonlyArray<Record<string, unknown>> | undefined,
  modality: unknown,
): string | undefined {
  const d = displaySetOptions?.[0]
  const preset = ((d?.options ?? d) as { displayPreset?: unknown } | undefined)
    ?.displayPreset
  const byModality = preset as Record<string, unknown> | undefined
  const name =
    typeof preset === 'string'
      ? preset
      : (byModality?.[String(modality)] ?? byModality?.default)
  return typeof name === 'string' ? NIIVUE_VR_PRESETS[name] : undefined
}

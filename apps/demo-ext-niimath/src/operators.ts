/**
 * Curated set of niimath operators exposed in the demo's "Add Operation"
 * picker. Mirrors the list from the source fullstack-niivue-demo
 * (frontend/src/components/niimath-config.tsx).
 */
export interface NiimathOperator {
  name: string
  description: string
  args: { name: string; description: string; default?: string }[]
}

export const NIIMATH_OPERATORS: NiimathOperator[] = [
  { name: '-ceil', description: 'Round up to nearest integer', args: [] },
  { name: '-floor', description: 'Round down to nearest integer', args: [] },
  { name: '-round', description: 'Round to nearest integer', args: [] },
  { name: '-abs', description: 'Absolute value', args: [] },
  {
    name: '-bandpass',
    description: 'Temporal bandpass filter',
    args: [
      { name: 'hp', description: 'High-pass cutoff (Hz)', default: '0.01' },
      { name: 'lp', description: 'Low-pass cutoff (Hz)', default: '0.1' },
      { name: 'tr', description: 'TR (seconds)', default: '2.0' },
    ],
  },
  {
    name: '-s',
    description: 'Gaussian smoothing (sigma mm)',
    args: [{ name: 'sigma', description: 'Sigma in mm', default: '3.0' }],
  },
  {
    name: '-add',
    description: 'Add constant value',
    args: [{ name: 'value', description: 'Value to add', default: '100' }],
  },
  {
    name: '-sub',
    description: 'Subtract constant value',
    args: [{ name: 'value', description: 'Value to subtract', default: '50' }],
  },
  {
    name: '-mul',
    description: 'Multiply by constant value',
    args: [{ name: 'value', description: 'Multiplier', default: '2.0' }],
  },
  {
    name: '-div',
    description: 'Divide by constant value',
    args: [{ name: 'value', description: 'Divisor', default: '1000' }],
  },
  {
    name: '-thr',
    description: 'Threshold (zero values below)',
    args: [{ name: 'threshold', description: 'Threshold', default: '0.5' }],
  },
  {
    name: '-uthr',
    description: 'Upper threshold (zero values above)',
    args: [
      { name: 'threshold', description: 'Upper threshold', default: '1000' },
    ],
  },
  {
    name: '-bin',
    description: 'Binarize (set non-zero values to 1)',
    args: [],
  },
]

/**
 * Append `_processed` before the NIfTI extension. Mirrors the server logic so
 * the displayed command matches what actually runs.
 *
 * niimath / fslmaths default to writing `.nii.gz` regardless of the requested
 * extension unless `FSLOUTPUTTYPE` is set. The server pins
 * `FSLOUTPUTTYPE=NIFTI_GZ` and asks for a `.nii.gz` output explicitly.
 */
export function inferOutputName(inputName: string): string {
  const lower = inputName.toLowerCase()
  let stem = inputName
  if (lower.endsWith('.nii.gz')) stem = inputName.slice(0, -7)
  else if (lower.endsWith('.nii')) stem = inputName.slice(0, -4)
  // Idempotent: chained runs against an already-processed name don't keep
  // appending `_processed`.
  const suffix = stem.endsWith('_processed') ? '' : '_processed'
  return `${stem}${suffix}.nii.gz`
}

/** Sample volumes shipped via @niivue/dev-images. Served at /volumes/<name>.nii.gz. */
export const SAMPLE_VOLUMES = [
  { name: 'mni152.nii.gz', label: 'MNI152 (T1 brain)' },
  { name: 'FA.nii.gz', label: 'FA (fractional anisotropy)' },
  { name: 'spmMotor.nii.gz', label: 'spmMotor (statistical map)' },
  { name: 'visiblehuman.nii.gz', label: 'Visible Human (CT)' },
  { name: 'torso.nii.gz', label: 'Torso (CT)' },
] as const

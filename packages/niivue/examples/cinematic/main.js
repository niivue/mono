import NiiVue, { SLICE_TYPE, VOLUME_RENDER_MODE } from '../../src/index.ts'
import angio from './cr_angio.json'
import angio1d from './cr_angio_1d.json'
import bone from './cr_bone.json'
import ctMod from './cr_ct_mod.json'
import skinBone from './cr_skin_bone.json'
import t1 from './cr_t1.json'
import t1Mod from './cr_t1_mod.json'
import siamT1 from './siam_t1.json'
import tsAbdoPelvis from './ts_abdopelvis.json'
import tsWholeBody from './ts_wholebody.json'

// Transfer functions: NiiVue colormaps with the optional cinematic keys
// (E, S, gradient, gMax, shininess, labelBlend; see ColorMap).
const PRESETS = {
  cr_skin_bone: skinBone,
  cr_bone: bone,
  cr_angio: angio,
  cr_angio_1d: angio1d,
  cr_ct_mod: ctMod,
  cr_t1: t1,
  cr_t1_mod: t1Mod,
}

// ?sample=<id> picks a sample; ?url=... adds a volume; ?tf=... picks a preset;
// ?mode=classic|cinematic; ?clip=0..6 picks a clip preset, ?cutaway=1;
// ?backend=webgl2|webgpu; ?azimuth=, ?elevation=; ?<setting>= sets a slider.
const params = new URLSearchParams(location.search)
// Calibrated (int16 Hounsfield) CT samples, each with a suggested preset.
// CT_AVM and CT_pitch in the same repository are uint8, so HU presets do not apply.
const DEMO_BASE =
  'https://raw.githubusercontent.com/niivue/niivue-demo-images-lfs/main/'
// Larger scans are Git LFS objects: raw URLs return pointers, so use the media endpoint.
const LFS_BASE =
  'https://media.githubusercontent.com/media/niivue/niivue-demo-images-lfs/main/'
// labels: a label image on the same grid, with a material table (label
// colormap plus per-label S, lo/hi intensity ramp, surface, normalize).
const SAMPLES = [
  {
    id: 'ct-abdo',
    name: 'CT_Abdo (cardiac CTA)',
    url: `${DEMO_BASE}CT_Abdo.nii.gz`,
    tf: 'cr_angio',
  },
  {
    id: 'ct-philips',
    name: 'CT_Philips (head)',
    url: `${DEMO_BASE}CT_Philips.nii.gz`,
    tf: 'cr_bone',
  },
  {
    id: 'ct-electrodes',
    name: 'CT_Electrodes (head)',
    url: `${DEMO_BASE}CT_Electrodes.nii.gz`,
    tf: 'cr_skin_bone',
  },
  {
    id: 'ct-wholebody',
    name: 'CT_WholeBody (1.5 mm, 59 MB)',
    url: `${LFS_BASE}CT_WholeBody.nii.gz`,
    tf: 'cr_skin_bone',
  },
  {
    id: 'ct-wholebody-labels',
    name: 'CT_WholeBody + TotalSegmentator labels',
    url: `${LFS_BASE}CT_WholeBody.nii.gz`,
    tf: 'cr_ct_mod',
    labels: {
      // ?v= versions the URL: bump it when the file changes (GitHub's CDN
      // caches a 404 from before a file existed).
      url: `${LFS_BASE}CT_WholeBody_labels.nii.gz?v=1`,
      colormap: 'ts_wholebody',
      table: tsWholeBody,
    },
  },
  {
    id: 'ct-abdopelvis-labels',
    name: 'CT_AbdoPelvis + labels (smaller, 20 MB)',
    url: `${LFS_BASE}CT_AbdoPelvis.nii.gz?v=2`,
    tf: 'cr_ct_mod',
    labels: {
      url: `${LFS_BASE}CT_AbdoPelvis_labels.nii.gz?v=2`,
      colormap: 'ts_abdopelvis',
      table: tsAbdoPelvis,
    },
  },
  {
    // Bundled with the dev images; the greyscale default suits non-CT scans.
    id: 'mr-mni152',
    name: 'MNI152 T1 brain (default preset)',
    url: '/volumes/mni152.nii.gz',
    tf: 'cr_default',
  },
  {
    id: 'mr-siam',
    name: 'MR T1 brain + SIAM labels',
    url: `${LFS_BASE}MR_T1_brain.nii.gz?v=1`,
    tf: 'cr_t1_mod',
    labels: {
      url: `${LFS_BASE}MR_T1_brain_siam.nii.gz?v=1`,
      colormap: 'siam_t1',
      table: siamT1,
    },
  },
]
for (const url of params.getAll('url')) {
  SAMPLES.unshift({ name: url.split('/').pop(), url, tf: 'cr_skin_bone' })
}
for (const [i, sample] of SAMPLES.entries()) {
  volumeSelect.add(new Option(sample.name, String(i)))
}
const selectedSample = () => SAMPLES[Number(volumeSelect.value)]
// ?sample= takes a sample id (e.g. mr-siam); ids survive reordering and ?url=.
const sampleIndex = SAMPLES.findIndex(
  (sample) => sample.id === params.get('sample'),
)
if (sampleIndex >= 0) volumeSelect.value = String(sampleIndex)
// An unknown ?tf= falls back to the sample's preset rather than an empty selection.
const tfParam = params.get('tf')
tfSelect.value = tfParam in PRESETS ? tfParam : selectedSample().tf
if (params.get('mode')) modeSelect.value = params.get('mode')

const SLIDERS = [
  ['lightElevation', -90, 90, 1],
  ['lightAzimuth', -90, 90, 1],
  ['lightConeDeg', 1, 20, 0.5],
  ['lightIntensity', 0, 5, 0.1],
  ['ambient', 0, 1, 0.01],
  ['shadow', 0, 1, 0.01],
  ['ao', 0, 1, 0.01],
  ['aoRadiusMM', 1, 40, 1],
  ['aoConeDeg', 5, 60, 1],
  ['volumetricDiffuse', 0, 1, 0.01],
  ['exposure', 0.2, 4, 0.05],
  ['stepVoxels', 0.25, 2, 0.05],
  ['maxFrames', 1, 1024, 1],
  ['specular', 0, 3, 0.05],
]

let background = [0, 0, 0, 1]
const nv1 = new NiiVue({
  backend: params.get('backend') === 'webgl2' ? 'webgl2' : 'webgpu',
  backgroundColor: background,
  // Occluded crosshair arms show faintly, as in vox.clip.html with XRay on.
  meshXRay: 0.1,
  sliceType: SLICE_TYPE.RENDER,
  isAntiAlias: true,
  // Click a legend colour box to hide/show that region; the name moves the crosshair.
  isLegendToggleEnabled: true,
  isOrientCubeVisible: true,
})
await nv1.attachToCanvas(gl1)
// For scripted checks (e.g. headless screenshots).
window.nv1 = nv1
for (const [name, cmap] of Object.entries(PRESETS)) nv1.addColormap(name, cmap)

const sliders = {}
for (const [key, min, max, step] of SLIDERS) {
  const label = document.createElement('label')
  const input = Object.assign(document.createElement('input'), {
    type: 'range',
    min,
    max,
    step,
    value: params.get(key) ?? nv1.volumeCinematic[key],
  })
  const out = document.createElement('output')
  out.textContent = input.value
  input.oninput = () => {
    out.textContent = input.value
    nv1.volumeCinematic = { [key]: Number(input.value) }
  }
  label.append(key, input, out)
  controls.append(label)
  sliders[key] = input
  if (params.has(key)) input.oninput()
}

// Render settings a material table suggests (e.g. stronger AO), shown on the
// sliders. The table's `settings` key is demo-only.
function applySuggestedSettings(settings = {}) {
  for (const [key, value] of Object.entries(settings)) {
    if (!sliders[key]) continue
    sliders[key].value = value
    sliders[key].oninput()
  }
}

// Scans with no negative voxels cannot be CT (air is -1000 HU): magnitude MR
// and the like get a greyscale preset fitted to their own robust range, built
// per volume because their intensity scale is arbitrary.
const isNotCT = (vol) => vol.globalMin >= 0
function defaultPreset(vol) {
  const lo = vol.robustMin
  const hi = Math.max(vol.robustMax, lo + 1e-6)
  const range = hi - lo
  // Window fractions: background and noise (< 10%) stay clear, then tissue
  // ramps to near-white and fairly opaque, edges more so than interiors.
  const stops = [
    [0, 0, 0, 0, 0],
    [0.1, 90, 0, 0, 0],
    [0.3, 150, 25, 140, 40],
    [0.65, 205, 70, 210, 80],
    [1, 245, 150, 255, 100],
  ]
  return {
    min: lo,
    max: hi,
    I: stops.map(([f]) => Math.round(f * 255)),
    R: stops.map((s) => s[1]),
    G: stops.map((s) => s[1]),
    B: stops.map((s) => s[1]),
    A: stops.map((s) => s[2]),
    E: stops.map((s) => s[3]),
    S: stops.map((s) => s[4]),
    // Gradients are in intensity/mm, so scale the ramp with the window.
    gradient: { lo: 0.05 * range, hi: 0.3 * range },
    gMax: range,
    shininess: 30,
  }
}
function registerDefaultPreset(vol) {
  PRESETS.cr_default = defaultPreset(vol)
  nv1.addColormap('cr_default', PRESETS.cr_default)
}

// Cinematic mode bakes volume 0's colormap across its calMin..calMax. A
// label-calibrated sample (MRI) is calibrated to the table's units, where the
// preset's own window applies; its classic view keeps NiiVue's grey window.
function applyColormap() {
  const vol = nv1.volumes[0]
  if (!vol) return
  const isCalibrated = !!selectedSample().labels?.table.normalize
  const isCinematic = modeSelect.value === 'cinematic'
  if (!isCalibrated) {
    if (tfSelect.value === 'cr_default') registerDefaultPreset(vol)
    const cmap = PRESETS[tfSelect.value]
    nv1.setVolume(0, {
      colormap: tfSelect.value,
      calMin: cmap.min,
      calMax: cmap.max,
    })
    return
  }
  // Passing the current window keeps it (a preset's own window would replace it).
  nv1.setVolume(0, {
    colormap: isCinematic ? tfSelect.value : 'gray',
    calMin: vol.calMin,
    calMax: vol.calMax,
  })
}

let isOwnLoad = false
async function loadVolume() {
  const sample = selectedSample()
  const labels = sample.labels
  if (labels) nv1.addColormap(labels.colormap, labels.table)
  isOwnLoad = true
  try {
    await nv1.loadVolumes([
      { url: sample.url },
      ...(labels ? [{ url: labels.url, colormap: labels.colormap }] : []),
    ])
  } finally {
    isOwnLoad = false
  }
  labelSelect.hidden = !labels
  if (labels) applySuggestedSettings(labels.table.settings)
  // A scan that is clearly not CT gets the greyscale default unless ?tf= chose.
  if (!labels && isNotCT(nv1.volumes[0]) && !params.has('tf'))
    tfSelect.value = 'cr_default'
  applyColormap()
}

// The menu's first entry ("labels only") is the demo's default.
labelSelect.onchange = () => {
  nv1.volumeCinematic = { labelMode: labelSelect.value }
}
labelSelect.onchange()

// Clip presets from vox.clip.html: [depth, azimuth, elevation] per plane.
// Depth > 1 disables a plane. Right-drag on the render also moves plane 0.
const CLIP_PRESETS = [
  [[2, 180, 20]],
  [[0.1, 180, 20]],
  [
    [0.1, 180, 20],
    [0.1, 0, -20],
  ],
  [
    [0, 90, 0],
    [0, 0, -20],
    [0.1, 0, -90],
  ],
  [
    [0.3, 270, 0],
    [0.3, 90, 0],
    [0, 180, 0],
    [0.1, 0, 0],
  ],
  [
    [0.4, 270, 0],
    [0.4, 90, 0],
    [0.4, 180, 0],
    [0.2, 0, 0],
    [0.1, 0, -90],
  ],
  [
    [0.4, 270, 0],
    [-0.1, 90, 0],
    [0.4, 180, 0],
    [0.2, 0, 0],
    [0.1, 0, -90],
    [0.3, 0, 90],
  ],
]
clipSelect.onchange = () => {
  nv1.setClipPlanes(CLIP_PRESETS[clipSelect.selectedIndex])
}
cutawayCheck.onchange = () => {
  nv1.isClipPlaneCutaway = cutawayCheck.checked
}

let loadError = ''
function applyMode() {
  const isCinematic = modeSelect.value === 'cinematic'
  nv1.volumeRenderMode = isCinematic
    ? VOLUME_RENDER_MODE.CINEMATIC
    : VOLUME_RENDER_MODE.COMPOSITE
  applyColormap()
  const backend = nv1.opts.backend === 'webgpu' ? 'WebGPU' : 'WebGL2'
  modeText.textContent = `${isCinematic ? 'Cinematic' : 'Classic'} (${backend})`
  controls.hidden = !isCinematic
  timeText.textContent = loadError
}
modeSelect.onchange = applyMode

colorBtn.oninput = () => {
  const hex = colorBtn.value
  background = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
  background.push(1)
  nv1.backgroundColor = background
}
aaCheck.onchange = async () => {
  await nv1.reinitializeView({ isAntiAlias: aaCheck.checked })
}
webgpuCheck.checked = nv1.opts.backend === 'webgpu'
webgpuCheck.onchange = async () => {
  await nv1.reinitializeView({
    backend: webgpuCheck.checked ? 'webgpu' : 'webgl2',
  })
  applyMode()
}
// One load at a time: loadVolumes commits whichever fetch finishes last, so an
// overlapping selection could show a different scan than the one selected.
async function loadSelectedVolume() {
  volumeSelect.disabled = true
  try {
    loadError = ''
    await loadVolume()
  } catch (err) {
    // e.g. a sample not yet on the demo-images main branch (404)
    loadError = `Load failed: ${err.message}`
    console.error(err)
  } finally {
    volumeSelect.disabled = false
    timeText.textContent = loadError
  }
}
// A volume dropped on the canvas replaces NiiVue's; show it with the current
// preset as an unlabelled "(dropped)" sample.
nv1.addEventListener('volumeLoaded', () => {
  const vol = nv1.volumes[0]
  if (isOwnLoad || !vol) return
  // Label-calibrated or label-modulated presets need labels a drop lacks;
  // a scan that is clearly not CT gets the greyscale default.
  if (isNotCT(vol)) tfSelect.value = 'cr_default'
  else if (PRESETS[tfSelect.value].labelBlend || tfSelect.value === 'cr_t1')
    tfSelect.value = 'cr_skin_bone'
  SAMPLES.push({
    id: 'dropped',
    name: `${vol.name} (dropped)`,
    url: '',
    tf: tfSelect.value,
  })
  volumeSelect.add(new Option(SAMPLES.at(-1).name, String(SAMPLES.length - 1)))
  volumeSelect.value = String(SAMPLES.length - 1)
  labelSelect.hidden = true
  applyColormap()
})
volumeSelect.onchange = () => {
  // A dropped volume is gone once replaced, so its entry cannot be reloaded.
  for (const option of [...volumeSelect.options]) {
    if (!option.selected && SAMPLES[Number(option.value)].id === 'dropped') {
      option.remove()
    }
  }
  tfSelect.value = selectedSample().tf
  loadSelectedVolume()
}
tfSelect.onchange = applyColormap
saveBtn.onclick = () => nv1.saveBitmap('cinematic.png')

await loadSelectedVolume()
if (params.has('azimuth')) nv1.azimuth = Number(params.get('azimuth'))
if (params.has('elevation')) nv1.elevation = Number(params.get('elevation'))
if (params.has('clip')) clipSelect.selectedIndex = Number(params.get('clip'))
cutawayCheck.checked = params.get('cutaway') === '1'
clipSelect.onchange()
cutawayCheck.onchange()
applyMode()

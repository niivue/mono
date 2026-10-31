import NiiVue, { getImageDataRAS, SLICE_TYPE } from '../../src/index.ts'
// Internal: the cinematic overlay must use exactly NiiVue's render camera.
import { calculateMvpMatrix } from '../../src/math/NVTransforms.ts'
import angio from './cr_angio.json'
import angio1d from './cr_angio_1d.json'
import bone from './cr_bone.json'
import skinBone from './cr_skin_bone.json'
import t1 from './cr_t1.json'
import t1Mod from './cr_t1_mod.json'
import { CinematicRenderer, DEFAULT_SETTINGS } from './renderer.js'
import siamT1 from './siam_t1.json'
import { bakeTransferFunction } from './tf.js'
import tsAbdoPelvis from './ts_abdopelvis.json'
import tsWholeBody from './ts_wholebody.json'

const PRESETS = {
  cr_skin_bone: skinBone,
  cr_bone: bone,
  cr_angio: angio,
  cr_angio_1d: angio1d,
  cr_t1: t1,
  cr_t1_mod: t1Mod,
}

// ?url=... adds a volume; ?tf=... picks a preset; ?mode=classic|cinematic;
// ?clip=0..6 picks a clip preset, ?cutaway=1.
const params = new URLSearchParams(location.search)
// Calibrated (int16 Hounsfield) CT samples, each with a suggested preset.
// CT_AVM and CT_pitch in the same repository are uint8, so HU presets do not apply.
const DEMO_BASE =
  'https://raw.githubusercontent.com/niivue/niivue-demo-images-lfs/main/'
// Larger scans are Git LFS objects: raw URLs return pointers, so use the media endpoint.
const LFS_BASE =
  'https://media.githubusercontent.com/media/niivue/niivue-demo-images-lfs/main/'
// labels: a label image on the same grid, with a material table (label
// colormap plus per-label S and lo/hi HU ramp) registered as a colormap.
const SAMPLES = [
  {
    name: 'CT_Abdo (cardiac CTA)',
    url: `${DEMO_BASE}CT_Abdo.nii.gz`,
    tf: 'cr_angio',
  },
  {
    name: 'CT_Philips (head)',
    url: `${DEMO_BASE}CT_Philips.nii.gz`,
    tf: 'cr_bone',
  },
  {
    name: 'CT_Electrodes (head)',
    url: `${DEMO_BASE}CT_Electrodes.nii.gz`,
    tf: 'cr_skin_bone',
  },
  {
    name: 'CT_WholeBody (1.5 mm, 59 MB)',
    url: `${LFS_BASE}CT_WholeBody.nii.gz`,
    tf: 'cr_skin_bone',
  },
  {
    name: 'CT_WholeBody + TotalSegmentator labels',
    url: `${LFS_BASE}CT_WholeBody.nii.gz`,
    tf: 'cr_skin_bone',
    labels: {
      // ?v= versions the URL: bump it when the file changes (GitHub's CDN
      // caches a 404 from before a file existed).
      url: `${LFS_BASE}CT_WholeBody_labels.nii.gz?v=1`,
      colormap: 'ts_wholebody',
      table: tsWholeBody,
    },
  },
  {
    name: 'CT_AbdoPelvis + labels (smaller, 20 MB)',
    url: `${LFS_BASE}CT_AbdoPelvis.nii.gz?v=1`,
    tf: 'cr_skin_bone',
    labels: {
      url: `${LFS_BASE}CT_AbdoPelvis_labels.nii.gz?v=1`,
      colormap: 'ts_abdopelvis',
      table: tsAbdoPelvis,
    },
  },
  {
    name: 'CT_Pancreas (contrast, 66 MB)',
    url: `${LFS_BASE}CT_Pancreas.nii.gz`,
    tf: 'cr_angio',
  },
  {
    name: 'MR T1 brain + SIAM labels',
    url: `${LFS_BASE}MR_T1_brain.nii.gz?v=1`,
    tf: 'cr_t1',
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
if (params.has('sample')) volumeSelect.value = params.get('sample')
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
  ['scale', 0.25, 1, 0.05],
  ['specular', 0, 3, 0.05],
]

let background = [0, 0, 0, 1]
const nv1 = new NiiVue({
  backgroundColor: background,
  // Occluded crosshair arms show faintly, as in vox.clip.html with XRay on.
  meshXRay: 0.1,
  sliceType: SLICE_TYPE.RENDER,
  isAntiAlias: true,
  isOrientCubeVisible: true,
})
await nv1.attachToCanvas(gl1)
const cr = await CinematicRenderer.create(cine)

const sliders = {}
for (const [key, min, max, step] of SLIDERS) {
  const label = document.createElement('label')
  const input = Object.assign(document.createElement('input'), {
    type: 'range',
    min,
    max,
    step,
    value: params.get(key) ?? DEFAULT_SETTINGS[key],
  })
  const out = document.createElement('output')
  out.textContent = input.value
  input.oninput = () => {
    out.textContent = input.value
    cr.setSettings({ [key]: Number(input.value) })
  }
  label.append(key, input, out)
  controls.append(label)
  cr.settings[key] = Number(input.value)
  sliders[key] = input
}

// Render settings a material table suggests (e.g. stronger AO), shown on the sliders.
function applySuggestedSettings(settings = {}) {
  for (const [key, value] of Object.entries(settings)) {
    if (!sliders[key]) continue
    sliders[key].value = value
    sliders[key].oninput()
  }
}

function applyTransferFunction() {
  const cmap = PRESETS[tfSelect.value]
  cr.setTransferFunction(bakeTransferFunction(cmap))
  // The extended table is still a plain NiiVue colormap: E/S/gradient are ignored there.
  nv1.addColormap(tfSelect.value, cmap)
  // A calibrated (MRI) preset is in label-median units, not the file's: the
  // classic view keeps its own grey window.
  if (selectedSample().labels?.table.normalize) return
  if (nv1.volumes.length)
    nv1.setVolume(0, {
      colormap: tfSelect.value,
      calMin: cmap.min,
      calMax: cmap.max,
    })
}

async function loadVolume() {
  const sample = selectedSample()
  const labels = sample.labels
  if (labels) nv1.addColormap(labels.colormap, labels.table)
  await nv1.loadVolumes([
    { url: sample.url },
    ...(labels ? [{ url: labels.url, colormap: labels.colormap }] : []),
  ])
  const vol = nv1.volumes[0]
  const raw = getImageDataRAS(vol)
  if (!raw) throw new Error(`${vol.name}: no voxel data`)
  const slope =
    Number.isFinite(vol.hdr.scl_slope) && vol.hdr.scl_slope !== 0
      ? vol.hdr.scl_slope
      : 1
  const inter = Number.isFinite(vol.hdr.scl_inter) ? vol.hdr.scl_inter : 0
  const hu = new Float32Array(raw.length)
  for (let i = 0; i < raw.length; i++) hu[i] = raw[i] * slope + inter
  let labelIds = null
  if (labels) {
    const lab = nv1.volumes[1]
    const same = lab.dimsRAS.every((d, i) => d === vol.dimsRAS[i])
    if (!same)
      throw new Error(`${lab.name}: labels must share the image's grid`)
    labelIds = Uint8Array.from(getImageDataRAS(lab) ?? [])
    if (labels.table.normalize) calibrate(hu, labelIds, labels.table.normalize)
  }
  cr.setVolume(hu, vol.dimsRAS.slice(1, 4), vol.frac2mm)
  applyTransferFunction()
  labelSelect.hidden = !labels
  if (labels) {
    cr.setLabels(labelIds)
    applySuggestedSettings(labels.table.settings)
    applyLabelMode()
  }
}

// Uncalibrated intensities (MRI): map the median intensity inside each
// listed label set to its target, piecewise linearly, extrapolating the end
// segments. e.g. [[[CSF], 0], [[GM], 100], [[WM], 200]] makes per-label
// ramps and transfer functions portable across scanners.
function calibrate(img, labelIds, pairs) {
  const points = pairs
    .map(([ids, target]) => {
      const values = []
      // Every 7th voxel is plenty for a median.
      for (let i = 0; i < img.length; i += 7) {
        if (ids.includes(labelIds[i])) values.push(img[i])
      }
      values.sort((a, b) => a - b)
      return [values[values.length >> 1], target]
    })
    .sort((a, b) => a[0] - b[0])
  const map = (v) => {
    let k = 0
    while (k < points.length - 2 && v > points[k + 1][0]) k++
    const [[x0, y0], [x1, y1]] = [points[k], points[k + 1]]
    return y0 + ((v - x0) * (y1 - y0)) / (x1 - x0)
  }
  for (let i = 0; i < img.length; i++) img[i] = map(img[i])
}

// Unlabeled tissue (label 0) uses the base transfer function, scaled by this.
const LABEL_MODES = { only: 0, unlabeled: 1 }
function applyLabelMode() {
  const labels = selectedSample().labels
  const scale = LABEL_MODES[labelSelect.value]
  cr.setLabelMaterials(
    labels && scale !== undefined ? labels.table : null,
    scale ?? 1,
  )
}
labelSelect.onchange = applyLabelMode

// Poll NiiVue's camera each frame: rotation, zoom, pan and resize all move it.
let cameraKey = ''
function syncCamera() {
  const md = nv1.model
  const w = gl1.clientWidth
  const h = gl1.clientHeight
  const pivot = md._renderPivotMM ?? md.pivot3D
  const key = [
    md.scene.azimuth,
    md.scene.elevation,
    md.scene.scaleMultiplier,
    ...md.scene.renderPan,
    ...pivot,
    md.furthestFromPivot,
    w,
    h,
    ...md.clipPlanes,
    md.scene.isClipPlaneCutaway,
  ].join()
  if (key === cameraKey) return
  cameraKey = key
  const [mvp, model] = calculateMvpMatrix(
    [0, 0, w, h],
    md.scene.azimuth,
    md.scene.elevation,
    pivot,
    md.furthestFromPivot,
    md.scene.scaleMultiplier,
    md.volumes[0]?.obliqueRAS,
    md.scene.renderPan,
  )
  cr.background = background
  cr.setCamera(mvp, model)
  cr.setClip(md.clipPlanes, md.scene.isClipPlaneCutaway)
}

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

// Cinematic draws beneath NiiVue's canvas. NiiVue keeps the mouse, the
// orientation cube and the crosshair, over a transparent background.
// NiiVue skips its volume draw below opacity 1/255, and with it the depth
// that hides crosshair arms behind the volume. Just above that it still writes
// depth at the first hit while tinting the image by at most one 8-bit level.
const DEPTH_ONLY_OPACITY = 1.01 / 255
function applyMode() {
  const isCinematic = modeSelect.value === 'cinematic'
  cine.style.visibility = isCinematic ? 'visible' : 'hidden'
  // Premultiplied canvas: transparent must be all zero, or its colour adds on top.
  nv1.backgroundColor = isCinematic ? [0, 0, 0, 0] : background
  if (nv1.volumes.length) {
    nv1.setVolume(0, { opacity: isCinematic ? DEPTH_ONLY_OPACITY : 1 })
  }
  // The label overlay is for the classic view; cinematic draws labels itself.
  if (nv1.volumes.length > 1) nv1.setVolume(1, { opacity: isCinematic ? 0 : 1 })
  const backend = nv1.opts.backend === 'webgpu' ? 'WebGPU' : 'WebGL2'
  modeText.textContent = `${isCinematic ? 'Cinematic' : 'Classic'} (${backend})`
  for (const el of [controls, restartBtn, saveBtn]) el.hidden = !isCinematic
  timeText.textContent = loadError
  cameraKey = ''
}

modeSelect.onchange = applyMode
// NiiVue's backend (classic view, cube, mouse). The cinematic renderer is
// WebGPU-only for now; a WebGL2 port comes when it moves into src/.
colorBtn.oninput = () => {
  const hex = colorBtn.value
  background = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
  background.push(1)
  applyMode() // re-applies the per-mode background and restarts refinement
}
aaCheck.onchange = async () => {
  await nv1.reinitializeView({ isAntiAlias: aaCheck.checked })
  applyMode()
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
let loadError = ''
async function loadSelectedVolume() {
  volumeSelect.disabled = true
  try {
    loadError = ''
    await loadVolume()
    applyMode() // a new volume loads opaque
  } catch (err) {
    // e.g. a sample not yet on the demo-images main branch (404)
    loadError = `Load failed: ${err.message}`
    timeText.textContent = loadError
    console.error(err)
  } finally {
    volumeSelect.disabled = false
  }
}
volumeSelect.onchange = () => {
  tfSelect.value = selectedSample().tf
  loadSelectedVolume()
}
tfSelect.onchange = applyTransferFunction
restartBtn.onclick = () => cr.reset()
saveBtn.onclick = () => {
  cr.redisplay() // a WebGPU canvas is only readable in the task that drew it
  const a = Object.assign(document.createElement('a'), {
    href: cine.toDataURL('image/png'),
    download: 'cinematic.png',
  })
  a.click()
}

function tick() {
  if (modeSelect.value === 'cinematic' && nv1.volumes.length) {
    syncCamera()
    cr.render()
    const ms = cr.averageMs
    const text = loadError || (ms === null ? '' : `${ms.toFixed(0)} ms/frame`)
    if (timeText.textContent !== text) timeText.textContent = text
  }
  requestAnimationFrame(tick)
}

await loadSelectedVolume()
if (params.has('azimuth')) nv1.azimuth = Number(params.get('azimuth'))
if (params.has('elevation')) nv1.elevation = Number(params.get('elevation'))
if (params.has('clip')) clipSelect.selectedIndex = Number(params.get('clip'))
cutawayCheck.checked = params.get('cutaway') === '1'
clipSelect.onchange()
cutawayCheck.onchange()
applyMode()
requestAnimationFrame(tick)

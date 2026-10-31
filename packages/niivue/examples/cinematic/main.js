import NiiVue, { getImageDataRAS, SLICE_TYPE } from '../../src/index.ts'
// Internal: the cinematic overlay must use exactly NiiVue's render camera.
import { calculateMvpMatrix } from '../../src/math/NVTransforms.ts'
import angio from './cr_angio.json'
import angio1d from './cr_angio_1d.json'
import bone from './cr_bone.json'
import skinBone from './cr_skin_bone.json'
import { CinematicRenderer, DEFAULT_SETTINGS } from './renderer.js'
import { bakeTransferFunction } from './tf.js'

const PRESETS = {
  cr_skin_bone: skinBone,
  cr_bone: bone,
  cr_angio: angio,
  cr_angio_1d: angio1d,
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
const SAMPLES = [
  ['CT_Abdo (cardiac CTA)', `${DEMO_BASE}CT_Abdo.nii.gz`, 'cr_angio'],
  ['CT_Philips (head)', `${DEMO_BASE}CT_Philips.nii.gz`, 'cr_bone'],
  ['CT_Electrodes (head)', `${DEMO_BASE}CT_Electrodes.nii.gz`, 'cr_skin_bone'],
  [
    'CT_WholeBody (1.5 mm, 59 MB)',
    `${LFS_BASE}CT_WholeBody.nii.gz`,
    'cr_skin_bone',
  ],
  [
    'CT_Pancreas (contrast, 66 MB)',
    `${LFS_BASE}CT_Pancreas.nii.gz`,
    'cr_angio',
  ],
]
const suggestedTF = new Map()
for (const [name, url, tf] of SAMPLES) {
  volumeSelect.add(new Option(name, url))
  suggestedTF.set(url, tf)
}
for (const url of params.getAll('url')) {
  volumeSelect.add(new Option(url.split('/').pop(), url), 0)
}
volumeSelect.selectedIndex = 0
// An unknown ?tf= falls back to the sample's preset rather than an empty selection.
const tfParam = params.get('tf')
tfSelect.value =
  (tfParam in PRESETS ? tfParam : suggestedTF.get(volumeSelect.value)) ??
  tfSelect.value
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

const BACKGROUND = [0, 0, 0, 1]
const nv1 = new NiiVue({
  backgroundColor: BACKGROUND,
  // Occluded crosshair arms show faintly, as in vox.clip.html with XRay on.
  meshXRay: 0.1,
  sliceType: SLICE_TYPE.RENDER,
  isOrientCubeVisible: true,
})
await nv1.attachToCanvas(gl1)
const cr = await CinematicRenderer.create(cine)

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
}

function applyTransferFunction() {
  const cmap = PRESETS[tfSelect.value]
  cr.setTransferFunction(bakeTransferFunction(cmap))
  // The extended table is still a plain NiiVue colormap: E/S/gradient are ignored there.
  nv1.addColormap(tfSelect.value, cmap)
  if (nv1.volumes.length)
    nv1.setVolume(0, {
      colormap: tfSelect.value,
      calMin: cmap.min,
      calMax: cmap.max,
    })
}

async function loadVolume() {
  await nv1.loadVolumes([{ url: volumeSelect.value }])
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
  cr.setVolume(hu, vol.dimsRAS.slice(1, 4), vol.frac2mm)
  applyTransferFunction()
}

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
  cr.background = BACKGROUND
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
  nv1.backgroundColor = isCinematic
    ? [...BACKGROUND.slice(0, 3), 0]
    : BACKGROUND
  if (nv1.volumes.length) {
    nv1.setVolume(0, { opacity: isCinematic ? DEPTH_ONLY_OPACITY : 1 })
  }
  const backend = nv1.opts.backend === 'webgpu' ? 'WebGPU' : 'WebGL2'
  modeText.textContent = `${isCinematic ? 'Cinematic' : 'Classic'} (${backend})`
  for (const el of [controls, restartBtn, saveBtn]) el.hidden = !isCinematic
  timeText.textContent = ''
  cameraKey = ''
}

modeSelect.onchange = applyMode
// NiiVue's backend (classic view, cube, mouse). The cinematic renderer is
// WebGPU-only for now; a WebGL2 port comes when it moves into src/.
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
    await loadVolume()
    applyMode() // a new volume loads opaque
  } finally {
    volumeSelect.disabled = false
  }
}
volumeSelect.onchange = () => {
  tfSelect.value = suggestedTF.get(volumeSelect.value) ?? tfSelect.value
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
    const text = ms === null ? '' : `${ms.toFixed(0)} ms/frame`
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

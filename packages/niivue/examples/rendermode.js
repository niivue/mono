import { shiny } from '../src/assets/matcaps'
import NiiVue, { SHOW_RENDER, VOLUME_RENDER_MODE } from '../src/index.ts'

// The three volumeRenderMode values side by side. COMPOSITE and MAXIMUM
// ray-march; SLICES does not — it draws the three crosshair planes inside
// the 3D tile and composites their hits, so it costs at most three samples
// per ray and shows overlays exactly where the 2D tiles do.
//
// The tracts are here to show what the planes do with an embedded
// structure: a mesh is a separate draw that depth-tests against the plane
// depth, so a streamline is cut exactly where it crosses a plane rather
// than being hidden by it or floating in front of it.
//
// Volume and mesh URLs live here rather than in HTML attributes: the
// GitHub Pages build rewrites absolute /volumes/ and /meshes/ paths in
// page script only.
// Standard space, so the MNI-space meshes below land where they should.
const T1 = '/volumes/mni152.nii.gz'
const TRACTS = '/meshes/dpsv.trx'
const CEREBELLUM = '/meshes/atl-Anatom_space-MNI.mz3'
// Mesh index of the cerebellum (the tracts load first, at 0).
const CEREBELLUM_MESH = 1
// A sentinel that cannot collide with a shader name.
const HIDDEN = '\u0000hidden'

// Render-mode presets. Matcap is NOT a fourth volumeRenderMode: it is the
// composite march with the matcap lighting that the volume's gradient
// drives, which is a separate control. Every preset sets both, so
// switching away from it turns the lighting back off. SLICES ignores
// illumination entirely -- a plane has no surface to shade.
const RENDER_PRESETS = {
  volume: { mode: VOLUME_RENDER_MODE.COMPOSITE, illumination: 0 },
  matcap: { mode: VOLUME_RENDER_MODE.COMPOSITE, illumination: 0.6 },
  maximum: { mode: VOLUME_RENDER_MODE.MAXIMUM, illumination: 0 },
  slices: { mode: VOLUME_RENDER_MODE.SLICES, illumination: 0 },
}
const TISSUES = [
  { id: 'gm', file: 'mni152_gm.nii.gz', tint: [224, 104, 104] },
  { id: 'wm', file: 'mni152_wm.nii.gz', tint: [250, 250, 250] },
  { id: 'csf', file: 'mni152_csf.nii.gz', tint: [120, 160, 255] },
]

const nv1 = new NiiVue({
  backgroundColor: [0.5, 0.5, 0.5, 1],
  matcaps: { Shiny: shiny },
  is3DCrosshairVisible: true,
  // The cerebellar atlas labels every lobule, and the legend for them
  // takes a quarter of the canvas away from the render tile this demo is
  // about. Drop `isLegendVisible` to get it back.
  isLegendVisible: false,
  showRender: SHOW_RENDER.ALWAYS,
})
window.nv1 = nv1
nv1.addEventListener('locationChange', (e) => {
  document.getElementById('location').textContent = e.detail.string
})
await nv1.attachToCanvas(document.getElementById('gl1'))
// No matcap is loaded by default, and the Matcap preset needs one.
await nv1.loadMatcap('Shiny')

// A ramp from a pale version of the tint up to the tint, as in
// vox.tissues.html: a built-in saturated primary would repaint the
// anatomy rather than tint it, which is the opposite of the point here.
//
// White matter is tinted near-WHITE, not the mid-grey it looks like on
// its own. Two reasons, and the second is the one that bites: a tint
// darker than the T1's white matter makes 100%-WM voxels read grey, and
// it exposes the fact that three OVER layers are not a partition of
// unity -- coverage is 1 - a_gm*a_wm, so a 50/50 boundary voxel leaves a
// quarter of the bright T1 showing and the mixture blooms white. Tinting
// WM the colour of the thing behind it makes that dip invisible, and the
// mixtures then ramp smoothly from red to white the way partial volumes
// should. Give WM a colour unlike the T1 and the halo comes back.
for (const t of TISSUES) {
  const pale = (c) => Math.round(c * 0.75)
  const [r, g, b] = t.tint
  nv1.addColormap(t.id, {
    R: [pale(r), r],
    G: [pale(g), g],
    B: [pale(b), b],
    A: [0, 255],
    I: [0, 255],
  })
}

await nv1.loadVolumes([
  { url: T1, colormap: 'gray' },
  ...TISSUES.map((t) => ({
    url: `/volumes/${t.file}`,
    colormap: t.id,
    colormapType: 1,
    calMin: 0.05, // below this a voxel is essentially not this tissue
    calMax: 1,
  })),
])
await nv1.loadMeshes([
  { url: TRACTS },
  { url: CEREBELLUM, shaderType: 'matte' },
])

// Shader choice for the cerebellum only -- the tracts keep their own, so
// the two meshes show that a shader is per-mesh, not per-scene.
const cerebellumSelect = document.getElementById('cerebellumSelect')
for (const shader of [...nv1.meshShaders, HIDDEN]) {
  const option = document.createElement('option')
  option.value = shader
  option.textContent =
    shader === HIDDEN
      ? 'Hidden'
      : shader.charAt(0).toUpperCase() + shader.slice(1)
  option.selected = shader === 'matte'
  cerebellumSelect.appendChild(option)
}
cerebellumSelect.onchange = () => {
  const shaderType = cerebellumSelect.value
  nv1.setMesh(CEREBELLUM_MESH, {
    visible: shaderType !== HIDDEN,
    ...(shaderType === HIDDEN ? {} : { shaderType }),
  })
}

// These are partial-volume FRACTIONS, not labels, so a voxel on a tissue
// boundary is a blend of two of them. Overlay alpha is otherwise
// binarised: without this, a voxel that is 5% grey matter is as opaque as
// one that is 95%, and the boundary reads as a hard winner-take-all edge.
// Each overlay alpha-modulating ITSELF is what turns the fraction into
// coverage, so the layers blend by opacity instead.
const overlays = nv1.volumes.slice(1)
for (const vol of overlays) {
  await nv1.setModulationImage(vol.id, vol.id, 1)
}

const tissueOpacity = document.getElementById('tissueOpacity')
tissueOpacity.oninput = () => {
  const opacity = Number(tissueOpacity.value) / 100
  for (let i = 0; i < overlays.length; i++) {
    nv1.setVolume(i + 1, { opacity })
  }
}

const modeSelect = document.getElementById('modeSelect')
modeSelect.onchange = () => {
  const preset = RENDER_PRESETS[modeSelect.value]
  nv1.volumeRenderMode = preset.mode
  nv1.volumeIllumination = preset.illumination
}
// The markup is the single source of truth for the starting mode.
modeSelect.onchange()

document.getElementById('sliceType').onchange = (e) => {
  nv1.sliceType = parseInt(e.target.value, 10)
}

document.getElementById('darkCheck').onchange = (e) => {
  nv1.volumeIsAlphaClipDark = e.target.checked
}

document.getElementById('colorBtn').oninput = (e) => {
  const hex = e.target.value
  const chan = (i) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255
  nv1.backgroundColor = [chan(0), chan(1), chan(2), 1]
}

const webgpuCheck = document.getElementById('webgpuCheck')
// Reflects the backend actually running (WebGPU may fall back to WebGL2).
webgpuCheck.checked = nv1.backend === 'webgpu'
webgpuCheck.onchange = async () => {
  webgpuCheck.disabled = true
  try {
    await nv1.reinitializeView({
      backend: webgpuCheck.checked ? 'webgpu' : 'webgl2',
    })
  } finally {
    webgpuCheck.checked = nv1.backend === 'webgpu'
    webgpuCheck.disabled = false
    webgpuCheck.blur()
  }
}

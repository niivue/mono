import { shiny } from '../src/assets/matcaps'
import NiiVue, { OVERLAY_ALPHA_BLEND, SHOW_RENDER } from '../src/index.ts'

// Three partial-volume tissue maps (grey matter, white matter, CSF) over
// the T1 they were segmented from, each with its own opacity slider.
//
// The maps are continuous 0..1 fractions, not labels, so a voxel on a
// tissue boundary is a blend of two of them. Two things make that read
// correctly when three translucent layers overlap:
//
//  * colormapType 1 (ZERO_TO_MAX_TRANSPARENT_BELOW_MIN) keeps zero
//    genuinely transparent instead of painting the colormap's low end
//    over the anatomy.
//  * each overlay alpha-modulates ITSELF (setModulationImage(id, id, 1)).
//    Overlay alpha is otherwise binarised, so without this a voxel that is
//    5% grey matter would be as opaque as one that is 95% grey matter.
//
// Generated with brainchop's CAT-lite model and resliced back to the T1's
// native 188x256x190 0.88mm grid, so no overlay reslicing is involved.
const TISSUES = [
  {
    id: 'gm',
    name: 'grey matter',
    file: 'chris_t1_gm.nii.gz',
    tint: [224, 104, 104],
  },
  {
    id: 'wm',
    name: 'white matter',
    file: 'chris_t1_wm.nii.gz',
    tint: [250, 250, 250],
  },
  {
    id: 'csf',
    name: 'CSF',
    file: 'chris_t1_csf.nii.gz',
    tint: [120, 160, 255],
  },
]

const nv1 = new NiiVue({
  backend: document.getElementById('webgpuCheck').checked ? 'webgpu' : 'webgl2',
  backgroundColor: [0, 0, 0, 1],
  is3DCrosshairVisible: true,
  isSnapToVoxelCenters: true,
  // The tissue fractions sum to 1, so their opacities must add: with the
  // default MAX a voxel split 50/50 between GM and WM is only 50% opaque.
  volumeOverlayAlphaBlend: OVERLAY_ALPHA_BLEND.ADDITIVE,
  meshXRay: 0.1,
  showRender: SHOW_RENDER.ALWAYS,
  matcaps: { Shiny: shiny },
})
window.nv1 = nv1
nv1.addEventListener('locationChange', (e) => {
  document.getElementById('location').textContent = e.detail.string
})
await nv1.attachToCanvas(document.getElementById('gl1'))
// Fixed "Shiny" matcap; the Shading slider only sets how strongly it is
// applied. Lighting differentiates the volume, so it makes the tissue
// surfaces in the 3D render read as shape rather than as flat colour.
await nv1.loadMatcap('Shiny')

// A flat colormap: every nonzero voxel is the full tint, and the tissue
// fraction lives only in alpha (self-modulation below). A ramp would also
// darken low fractions, so 30% white matter would read as grey rather
// than as translucent white. A[0] = 0 keeps zero voxels transparent.
for (const t of TISSUES) {
  const [r, g, b] = t.tint
  nv1.addColormap(t.id, {
    R: [r, r],
    G: [g, g],
    B: [b, b],
    A: [0, 255],
    I: [0, 255],
  })
}

await nv1.loadVolumes([
  { url: '/volumes/chris_t1.nii.gz', colormap: 'gray' },
  ...TISSUES.map((t) => ({
    url: `/volumes/${t.file}`,
    colormap: t.id,
    colormapType: 1,
    // The window also scales the modulation weight, (f - calMin) / (calMax -
    // calMin), so 0..1 makes alpha the tissue fraction itself and the three
    // fractions sum to full opacity.
    calMin: 0,
    calMax: 1,
    opacity: 0.7,
  })),
])

// Ids are only known once the volumes are loaded, so self-modulation is set
// afterwards; each call commits its own updateGLVolume.
document.getElementById('bg').oninput = (e) =>
  nv1.setVolume(0, { opacity: e.target.value / 100 })
for (const [i, t] of TISSUES.entries()) {
  const vol = nv1.volumes[i + 1]
  await nv1.setModulationImage(vol.id, vol.id, 1)
  document.getElementById(t.id).oninput = (e) =>
    nv1.setVolume(i + 1, { opacity: e.target.value / 100 })
}

const gradSlider = document.getElementById('gradSlider')
gradSlider.oninput = () => {
  nv1.volumeIllumination = Number(gradSlider.value) / 100
}
gradSlider.oninput()

const sliceTypeSelect = document.getElementById('sliceType')
sliceTypeSelect.onchange = (e) => {
  nv1.sliceType = parseInt(e.target.value, 10)
}
nv1.addEventListener('sliceTypeChange', (e) => {
  sliceTypeSelect.value = String(e.detail.sliceType)
})
document.getElementById('alphaBlend').onchange = (e) => {
  nv1.volumeOverlayAlphaBlend = e.target.selectedIndex
}
document.getElementById('colorBlend').onchange = (e) => {
  nv1.volumeOverlayColorBlend = e.target.selectedIndex
}
document.getElementById('nearestCheck').onchange = (e) => {
  nv1.volumeIsNearestInterpolation = e.target.checked
}
document.getElementById('xrayCheck').onclick = function () {
  nv1.meshXRay = +this.checked * 0.1
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
document.getElementById('viewKey').onchange = (e) => {
  nv1.isViewModeHotKeyEnabled = e.target.checked
  // the focused checkbox is an INPUT, which the hotkey ignores
  e.target.blur()
}

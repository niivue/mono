import NiiVue from '../src/index.ts'

const gl1 = document.getElementById('gl1')

const colorBtn = document.getElementById('colorBtn')
const sliceType = document.getElementById('sliceType')
const webgpuCheck = document.getElementById('webgpuCheck')

// A grayscale MNI152 anatomy plus a binary brain-region mask (0..1).
// The "modulate" mode alpha-modulates the *background* volume by the mask,
// so anatomy outside the mask becomes transparent and the canvas
// background colour shows through (change it to see the effect) — in the
// 2D slices AND the 3D render.
const nv1 = new NiiVue({
  backgroundColor: [0.102, 0.227, 0.353, 1],
  is3DCrosshairVisible: true,
  // clip voxels the mask drives to alpha 0 so the background colour shows
  volumeIsAlphaClipDark: true,
})
window.nv1 = nv1
nv1.addEventListener('locationChange', (e) => {
  document.getElementById('location').textContent = e.detail.string
})
await nv1.attachToCanvas(gl1)
await nv1.loadVolumes([
  { url: '/volumes/mni152.nii.gz', colormap: 'gray' },
  {
    url: '/volumes/mni152_mask.nii.gz',
    colormap: 'red',
    calMin: 0,
    calMax: 1,
    opacity: 0,
    isColorbarVisible: false,
  },
])

const volId = () => nv1.volumes[0].id
const maskId = () => nv1.volumes[1].id

async function applyMode() {
  const mode = document.getElementById('mode').value
  // Default: anatomy opaque, mask hidden, no modulation.
  let volOpacity = 1
  let maskOpacity = 0
  let modulate = false
  if (mode === 'volume') {
    // grayscale anatomy only
  } else if (mode === 'mask') {
    // mask alone — hide the anatomy, show the mask
    volOpacity = 0
    maskOpacity = 1
  } else if (mode === 'both') {
    // anatomy with the mask region tinted on top
    maskOpacity = 0.5
  } else if (mode === 'modulate') {
    // anatomy gated by the mask (transparent outside the mask)
    modulate = true
  }
  nv1.volumes[0].opacity = volOpacity
  nv1.volumes[1].opacity = maskOpacity
  // setModulationImage runs updateGLVolume after these opacity writes, so a
  // single call commits opacity + modulation in one render (no second pass).
  await nv1.setModulationImage(volId(), modulate ? maskId() : '', 1)
}

sliceType.onchange = () => {
  nv1.sliceType = parseInt(sliceType.value, 10)
}
document.getElementById('mode').onchange = applyMode
colorBtn.addEventListener('input', (event) => {
  const hex = event.target.value
  nv1.backgroundColor = [
    parseInt(hex.slice(1, 3), 16) / 255,
    parseInt(hex.slice(3, 5), 16) / 255,
    parseInt(hex.slice(5, 7), 16) / 255,
    1.0,
  ]
})
webgpuCheck.onchange = async function () {
  await nv1.reinitializeView({
    backend: this.checked ? 'webgpu' : 'webgl2',
  })
  await applyMode()
}

nv1.setClipPlane([0.15, 270, 0])
nv1.azimuth = 45
nv1.elevation = 45
sliceType.onchange()
await applyMode()

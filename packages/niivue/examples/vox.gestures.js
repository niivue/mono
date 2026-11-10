import NiiVue, { DRAG_MODE } from '../src/index.ts'

const gl1 = document.getElementById('gl1')

const clearAllBtn = document.getElementById('clearAllBtn')
const clearAnglesBtn = document.getElementById('clearAnglesBtn')
const clearRulersBtn = document.getElementById('clearRulersBtn')
const fillCheck = document.getElementById('fillCheck')
const primaryDrag = document.getElementById('primaryDrag')
const secondaryDrag = document.getElementById('secondaryDrag')
const sliceType = document.getElementById('sliceType')
const webgpuCheck = document.getElementById('webgpuCheck')

primaryDrag.onchange = function () {
  nv1.primaryDragMode = parseInt(this.value, 10)
}
secondaryDrag.onchange = function () {
  nv1.secondaryDragMode = parseInt(this.value, 10)
}
// Read the element rather than `this`: the startup call below is a bare
// call, and a module is strict mode, so `this` would be undefined.
sliceType.onchange = () => {
  const type = parseInt(sliceType.value, 10)
  nv1.sliceType = type
  // Fill Canvas only governs a lone 2D slice (axial/coronal/sagittal).
  fillCheck.disabled = type > 2
}
// Rulers and angles clear independently, so erasing one kind leaves the
// other on screen; clearMeasurements() still drops both at once.
clearRulersBtn.onclick = () => nv1.clearDistanceMeasurements()
clearAnglesBtn.onclick = () => nv1.clearAngles()
clearAllBtn.onclick = () => nv1.clearMeasurements()
function handleLocationChange(data) {
  document.getElementById('location').innerHTML = `&nbsp;&nbsp;${data.string}`
}
fillCheck.onchange = function () {
  nv1.isSingleViewFillCanvas = this.checked
}
webgpuCheck.onchange = async function () {
  await nv1.reinitializeView({ backend: this.checked ? 'webgpu' : 'webgl2' })
}
function handleDragRelease(info) {
  if (info.tileIdx < 0) {
    document.getElementById('location').innerHTML = 'Invalid drag'
  } else {
    const orientNames = ['Axial', 'Coronal', 'Sagittal', 'Multi', 'Render']
    document.getElementById('location').innerHTML =
      `Tile:${info.tileIdx} ` +
      `Orient:${orientNames[info.axCorSag] ?? info.axCorSag} ` +
      `Length:${Math.round(info.mmLength)}mm ` +
      `x:${info.voxStart[0]}..${info.voxEnd[0]} ` +
      `y:${info.voxStart[1]}..${info.voxEnd[1]} ` +
      `z:${info.voxStart[2]}..${info.voxEnd[2]}`
  }
}

// WebKit (Safari, and every iOS browser) runs WebGPU about 4x slower with
// anti-aliasing on (#381), so it is off there and on elsewhere (as slides.js).
const isWebKit =
  /AppleWebKit/.test(navigator.userAgent) &&
  !/Chrome|Chromium|Edg\//.test(navigator.userAgent) // iOS Edge (EdgiOS) is WebKit
// Optional `?backend=webgl2` (or webgpu) picks the initial backend; the
// WebGPU checkbox mirrors it and can still switch at runtime.
const initialBackend =
  new URLSearchParams(window.location.search).get('backend') === 'webgl2'
    ? 'webgl2'
    : 'webgpu'
webgpuCheck.checked = initialBackend === 'webgpu'

const nv1 = new NiiVue({
  backgroundColor: [0.2, 0.2, 0.2, 1],
  isColorbarVisible: true,
  secondaryDragMode: DRAG_MODE.pan,
  primaryDragMode: DRAG_MODE.crosshair,
  backend: initialBackend,
  isAntiAlias: !isWebKit,
})
nv1.addEventListener('locationChange', (e) => handleLocationChange(e.detail))
nv1.addEventListener('dragRelease', (e) => handleDragRelease(e.detail))
await nv1.attachToCanvas(gl1)
sliceType.onchange()
await nv1.loadVolumes({ url: '/volumes/mni152.nii.gz' })

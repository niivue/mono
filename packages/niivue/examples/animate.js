import NiiVue, { SHOW_RENDER } from '../src/index.ts'

// Animated transitions: animateTo moves the scene to a target state over
// time. Each button awaits one or more transitions; pressing on or scrolling
// the canvas, or pressing Stop, ends the one running and leaves the scene
// where it is. The footer shows how each transition ended.

const nv1 = new NiiVue({
  backgroundColor: [0, 0, 0, 1],
  showRender: SHOW_RENDER.ALWAYS,
})
window.nv1 = nv1
await nv1.attachToCanvas(gl1)
webgpuCheck.checked = nv1.backend === 'webgpu'
await nv1.loadVolumes([
  { url: '/volumes/mni152.nii.gz', colormap: 'gray' },
  {
    url: '/volumes/mni152_gm.nii.gz',
    colormap: 'warm',
    calMin: 0.5,
    calMax: 1,
    opacity: 0,
  },
])

// Where Reset returns to.
const HOME = {
  azimuth: 110,
  elevation: 15,
  scaleMultiplier: 1,
  crosshairMM: nv1.getCrosshairPos(),
  // Depth 2 puts the plane outside the volume, so nothing is cut.
  clipPlanes: { 0: [2, 270, 0] },
  volumes: { 1: { opacity: 0 } },
}
await nv1.animateTo(HOME, { duration: 0 })

function options() {
  return {
    duration: Number(durationSlider.value),
    easing: easingSelect.value,
  }
}

function report(label, result) {
  stats.textContent = `${label}: ${result.reason} after ${Math.round(result.elapsedMs)} ms`
}

/** Run steps in order, stopping at the first that does not finish. */
async function run(label, steps, extra = {}) {
  for (const step of steps) {
    const result = await nv1.animateTo(step, { ...options(), ...extra })
    report(label, result)
    if (!result.completed) return
  }
}

tourButton.onclick = () =>
  run('Tour', [
    { azimuth: 200, elevation: 35 },
    { clipPlanes: { 0: [0, 270, 0] } },
    { volumes: { 1: { opacity: 0.8 } }, scaleMultiplier: 1.3 },
    { crosshairMM: [-38, -20, 52] },
    HOME,
  ])
// Literal angles: 360 degrees more than now is one full turn, where the
// default shortest turn would not move at all.
spinButton.onclick = () =>
  run('Spin', [{ azimuth: nv1.azimuth + 360 }], {
    angles: 'literal',
    easing: 'linear',
  })
clipButton.onclick = () =>
  run('Sweep clip plane', [
    { clipPlanes: { 0: [0.3, 270, 0] } },
    { clipPlanes: { 0: [-0.3, 270, 0] } },
    { clipPlanes: { 0: [2, 270, 0] } },
  ])
fadeButton.onclick = () =>
  run('Fade overlay', [
    { volumes: { 1: { opacity: nv1.volumes[1].opacity > 0.4 ? 0 : 0.8 } } },
  ])
resetButton.onclick = () => run('Reset', [HOME])
stopButton.onclick = () => nv1.stopAnimation()

sliceType.onchange = () => {
  nv1.sliceType = parseInt(sliceType.value, 10)
}
webgpuCheck.onchange = async function () {
  nv1.stopAnimation()
  try {
    await nv1.reinitializeView({ backend: this.checked ? 'webgpu' : 'webgl2' })
  } finally {
    // Reflect the backend actually in use (WebGPU can fall back to WebGL2).
    webgpuCheck.checked = nv1.backend === 'webgpu'
  }
}

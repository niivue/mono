import { cortex, shiny } from '../src/assets/matcaps'
import NiiVue from '../src/index.ts'
import { SHOW_RENDER } from '../src/NVConstants.ts'

gradSlider.oninput = () => {
  nv1.volumeIllumination = Number(gradSlider.value) / 100
}
webgpuCheck.onclick = function () {
  nv1.reinitializeView({ backend: this.checked ? 'webgpu' : 'webgl2' })
}
function handleLocationChange(data) {
  document.getElementById('location').innerHTML = `&nbsp;&nbsp;${data.string}`
}
sliceType.onchange = () => {
  nv1.sliceType = parseInt(sliceType.value, 10)
}
clipSelect.onchange = function () {
  const index = parseInt(this.value, 10) // selected option value as integer
  let planes = [[2.0, 180, 20]]
  switch (index) {
    case 1:
      planes = [[-0.1, 180, 20]]
      break
    case 2:
      planes = [
        [0.1, 180, 20],
        [0.1, 0, -20],
      ]
      break
    case 3:
      planes = [
        [0.0, 90, 0], //right center
        [0.0, 0, -20], //posterior oblique
        [0.1, 0, -90], //inferior
      ]
      break
    case 4:
      planes = [
        [0.3, 270, 0], //left
        [0.3, 90, 0], //right
        [0.0, 180, 0], //anterior
        [0.1, 0, 0], //posterior
      ]
      break
    case 5:
      planes = [
        [0.4, 270, 0], //left
        [0.4, 90, 0], //right
        [0.4, 180, 0], //anterior
        [0.2, 0, 0], //posterior
        [0.1, 0, -90], //inferior
      ]
      break
    case 6:
      planes = [
        [0.4, 270, 0], //left
        [-0.1, 90, 0], //right
        [0.4, 180, 0], //anterior
        [0.2, 0, 0], //posterior
        [0.1, 0, -90], //inferior
        [0.3, 0, 90], //superior
      ]
      break
  }
  nv1.setClipPlanes(planes)
}
matcapSelect.onchange = async () => {
  await nv1.loadMatcap(matcapSelect.value)
}
benchBtn.onclick = async () => {
  const view = nv1.view
  if (!view) {
    console.warn('bench harness unavailable')
    return
  }
  const bench = view.bench
  const backend = view.device ? 'WebGPU' : view.gl ? 'WebGL2' : 'unknown'
  const WARMUP = 10
  const SAMPLES = 200
  benchBtn.disabled = true
  benchBtn.textContent = 'Benchmarking...'
  for (let i = 0; i < WARMUP; i++) await bench.renderAndFlushOffscreen()
  // Sanity check for WebGL2: confirm the offscreen FBO actually got pixels.
  // Helps catch silent no-renders (incomplete FBO, stale bounds, etc.).
  if (view.gl && bench.fboW > 0) {
    const gl = view.gl
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, bench.fbo)
    const pix = new Uint8Array(4)
    gl.readPixels(
      bench.fboW >> 1,
      bench.fboH >> 1,
      1,
      1,
      gl.RGBA,
      gl.UNSIGNED_BYTE,
      pix,
    )
    gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null)
    const blank = pix[0] === 0 && pix[1] === 0 && pix[2] === 0
    console.log(
      `${backend} FBO ${bench.fboW}x${bench.fboH} bounds=${view.boundsWidth}x${view.boundsHeight} center=[${Array.from(pix)}]${blank ? ' BLANK — NOT RENDERING' : ''}`,
    )
  } else {
    console.log(`${backend} bounds=${view.boundsWidth}x${view.boundsHeight}`)
  }
  const times = new Float64Array(SAMPLES)
  for (let i = 0; i < SAMPLES; i++) {
    const t0 = performance.now()
    await view.renderAndFlushOffscreen()
    times[i] = performance.now() - t0
  }
  const sorted = Array.from(times).sort((a, b) => a - b)
  const mean = sorted.reduce((s, x) => s + x, 0) / sorted.length
  const median = sorted[Math.floor(sorted.length * 0.5)]
  const p95 = sorted[Math.floor(sorted.length * 0.95)]
  const fmt = (n) => n.toFixed(2)
  const msg = `${backend}  n=${SAMPLES}  median=${fmt(median)}ms  mean=${fmt(mean)}ms  p95=${fmt(p95)}ms  (~${fmt(1000 / median)} fps)`
  console.log(msg)
  benchBtn.textContent = `${backend} ${fmt(median)}ms`
  benchBtn.disabled = false
}
const nv1 = new NiiVue({
  matcaps: { Cortex: cortex, Shiny: shiny },
  showRender: SHOW_RENDER.ALWAYS,
})
await nv1.attachToCanvas(gl1)
nv1.sliceType = 4
await nv1.loadVolumes([{ url: '/volumes/torso.nii.gz' }])
nv1.addEventListener('locationChange', (e) => handleLocationChange(e.detail))
gradSlider.oninput()
nv1.addColormap('_torso', {
  R: [0, 0, 185, 185, 252, 0, 103, 216, 127, 127, 0, 222],
  G: [0, 20, 102, 102, 0, 255, 76, 132, 0, 127, 255, 154],
  B: [0, 152, 83, 83, 0, 0, 71, 105, 127, 0, 255, 132],
  A: [0, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255, 255],
  I: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
  labels: [
    'background',
    '1spleen',
    '2kidneyR',
    '3kidneyL',
    '4gallbladder',
    '5esophagus',
    '6Liver',
    '7stomach',
    '8aorta',
    '9inferiorvenacava',
    '10pancreas',
    '11bladder',
  ],
})
nv1.drawColormap = '_torso'
await nv1.loadDrawing('/volumes/torsoLabel.nii.gz')
nv1.drawIsEnabled = false
clipSelect.onchange()
matcapSelect.onchange()

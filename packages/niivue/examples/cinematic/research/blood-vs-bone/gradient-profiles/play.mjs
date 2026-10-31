import angio from '../../packages/niivue/examples/cinematic/cr_angio.json'
import { bakeTransferFunction } from '../../packages/niivue/examples/cinematic/tf.js'
import NiiVue, {
  getImageDataRAS,
  SLICE_TYPE,
} from '../../packages/niivue/src/index.ts'
import { calculateMvpMatrix } from '../../packages/niivue/src/math/NVTransforms.ts'
import { BoundaryRenderer } from './profile.mjs'

const el = Object.fromEntries(
  [
    'scan',
    'profile',
    'scale',
    'strength',
    'amount',
    'toggle',
    'status',
    'cine',
    'gl',
  ].map((id) => [id, document.getElementById(id)]),
)
el.scan.value =
  new URLSearchParams(location.search).get('scan') === 'Abdo'
    ? 'Abdo'
    : 'Philips'
el.scan.onchange = () => {
  location.search = `?scan=${el.scan.value}`
}
const nv = new NiiVue({
  sliceType: SLICE_TYPE.RENDER,
  backgroundColor: [0, 0, 0, 0],
  azimuth: 110,
  elevation: 10,
})
await nv.attachToCanvas(el.gl)
// The local study uses the supplied data; no external download is needed.
await nv.loadVolumes([
  {
    url: new URL(`./data/CT_${el.scan.value}.nii.gz`, import.meta.url).href,
  },
])
await nv.setVolume(0, { opacity: 1.01 / 255 })
const adapter = await navigator.gpu?.requestAdapter()
if (!adapter) throw new Error('WebGPU is unavailable')
const device = await adapter.requestDevice({
  requiredFeatures: adapter.features.has('timestamp-query')
    ? ['timestamp-query']
    : [],
  requiredLimits: {
    maxBufferSize: adapter.limits.maxBufferSize,
    maxStorageBufferBindingSize: adapter.limits.maxStorageBufferBindingSize,
  },
})
const cr = new BoundaryRenderer(el.cine, device)
const volume = nv.volumes[0],
  raw = getImageDataRAS(volume),
  slope = volume.hdr.scl_slope || 1,
  intercept = volume.hdr.scl_inter || 0
cr.setVolume(
  Float32Array.from(raw, (v) => v * slope + intercept),
  volume.dimsRAS.slice(1, 4),
  volume.frac2mm,
)
cr.setTransferFunction(bakeTransferFunction(angio))
cr.settings.maxFrames = 64
let busy = false,
  key = '',
  previous = 'positive'
const controls = [el.profile, el.scale, el.strength, el.toggle]
async function update() {
  if (busy) return
  busy = true
  for (const e of controls) e.disabled = true
  try {
    const mode = el.profile.value
    const presets = {
      positive: { feature: 2, range: [25, 75] },
      absolute: { feature: 0, range: [25, 75] },
      endpoint: { feature: 1, range: [450, 650] },
    }
    const start = performance.now()
    await cr.prepare(
      mode === 'off'
        ? null
        : {
            ...presets[mode],
            scaleMM: Number(el.scale.value),
            strength: Number(el.strength.value),
          },
    )
    el.status.textContent = `Prepared in ${(performance.now() - start).toFixed(0)} ms`
  } finally {
    busy = false
    for (const e of controls) e.disabled = false
  }
}
el.profile.onchange = update
el.scale.onchange = update
el.strength.oninput = () => {
  el.amount.textContent = el.strength.value
}
el.strength.onchange = update
el.toggle.onclick = () => {
  if (el.profile.value === 'off') el.profile.value = previous
  else {
    previous = el.profile.value
    el.profile.value = 'off'
  }
  update()
}
function tick() {
  if (!busy) {
    const m = nv.model,
      pivot = m._renderPivotMM ?? m.pivot3D,
      w = el.gl.clientWidth,
      h = el.gl.clientHeight
    const next = [
      m.scene.azimuth,
      m.scene.elevation,
      m.scene.scaleMultiplier,
      ...m.scene.renderPan,
      ...pivot,
      m.furthestFromPivot,
      w,
      h,
    ].join()
    if (next !== key) {
      key = next
      const [mvp, model] = calculateMvpMatrix(
        [0, 0, w, h],
        m.scene.azimuth,
        m.scene.elevation,
        pivot,
        m.furthestFromPivot,
        m.scene.scaleMultiplier,
        m.volumes[0]?.obliqueRAS,
        m.scene.renderPan,
      )
      cr.setCamera(mvp, model)
    }
    cr.render()
  }
  requestAnimationFrame(tick)
}
device.addEventListener('uncapturederror', (e) => {
  el.status.textContent = e.error.message
  console.error(e.error.message)
})
await update()
requestAnimationFrame(tick)
window.boundaryStudy = { nv, cr, update }

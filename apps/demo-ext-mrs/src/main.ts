/**
 * NiiVue MRSI (MR spectroscopic imaging) demo.
 *
 * Reproduces the FSLeyes MRS plugin workflow with @niivue/nv-ext-mrs:
 *   - T1 anatomy (background) + the complex MRSI grid (overlay shown as a
 *     derived total-signal map, masked to valid voxels)
 *   - move the ortho crosshair -> the spectrum at that voxel updates live
 *   - component / apodization / phase / ppm-window controls
 *   - "Make map": integrate the current ppm band across all voxels -> overlay
 *
 * The spectral math runs inside NiiVue core (ported from fsleyes-plugin-mrs);
 * this page only drives the MrsScene controller and the graph.
 */

import NiiVue, { SLICE_TYPE } from '@niivue/niivue'
import { MrsScene } from '@niivue/nv-ext-mrs'

// Data lives alongside the other signal fixtures in @niivue/dev-images
// (images/signals/), served at /signals/.
const DATA_BASE = '/signals'
const footer = document.getElementById('location') as HTMLElement

function fail(msg: string, err?: unknown): void {
  // textContent (not innerHTML): messages may include data-derived strings.
  footer.textContent = `  ${msg}${err ? `: ${(err as Error)?.message ?? err}` : ''}`
  if (err) console.error(msg, err)
}

const nv = new NiiVue({
  backgroundColor: [0.1, 0.1, 0.1, 1],
  isGraphVisible: true,
})
await nv.attachToCanvas(document.getElementById('gl1') as HTMLCanvasElement)
nv.sliceType = SLICE_TYPE.AXIAL

const scene = new MrsScene(nv)

try {
  await scene.load({
    anatomyUrl: `${DATA_BASE}/mrsi_T1.nii.gz`,
    mrsiUrl: `${DATA_BASE}/mrsi.nii.gz`,
    maskUrl: `${DATA_BASE}/mrsi_mask.nii.gz`,
    mrsiColormap: 'warm',
    mrsiOpacity: 0.7,
  })
  footer.textContent =
    '  Move the crosshair over the MRSI grid to inspect a voxel spectrum.'
} catch (err) {
  fail('Could not load MRSI scene', err)
}

// --- Controls ---------------------------------------------------------------

const $ = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T
const modeSelect = $<HTMLSelectElement>('modeSelect')
const apod = $<HTMLInputElement>('apod')
const apodVal = $<HTMLSpanElement>('apodVal')
const p0 = $<HTMLInputElement>('p0')
const p0Val = $<HTMLSpanElement>('p0Val')
const p1 = $<HTMLInputElement>('p1')
const p1Val = $<HTMLSpanElement>('p1Val')
const ppmLow = $<HTMLInputElement>('ppmLow')
const ppmLowVal = $<HTMLSpanElement>('ppmLowVal')
const ppmHigh = $<HTMLInputElement>('ppmHigh')
const ppmHighVal = $<HTMLSpanElement>('ppmHighVal')
const fullRangeBtn = $<HTMLButtonElement>('fullRangeBtn')
const makeMapBtn = $<HTMLButtonElement>('makeMapBtn')
const threshold = $<HTMLInputElement>('threshold')
const thresholdVal = $<HTMLSpanElement>('thresholdVal')
const mapOpacity = $<HTMLInputElement>('mapOpacity')
const mapOpacityVal = $<HTMLSpanElement>('mapOpacityVal')
const mapMode = $<HTMLSelectElement>('mapMode')
const cmapSelect = $<HTMLSelectElement>('cmapSelect')
const colorbarCheck = $<HTMLInputElement>('colorbarCheck')
const maskCheck = $<HTMLInputElement>('maskCheck')
const snapCheck = $<HTMLInputElement>('snapCheck')
const viewSelect = $<HTMLSelectElement>('viewSelect')
const colorBtn = $<HTMLInputElement>('colorBtn')
const webgpuCheck = $<HTMLInputElement>('webgpuCheck')

function ppmWindow(): [number, number] | null {
  const lo = parseFloat(ppmLow.value)
  const hi = parseFloat(ppmHigh.value)
  return lo < hi ? [lo, hi] : null
}

function syncPpm(): void {
  ppmLowVal.textContent = parseFloat(ppmLow.value).toFixed(1)
  ppmHighVal.textContent = parseFloat(ppmHigh.value).toFixed(1)
  const w = ppmWindow()
  if (w) scene.setPpmWindow(w)
}

modeSelect.onchange = () =>
  scene.setComponent(
    modeSelect.value as 'real' | 'imag' | 'magnitude' | 'phase',
  )

apod.oninput = () => {
  apodVal.textContent = apod.value
  scene.setApodization(parseFloat(apod.value))
}

function syncPhase(): void {
  p0Val.textContent = p0.value
  p1Val.textContent = parseFloat(p1.value).toFixed(1)
  scene.setPhase(parseFloat(p0.value), parseFloat(p1.value))
}
p0.oninput = syncPhase
p1.oninput = syncPhase

ppmLow.oninput = syncPpm
ppmHigh.oninput = syncPpm
fullRangeBtn.onclick = () => {
  const i = nv.signals.findIndex((s) => s.followsCrosshair)
  if (i >= 0) nv.setSignal(i, { display: { ppmRange: null } })
}

// Track the most recently added map so the opacity slider targets it.
let lastMapId: string | null = null
makeMapBtn.onclick = async () => {
  const w = ppmWindow()
  if (!w) {
    fail('Set a valid ppm window (low < high) before making a map')
    return
  }
  makeMapBtn.disabled = true
  try {
    const map = await scene.makeMap(w, {
      mode: mapMode.value as 'magnitude' | 'real',
      apodizeHz: parseFloat(apod.value),
      phase0: parseFloat(p0.value),
      phase1Ms: parseFloat(p1.value),
      opacity: parseFloat(mapOpacity.value),
    })
    lastMapId = map.id ?? map.name
    footer.textContent = `  Added metabolite map ${map.name} (${w[0].toFixed(1)}-${w[1].toFixed(1)} ppm).`
  } catch (err) {
    fail('Make map failed', err)
  } finally {
    makeMapBtn.disabled = false
  }
}

mapOpacity.oninput = () => {
  mapOpacityVal.textContent = parseFloat(mapOpacity.value).toFixed(2)
  if (!lastMapId) return
  const idx = nv.volumes.findIndex((v) => v.id === lastMapId)
  if (idx >= 0) nv.setVolume(idx, { opacity: parseFloat(mapOpacity.value) })
}

// Configure the threshold slider to the MRSI overlay's total-signal range.
const cal = scene.mrsiCal
if (cal) {
  const max = Math.max(1, cal.globalMax)
  threshold.min = '0'
  threshold.max = max.toFixed(2)
  threshold.step = (max / 200).toPrecision(2)
  threshold.value = String(cal.calMin)
  thresholdVal.textContent = cal.calMin.toFixed(1)
}
threshold.oninput = () => {
  const t = parseFloat(threshold.value)
  thresholdVal.textContent = t.toFixed(1)
  scene.setThreshold(t)
}

cmapSelect.onchange = () => scene.setColormap(cmapSelect.value)
colorbarCheck.onchange = () => scene.showColorbar(colorbarCheck.checked)
maskCheck.onchange = () => scene.setMaskEnabled(maskCheck.checked)
snapCheck.onchange = () => scene.enableVoxelSnap(snapCheck.checked)

viewSelect.onchange = () => {
  nv.sliceType = parseInt(viewSelect.value, 10)
}

colorBtn.addEventListener('input', (event) => {
  const hex = (event.target as HTMLInputElement).value
  nv.backgroundColor = [
    parseInt(hex.slice(1, 3), 16) / 255,
    parseInt(hex.slice(3, 5), 16) / 255,
    parseInt(hex.slice(5, 7), 16) / 255,
    1.0,
  ]
})

webgpuCheck.onclick = () => {
  nv.reinitializeView({ backend: webgpuCheck.checked ? 'webgpu' : 'webgl2' })
}

nv.addEventListener('signalLocationChange', (e) => {
  const detail = (e as CustomEvent<{ string: string }>).detail
  footer.textContent = `  ${detail.string}`
})

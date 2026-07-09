import NiiVue, { MrsScene, SLICE_TYPE } from '../src/index.ts'

// Reproduces the FSLeyes MRS plugin
//  https://pages.fmrib.ox.ac.uk/wclarke/fsleyes-plugin-mrs/

const nv = new NiiVue({
  backgroundColor: [0.1, 0.1, 0.1, 1],
  isGraphVisible: true,
})
await nv.attachToCanvas(gl1)
nv.sliceType = SLICE_TYPE.AXIAL

// id="location" shadows window.location, so this one element is looked up.
const footer = document.getElementById('location')

function fail(msg, err) {
  // textContent (not innerHTML): messages may include data-derived strings.
  footer.textContent = `  ${msg}${err ? `: ${err?.message ?? err}` : ''}`
  if (err) console.error(msg, err)
}

let locationStr = ''
let spectrumStr = ''
function showStatus() {
  const gap = locationStr && spectrumStr ? '   ' : ''
  footer.textContent = `  ${locationStr}${gap}${spectrumStr}`
}
nv.addEventListener('locationChange', (e) => {
  locationStr = e.detail.string
  showStatus()
})
nv.addEventListener('signalLocationChange', (e) => {
  spectrumStr = e.detail.string
  showStatus()
})

const scene = new MrsScene(nv)
try {
  await scene.load({
    anatomyUrl: '/signals/mrsi_T1.nii.gz',
    mrsiUrl: '/signals/mrsi.nii.gz',
    maskUrl: '/signals/mrsi_mask.nii.gz',
    mrsiColormap: 'warm',
    mrsiOpacity: 0.7,
  })
  nv.setCrosshairPos([-2, -2, 43])
} catch (err) {
  fail('Could not load MRSI scene', err)
}

// --- Controls ---------------------------------------------------------------

function ppmWindow() {
  const lo = parseFloat(ppmLow.value)
  const hi = parseFloat(ppmHigh.value)
  return lo < hi ? [lo, hi] : null
}

// See svs.html for the two range modes. Default: the sliders set the explicit
// ppm window (scene.setPpmWindow -> ppmRange) and the in-graph zoom is transient
// (it auto-resets on a range change). Reactive (checkbox): the sliders drive the
// live view window via setGraphRange() and follow the in-graph zoom/pan via the
// graphRangeChange event. makeMap reads the slider values directly in both modes.
const isReactive = () => reactiveCheck.checked

function syncPpm() {
  ppmLowVal.textContent = parseFloat(ppmLow.value).toFixed(1)
  ppmHighVal.textContent = parseFloat(ppmHigh.value).toFixed(1)
  const w = ppmWindow()
  if (isReactive()) nv.setGraphRange(w)
  else if (w) scene.setPpmWindow(w)
}

// Reflect in-graph zoom/pan onto the sliders (reactive mode only). Setting
// .value programmatically does not fire 'input', so there is no feedback loop.
nv.addEventListener('graphRangeChange', (e) => {
  if (!isReactive()) return
  ppmLow.value = Math.min(e.detail.min, e.detail.max).toFixed(1)
  ppmHigh.value = Math.max(e.detail.min, e.detail.max).toFixed(1)
  ppmLowVal.textContent = parseFloat(ppmLow.value).toFixed(1)
  ppmHighVal.textContent = parseFloat(ppmHigh.value).toFixed(1)
})

reactiveCheck.onchange = () => {
  nv.graphAutoResetView = !isReactive()
  const i = nv.signals.findIndex((s) => s.followsCrosshair)
  if (isReactive()) {
    // Hand the range to the view window: clear the explicit ppmRange and seed the
    // window from the current sliders.
    if (i >= 0) nv.setSignal(i, { display: { ppmRange: null } })
    nv.setGraphRange(ppmWindow())
  } else {
    // Back to explicit-range mode: drop the window and bake the sliders in.
    nv.graphResetView()
    const w = ppmWindow()
    if (w) scene.setPpmWindow(w)
  }
}

modeSelect.onchange = () => scene.setComponent(modeSelect.value)

apod.oninput = () => {
  apodVal.textContent = apod.value
  scene.setApodization(parseFloat(apod.value))
}

function syncPhase() {
  p0Val.textContent = p0.value
  p1Val.textContent = parseFloat(p1.value).toFixed(1)
  scene.setPhase(parseFloat(p0.value), parseFloat(p1.value))
}
p0.oninput = syncPhase
p1.oninput = syncPhase

ppmLow.oninput = syncPpm
ppmHigh.oninput = syncPpm
fullRangeBtn.onclick = () => {
  if (isReactive()) {
    nv.setGraphRange(null)
  } else {
    const i = nv.signals.findIndex((s) => s.followsCrosshair)
    if (i >= 0) nv.setSignal(i, { display: { ppmRange: null } })
  }
  // Jump the sliders to the full data extent so they reflect what is shown.
  const r = nv.getGraphRange()
  if (r) {
    ppmLow.value = r.full[0].toFixed(1)
    ppmHigh.value = r.full[1].toFixed(1)
    ppmLowVal.textContent = parseFloat(ppmLow.value).toFixed(1)
    ppmHighVal.textContent = parseFloat(ppmHigh.value).toFixed(1)
  }
}

// Track the most recently added map so the opacity slider targets it.
let lastMapId = null
makeMapBtn.onclick = async () => {
  const w = ppmWindow()
  if (!w) {
    fail('Set a valid ppm window (low < high) before making a map')
    return
  }
  makeMapBtn.disabled = true
  try {
    const map = await scene.makeMap(w, {
      mode: mapMode.value,
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
  if (idx >= 0) {
    // High-frequency slider: silence rejections (don't spam the footer).
    void nv
      .setVolume(idx, { opacity: parseFloat(mapOpacity.value) })
      .catch(() => {})
  }
}

// Configure the threshold slider to the MRSI overlay's total-signal range.
const cal = scene.mrsiCal
if (cal) {
  const max = Math.max(1, cal.calMax)
  threshold.min = '0'
  threshold.max = max.toFixed()
  threshold.step = (max / 200).toPrecision(2)
  // Default threshold: midpoint of the overlay's cal range, rounded to integer.
  const mid = Math.round((cal.calMin + cal.calMax) / 2)
  threshold.value = String(mid)
  thresholdVal.textContent = mid.toFixed(1)
  scene.setThreshold(mid)
}
threshold.oninput = () => {
  const t = parseFloat(threshold.value)
  thresholdVal.textContent = t.toFixed(1)
  scene.setThreshold(t)
}

cmapSelect.onchange = () => scene.setColormap(cmapSelect.value)
colorbarCheck.onchange = () => scene.showColorbar(colorbarCheck.checked)
maskCheck.onchange = () => {
  // Surface a failed mask render in the footer and revert the checkbox so it
  // does not diverge from the displayed state.
  const want = maskCheck.checked
  scene.setMaskEnabled(want).catch((err) => {
    fail('Mask toggle failed', err)
    maskCheck.checked = !want
  })
}
snapCheck.onchange = () => scene.enableVoxelSnap(snapCheck.checked)

viewSelect.onchange = () => {
  nv.sliceType = parseInt(viewSelect.value, 10)
}

colorBtn.oninput = () => {
  const hex = colorBtn.value
  nv.backgroundColor = [
    parseInt(hex.slice(1, 3), 16) / 255,
    parseInt(hex.slice(3, 5), 16) / 255,
    parseInt(hex.slice(5, 7), 16) / 255,
    1.0,
  ]
}

webgpuCheck.onclick = () => {
  const want = webgpuCheck.checked
  const backend = want ? 'webgpu' : 'webgl2'
  nv.reinitializeView({ backend })
    .then((ok) => {
      // reinitializeView RESOLVES false (it does not reject) when the requested
      // backend is unavailable, e.g. a webgl2-only build. Revert the checkbox so
      // it matches the actual renderer.
      if (!ok) {
        webgpuCheck.checked = !want
        fail(`Could not switch to ${backend}`)
      }
    })
    .catch((err) => {
      webgpuCheck.checked = !want
      fail(`Could not switch to ${backend}`, err)
    })
}

// Apply the initial ppm window (sliders default to 1.2-3.3 ppm) to the loaded
// graph so it opens on the metabolite band rather than the full spectrum.
syncPpm()

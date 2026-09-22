import NiiVue, { SHOW_RENDER } from '../src/index.ts'

let gMin = 0
let gMax = 1

// intensity range of the background volume, in calibrated units
function dataRange(v) {
  let lo = v.globalMin ?? v.global_min
  let hi = v.globalMax ?? v.global_max
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo === hi) {
    // fallback: sample the voxel data directly
    const img = v.img
    const slope = v.hdr?.scl_slope || 1
    const inter = v.hdr?.scl_inter || 0
    lo = Infinity
    hi = -Infinity
    const stride = Math.max(1, Math.floor(img.length / 1e6))
    for (let i = 0; i < img.length; i += stride) {
      const x = img[i] * slope + inter
      if (x < lo) lo = x
      if (x > hi) hi = x
    }
  }
  return [lo, hi]
}

function applyWindow() {
  if (nv1.volumes.length < 1) return
  const v = nv1.volumes[0]
  const lo = gMin + (calMinSlide.value / 1000) * (gMax - gMin)
  const hi = gMin + (calMaxSlide.value / 1000) * (gMax - gMin)
  v.calMin = Math.min(lo, hi)
  v.calMax = Math.max(lo, hi)
  calMinOut.value = v.calMin.toFixed(1)
  calMaxOut.value = v.calMax.toFixed(1)
  nv1.updateGLVolume()
}

// move sliders to match the volume's current window (e.g. after a load)
function syncSliders() {
  if (nv1.volumes.length < 1) return
  const v = nv1.volumes[0]
  ;[gMin, gMax] = dataRange(v)
  const span = gMax - gMin || 1
  calMinSlide.value = Math.round(((v.calMin - gMin) / span) * 1000)
  calMaxSlide.value = Math.round(((v.calMax - gMin) / span) * 1000)
  calMinOut.value = v.calMin.toFixed(1)
  calMaxOut.value = v.calMax.toFixed(1)
}

calMinSlide.oninput = applyWindow
calMaxSlide.oninput = applyWindow

clipDarkCheck.onchange = function () {
  nv1.volumeIsAlphaClipDark = this.checked
  nv1.updateGLVolume()
}

// Otsu threshold for the floor, 99.5th percentile for the ceiling
autoBtn.onclick = () => {
  if (nv1.volumes.length < 1) return
  const v = nv1.volumes[0]
  const img = v.img
  const slope = v.hdr?.scl_slope || 1
  const inter = v.hdr?.scl_inter || 0
  const BINS = 256
  const h = new Float64Array(BINS)
  const scale = (BINS - 1) / (gMax - gMin || 1)
  const stride = Math.max(1, Math.floor(img.length / 2e6))
  let n = 0
  for (let i = 0; i < img.length; i += stride) {
    const x = img[i] * slope + inter
    const b = Math.min(BINS - 1, Math.max(0, ((x - gMin) * scale) | 0))
    h[b]++
    n++
  }
  let sumAll = 0
  for (let i = 0; i < BINS; i++) sumAll += i * h[i]
  let sumB = 0
  let wB = 0
  let best = 0
  let bestVar = -1
  for (let t = 0; t < BINS; t++) {
    wB += h[t]
    if (wB === 0) continue
    const wF = n - wB
    if (wF === 0) break
    sumB += t * h[t]
    const mB = sumB / wB
    const mF = (sumAll - sumB) / wF
    const between = wB * wF * (mB - mF) * (mB - mF)
    if (between > bestVar) {
      bestVar = between
      best = t
    }
  }
  let acc = 0
  let p995 = BINS - 1
  for (let i = 0; i < BINS; i++) {
    acc += h[i]
    if (acc >= n * 0.995) {
      p995 = i
      break
    }
  }
  v.calMin = gMin + (best / (BINS - 1)) * (gMax - gMin)
  v.calMax = gMin + (p995 / (BINS - 1)) * (gMax - gMin)
  syncSliders()
  nv1.updateGLVolume()
}

resetBtn.onclick = () => {
  if (nv1.volumes.length < 1) return
  nv1.volumes[0].calMin = gMin
  nv1.volumes[0].calMax = gMax
  syncSliders()
  nv1.updateGLVolume()
}

// re-scale the sliders when a new image lands via drag & drop
document.addEventListener('drop', () => setTimeout(syncSliders, 1500))

function handleLocationChange(data) {
  document.getElementById('location').innerHTML = `&nbsp;&nbsp;${data.string}`
}

const nv1 = new NiiVue({
  isColorbarVisible: true,
  backgroundColor: [0.2, 0.2, 0.2, 1],
  showRender: SHOW_RENDER.ALWAYS,
})
nv1.addEventListener('locationChange', (e) => handleLocationChange(e.detail))
await nv1.attachToCanvas(gl1)
nv1.volumeIsAlphaClipDark = clipDarkCheck.checked
await nv1.loadVolumes([{ url: '/volumes/mni152.nii.gz' }])
syncSliders()

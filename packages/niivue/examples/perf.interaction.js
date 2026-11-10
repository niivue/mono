import NiiVue, { SLICE_TYPE } from '../src/index.ts'

const gl1 = document.getElementById('gl1')

const backendSelect = document.getElementById('backendSelect')
const clearBtn = document.getElementById('clearBtn')
const enableChk = document.getElementById('enableChk')
const sceneSelect = document.getElementById('sceneSelect')
const statusEl = document.getElementById('statusEl')

// Default to whatever the URL or selector says — falls back to WebGPU.
const initialBackend = backendSelect.value
const nv = new NiiVue({
  isColorbarVisible: false,
  backgroundColor: [0.05, 0.05, 0.05, 1],
  sliceType: SLICE_TYPE.RENDER,
  backend: initialBackend,
})
await nv.attachToCanvas(gl1)

// The 'viewAttached' event reports the backend that *actually*
// initialized (WebGPU may fall back to WebGL2 in unsupported
// browsers). Surface it in the status line so users can confirm.
let activeBackend = initialBackend
nv.addEventListener('viewAttached', (e) => {
  activeBackend = e.detail.backend
  backendSelect.value = activeBackend
  updateStatus()
})

// Each scene is a list of volume specs passed to loadVolumes.
// Overlay volumes (index >= 1) get a colormap that reads well over
// the anatomical base.
const SCENES = {
  mni152: [{ url: '/volumes/mni152.nii.gz' }],
  'mni152+spmMotor': [
    { url: '/volumes/mni152.nii.gz' },
    { url: '/volumes/spmMotor.nii.gz', colormap: 'warm', calMin: 3, calMax: 6 },
  ],
  torso: [{ url: '/volumes/torso.nii.gz' }],
  'torso+torsoLabel': [
    { url: '/volumes/torso.nii.gz' },
    { url: '/volumes/torsoLabel.nii.gz', colormap: 'hsv', opacity: 0.7 },
  ],
  visiblehuman: [{ url: '/volumes/visiblehuman.nii.gz' }],
}

let loading = false
function updateStatus() {
  const state = enableChk.checked ? 'Recording' : 'Paused'
  statusEl.textContent = `${state} — backend: ${activeBackend}`
}
async function loadScene(name) {
  const volumes = SCENES[name]
  if (!volumes) return
  loading = true
  statusEl.textContent = `Loading ${name}…`
  try {
    await nv.loadVolumes(volumes)
    // Different volumes have very different costs; start clean.
    samples.clear()
    frameTimes.length = 0
    render()
    liveEl.textContent = `Loaded ${name} — interact with the canvas to record frames.`
    updateStatus()
  } finally {
    loading = false
  }
}

// ----- aggregation -----
const samples = new Map() // tag -> { cpu: number[], total: number[] }
const liveEl = document.getElementById('live')
const tbody = document.querySelector('#agg tbody')
const fpsEl = document.getElementById('fps')

// Rolling 1s window of frame timestamps. FPS = count / (newest - oldest).
const FPS_WINDOW_MS = 1000
const FPS_IDLE_MS = 500 // show '—' if no frames in this long
const frameTimes = []
function recordFrameTime(t) {
  frameTimes.push(t)
  const cutoff = t - FPS_WINDOW_MS
  while (frameTimes.length > 0 && frameTimes[0] < cutoff) {
    frameTimes.shift()
  }
}
function currentFps(now) {
  if (frameTimes.length < 2) return null
  if (now - frameTimes[frameTimes.length - 1] > FPS_IDLE_MS) return null
  const span = frameTimes[frameTimes.length - 1] - frameTimes[0]
  if (span <= 0) return null
  return ((frameTimes.length - 1) * 1000) / span
}
function paintFps() {
  const now = performance.now()
  const fps = currentFps(now)
  fpsEl.firstChild.nodeValue = fps == null ? '— fps ' : `${fps.toFixed(1)} fps `
}
// Drive a paint loop so the readout decays to '—' when the user
// stops interacting — perfFrame events alone wouldn't fire.
;(function tick() {
  paintFps()
  requestAnimationFrame(tick)
})()

function quantile(xs, q) {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const idx = Math.min(s.length - 1, Math.floor(q * (s.length - 1)))
  return s[idx]
}
const fmt = (n) => (n == null ? '—' : `${n.toFixed(2)} ms`)

function record(report) {
  const tag = report.tag ?? '(untagged)'
  let bucket = samples.get(tag)
  if (!bucket) {
    bucket = { cpu: [], total: [] }
    samples.set(tag, bucket)
  }
  // Cap per-tag history so an idle tab doesn't grow unbounded.
  if (bucket.cpu.length >= 500) {
    bucket.cpu.shift()
    bucket.total.shift()
  }
  bucket.cpu.push(report.cpuMs)
  bucket.total.push(report.totalMs)
}

function render() {
  const rows = []
  for (const [tag, bucket] of samples) {
    rows.push({
      tag,
      n: bucket.cpu.length,
      cpu50: quantile(bucket.cpu, 0.5),
      cpu95: quantile(bucket.cpu, 0.95),
      total50: quantile(bucket.total, 0.5),
      total95: quantile(bucket.total, 0.95),
    })
  }
  rows.sort((a, b) => b.n - a.n)
  tbody.innerHTML = rows
    .map(
      (r) =>
        `<tr><td>${r.tag}</td><td>${r.n}</td>` +
        `<td>${fmt(r.cpu50)}</td><td>${fmt(r.cpu95)}</td>` +
        `<td>${fmt(r.total50)}</td><td>${fmt(r.total95)}</td></tr>`,
    )
    .join('')
}

let renderPending = false
function scheduleRender() {
  if (renderPending) return
  renderPending = true
  // Throttle table updates so we don't repaint on every frame.
  setTimeout(() => {
    renderPending = false
    render()
  }, 100)
}

// ----- live + aggregate hookup -----
nv.addEventListener('perfFrame', (e) => {
  const r = e.detail
  record(r)
  recordFrameTime(performance.now())
  scheduleRender()
  const tag = r.tag ?? '(untagged)'
  liveEl.textContent =
    `${tag.padEnd(14)}  cpu ${fmt(r.cpuMs)}  ` +
    `submit ${fmt(r.submitMs)}  total ${fmt(r.totalMs)}`
})

// ----- controls -----
enableChk.addEventListener('change', () => {
  nv.perf.enabled = enableChk.checked
  updateStatus()
})
clearBtn.addEventListener('click', () => {
  samples.clear()
  frameTimes.length = 0
  render()
  liveEl.textContent =
    'Cleared. Move the mouse, drag, or scroll over the canvas to record frames.'
})
sceneSelect.addEventListener('change', () => {
  if (loading) return
  loadScene(sceneSelect.value)
})
backendSelect.addEventListener('change', async () => {
  if (loading) return
  const requested = backendSelect.value
  if (requested === activeBackend) return
  loading = true
  statusEl.textContent = `Switching to ${requested}…`
  try {
    await nv.reinitializeView({ backend: requested })
    // GPU backends have very different per-frame costs — keep
    // samples segregated so cross-backend means aren't muddled.
    samples.clear()
    frameTimes.length = 0
    render()
    liveEl.textContent = `Switched backend — interact with the canvas to record frames.`
  } finally {
    loading = false
    updateStatus()
  }
})

// Initial load — kicks off after all helpers are bound.
await loadScene(sceneSelect.value)

// @ts-check

import { runDcm2niix } from '@niivue/nv-ext-dcm2niix'
import NiiVue, { SHOW_RENDER } from '../src/index.ts'

// Diagnostic: show script is running
console.log('Window/Level demo script loaded')
console.log('Available packages:', typeof NiiVue, typeof runDcm2niix)

let gMin = 0
let gMax = 1
let windowUpdateTimer = null
let windowUpdateInFlight = false
let pendingWindow = null
let benchmark = null
let windowUpdateStats = {
  startedAt: performance.now(),
  count: 0,
  cpuUpdateTotalMs: 0,
  rendererCpuTotalMs: 0,
  gpuSubmitTotalMs: 0,
  gpuWaitTotalMs: 0,
  endToEndTotalMs: 0,
  maxEndToEndMs: 0,
}
const pendingWindowCpuMeasurements = []

// Wait until the GPU has completed the frame associated with a perf report.
// This is intentionally used only by the diagnostic logger: forcing a GPU
// wait removes CPU/GPU overlap and should not be enabled in a normal viewer.
async function waitForGpuCompletion() {
  const view = nv1.view
  const startedAt = performance.now()

  if (nv1.backend === 'webgpu' && view?.device) {
    await view.device.queue.onSubmittedWorkDone()
  } else if (nv1.backend === 'webgl2' && view?.gl) {
    view.gl.finish()
  }

  return performance.now() - startedAt
}

function dataRange(v) {
  let lo = v.globalMin ?? v.global_min
  let hi = v.globalMax ?? v.global_max
  if (!Number.isFinite(lo) || !Number.isFinite(hi) || lo === hi) {
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

function initSliders(v) {
  ;[gMin, gMax] = dataRange(v)
  const span = gMax - gMin || 1

  // Set slider ranges with padding
  const padding = span * 0.5
  levelSlider.min = Math.floor(gMin - padding)
  levelSlider.max = Math.ceil(gMax + padding)

  const currentLevel = (v.calMin + v.calMax) / 2
  const currentWidth = v.calMax - v.calMin

  levelSlider.value = Math.round(currentLevel)
  widthSlider.min = 1
  widthSlider.max = Math.ceil(span * 2)
  widthSlider.value = Math.round(currentWidth)

  updateSliderValues()

  levelSlider.disabled = false
  widthSlider.disabled = false
  resetBtn.disabled = false
  benchmarkBtn.disabled = false
}

function updateSliderValues() {
  levelValue.textContent = Math.round(parseFloat(levelSlider.value))
  widthValue.textContent = Math.round(parseFloat(widthSlider.value))
}

function applyWindow() {
  if (nv1.volumes.length < 1) return
  const level = parseFloat(levelSlider.value)
  const width = parseFloat(widthSlider.value)
  pendingWindow = {
    calMin: level - width / 2,
    calMax: level + width / 2,
  }

  // The benchmark must measure the requested input cadence, not the manual
  // drag debounce. The normal 8 ms debounce is useful for pointer events, but
  // combined with a 160 Hz test cadence it produces an artificial ~80 Hz
  // completion rate by coalescing every other update.
  if (benchmark) {
    if (!windowUpdateInFlight) void flushWindowUpdate()
    return
  }

  scheduleWindowUpdate()
}

// Generate deterministic window updates for a fair comparison with version 03.
function startBenchmark() {
  if (benchmark || nv1.volumes.length < 1) return
  const hz = Number(benchmarkRate.value)
  benchmark = {
    hz,
    nextDeadline: 0,
    startedAt: performance.now(),
    timer: null,
    level: levelSlider.value,
    width: widthSlider.value,
  }
  benchmarkRate.disabled = true
  benchmarkBtn.textContent = 'Stop Test'
  windowUpdateStats = {
    startedAt: performance.now(),
    count: 0,
    cpuUpdateTotalMs: 0,
    rendererCpuTotalMs: 0,
    gpuSubmitTotalMs: 0,
    gpuWaitTotalMs: 0,
    endToEndTotalMs: 0,
    maxEndToEndMs: 0,
  }

  const tick = () => {
    if (!benchmark) return
    const elapsed = performance.now() - benchmark.startedAt
    if (elapsed >= 10000) {
      stopBenchmark()
      return
    }
    if (elapsed < benchmark.nextDeadline) {
      benchmark.timer = window.setTimeout(
        tick,
        Math.max(1, Math.ceil(benchmark.nextDeadline - elapsed)),
      )
      return
    }

    const span = gMax - gMin || 1
    const phase = (elapsed / 1000) * Math.PI
    levelSlider.value = String((gMin + gMax) / 2 + Math.sin(phase) * span * 0.3)
    widthSlider.value = String(
      Math.max(1, span * (0.7 + 0.25 * Math.cos(phase))),
    )
    updateSliderValues()
    applyWindow()

    const nowElapsed = performance.now() - benchmark.startedAt
    const period = 1000 / hz
    benchmark.nextDeadline = (Math.floor(nowElapsed / period) + 1) * period
    benchmark.timer = window.setTimeout(
      tick,
      Math.max(1, Math.ceil(benchmark.nextDeadline - nowElapsed)),
    )
  }
  tick()
}

function stopBenchmark() {
  if (!benchmark) return
  window.clearTimeout(benchmark.timer)
  levelSlider.value = benchmark.level
  widthSlider.value = benchmark.width
  benchmark = null
  benchmarkRate.disabled = false
  benchmarkBtn.textContent = 'Run 10-Second Automated Test'
  updateSliderValues()
  applyWindow()
}

function scheduleWindowUpdate() {
  if (windowUpdateTimer !== null || windowUpdateInFlight) return
  windowUpdateTimer = window.setTimeout(() => {
    windowUpdateTimer = null
    flushWindowUpdate()
  }, 8)
}

async function flushWindowUpdate() {
  if (pendingWindow === null || nv1.volumes.length < 1) return
  const nextWindow = pendingWindow
  pendingWindow = null
  windowUpdateInFlight = true
  const startedAt = performance.now()
  try {
    nv1.perf.tagFrame('window-level')
    await nv1.setVolume(0, nextWindow)
  } finally {
    const elapsedMs = performance.now() - startedAt
    pendingWindowCpuMeasurements.push(elapsedMs)
    windowUpdateInFlight = false
    if (pendingWindow !== null) {
      if (benchmark) void flushWindowUpdate()
      else scheduleWindowUpdate()
    }
  }
}

function handleLocationChange(data) {
  document.getElementById('location').innerHTML = `&nbsp;&nbsp;${data.string}`
}

function setLoading(loading, text = 'Loading...') {
  loadingEl.style.display = loading ? 'flex' : 'none'
  loadingTextEl.textContent = text
}

// UI elements
const dicomInput = document.getElementById('dicomInput')
const levelSlider = document.getElementById('levelSlider')
const widthSlider = document.getElementById('widthSlider')
const levelValue = document.getElementById('levelValue')
const widthValue = document.getElementById('widthValue')
const resetBtn = document.getElementById('resetBtn')
const benchmarkRate = document.getElementById('benchmarkRate')
const benchmarkBtn = document.getElementById('benchmarkBtn')
const statusEl = document.getElementById('status')
const loadingEl = document.getElementById('loading')
const loadingTextEl = document.getElementById('loadingText')
const canvasContainer = document.getElementById('canvas-container')

// Diagnostic: check all UI elements
console.log('UI elements check:', {
  dicomInput: !!dicomInput,
  levelSlider: !!levelSlider,
  widthSlider: !!widthSlider,
  canvasContainer: !!canvasContainer,
  statusEl: !!statusEl,
})

// Initialize NiiVue
// /** @type {import('../src/NVControl.ts').default} */
const nv1 = new NiiVue({
  backend: 'webgl2',
  isColorbarVisible: true,
  backgroundColor: [0.1, 0.1, 0.1, 1],
  // Temporarily disable the 3D render tile in the multiplanar layout.
  // showRender: SHOW_RENDER.ALWAYS,
  showRender: SHOW_RENDER.NEVER,
})

// Report the tagged render frame that follows each window update.
nv1.perf.enabled = true
nv1.addEventListener('perfFrame', (e) => {
  const report = e.detail
  if (report.tag !== 'window-level') return
  const setVolumeCpuMs = pendingWindowCpuMeasurements.shift() ?? 0

  void (async () => {
    const gpuExecutionAndWaitMs = await waitForGpuCompletion()
    const rendererCpuMs = report.cpuMs
    const gpuSubmitJsMs = report.submitMs
    const endToEndCpuPlusGpuMs =
      setVolumeCpuMs + report.totalMs + gpuExecutionAndWaitMs
    windowUpdateStats.count += 1
    windowUpdateStats.cpuUpdateTotalMs += setVolumeCpuMs
    windowUpdateStats.rendererCpuTotalMs += rendererCpuMs
    windowUpdateStats.gpuSubmitTotalMs += gpuSubmitJsMs
    windowUpdateStats.gpuWaitTotalMs += gpuExecutionAndWaitMs
    windowUpdateStats.endToEndTotalMs += endToEndCpuPlusGpuMs
    windowUpdateStats.maxEndToEndMs = Math.max(
      windowUpdateStats.maxEndToEndMs,
      endToEndCpuPlusGpuMs,
    )

    const statsElapsedMs = performance.now() - windowUpdateStats.startedAt
    if (statsElapsedMs < 1000 || windowUpdateStats.count === 0) return

    const count = windowUpdateStats.count
    console.log('Window update performance (1s):', {
      updatesPerSecond: Math.round((count * 1000) / statsElapsedMs),
      averageCpuUpdateMs: Number(
        (windowUpdateStats.cpuUpdateTotalMs / count).toFixed(2),
      ),
      averageRendererCpuMs: Number(
        (windowUpdateStats.rendererCpuTotalMs / count).toFixed(2),
      ),
      averageGpuSubmitJsMs: Number(
        (windowUpdateStats.gpuSubmitTotalMs / count).toFixed(2),
      ),
      averageGpuExecutionAndCompletionWaitMs: Number(
        (windowUpdateStats.gpuWaitTotalMs / count).toFixed(2),
      ),
      averageEndToEndCpuPlusGpuMs: Number(
        (windowUpdateStats.endToEndTotalMs / count).toFixed(2),
      ),
      maxEndToEndCpuPlusGpuMs: Number(
        windowUpdateStats.maxEndToEndMs.toFixed(2),
      ),
      backend: nv1.backend,
    })
    windowUpdateStats = {
      startedAt: performance.now(),
      count: 0,
      cpuUpdateTotalMs: 0,
      rendererCpuTotalMs: 0,
      gpuSubmitTotalMs: 0,
      gpuWaitTotalMs: 0,
      endToEndTotalMs: 0,
      maxEndToEndMs: 0,
    }
  })()
})

nv1.addEventListener('locationChange', (e) => handleLocationChange(e.detail))

// Listen for volume loaded events for better status updates
nv1.addEventListener('volumeLoaded', (e) => {
  console.log('Volume loaded event:', e.detail)
  const volume = e.detail.volume
  statusEl.textContent = `Loaded: ${volume.name}`
  initSliders(volume)
  setLoading(false)
})

nv1.addEventListener('volumeLoadedFailed', (e) => {
  console.error('Volume loading failed:', e.detail)
  statusEl.textContent = `Failed: ${e.detail.message}`
  setLoading(false)
  alert(`Failed to load volume: ${e.detail.message}`)
})

const canvasEl = document.getElementById('gl')
if (!canvasEl) {
  console.error('Canvas element not found')
  statusEl.textContent = 'Error: Canvas not found'
} else {
  try {
    await nv1.attachToCanvas(canvasEl)
    console.log('Actual rendering backend:', nv1.backend)
    const webgpuAdapter = await navigator.gpu?.requestAdapter()
    console.log('WebGPU adapter available:', !!webgpuAdapter)
    // Enable DICOM input after attach succeeds
    dicomInput.disabled = false
    statusEl.textContent = 'Ready - Select DICOM folder'
  } catch (err) {
    console.error('Failed to attach to canvas:', err)
    statusEl.textContent = 'Error: Failed to initialize viewer'
  }
}

// Load DICOM files
dicomInput.addEventListener('change', async () => {
  const files = Array.from(dicomInput.files)
  if (files.length === 0) {
    console.warn('No files selected')
    return
  }

  console.log(`Selected ${files.length} DICOM files`)

  try {
    setLoading(true, 'Converting DICOM to NIfTI...')
    statusEl.textContent = 'Converting DICOM...'

    console.time('dcm2niix')
    // Convert DICOM to NIfTI
    const niftiFiles = await runDcm2niix(files)
    console.timeEnd('dcm2niix')
    console.log(
      'Generated NIfTI files:',
      niftiFiles.map((f) => f.name),
    )

    if (niftiFiles.length === 0) {
      throw new Error('No NIfTI files generated from DICOM')
    }

    setLoading(true, 'Loading volume...')
    statusEl.textContent = 'Loading volume...'

    // Load into NiiVue
    console.time('loadVolumes')
    const loadResult = await nv1.loadVolumes([{ url: niftiFiles[0] }])
    console.timeEnd('loadVolumes')
    console.log('Load volumes result:', loadResult)

    // Note: The canvas size warning you see is normal - NiiVue adapts canvas to image dimensions
    // You should be able to see the rendered volume now
  } catch (err) {
    console.error('DICOM loading error:', err)
    setLoading(false)
    statusEl.textContent = `Error: ${err.message}`
    alert(`Failed to load DICOM: ${err.message}`)
  }
})

// Slider events
levelSlider.addEventListener('input', () => {
  const value = levelSlider.value
  stopBenchmark()
  levelSlider.value = value
  updateSliderValues()
  applyWindow()
})

widthSlider.addEventListener('input', () => {
  const value = widthSlider.value
  stopBenchmark()
  widthSlider.value = value
  updateSliderValues()
  applyWindow()
})

// Reset to full range
resetBtn.addEventListener('click', () => {
  if (nv1.volumes.length < 1) return
  stopBenchmark()
  pendingWindow = null
  if (windowUpdateTimer !== null) {
    clearTimeout(windowUpdateTimer)
    windowUpdateTimer = null
  }
  nv1.setVolume(0, { calMin: gMin, calMax: gMax })

  // Update sliders
  levelSlider.value = Math.round((gMin + gMax) / 2)
  widthSlider.value = Math.round(gMax - gMin)
  updateSliderValues()
})

benchmarkBtn.addEventListener('click', () => {
  if (benchmark) stopBenchmark()
  else startBenchmark()
})

document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopBenchmark()
})

// Drag and drop support (fallback)
canvasContainer.addEventListener('dragover', (e) => {
  e.preventDefault()
  canvasContainer.style.borderColor = '#4caf50'
})

canvasContainer.addEventListener('dragleave', (e) => {
  e.preventDefault()
  canvasContainer.style.borderColor = ''
})

canvasContainer.addEventListener('drop', async (e) => {
  e.preventDefault()
  canvasContainer.style.borderColor = ''

  const files = []
  if (e.dataTransfer?.items) {
    try {
      const { traverseDataTransferItems } = await import(
        '@niivue/nv-ext-dcm2niix'
      )
      const droppedFiles = await traverseDataTransferItems(e.dataTransfer.items)
      files.push(...droppedFiles)
    } catch {
      if (e.dataTransfer?.files) {
        files.push(...Array.from(e.dataTransfer.files))
      }
    }
  }

  if (files.length === 0) {
    console.warn('No files dropped')
    statusEl.textContent = 'No files dropped'
    return
  }

  console.log(`Dropped ${files.length} files`)
  // Reuse the same logic
  dicomInput.files = files.length > 0 ? createFileList(files) : dicomInput.files
  dicomInput.dispatchEvent(new Event('change'))
})

// Helper to create a FileList-like object
function createFileList(files) {
  const dataTransfer = new DataTransfer()
  files.forEach((file) => {
    dataTransfer.items.add(file)
  })
  return dataTransfer.files
}

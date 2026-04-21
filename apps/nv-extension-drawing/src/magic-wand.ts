/**
 * Example: Magic Wand (click-to-segment) using @niivue/nv-drawing
 * and the NiiVue extension context.
 *
 * Default backend is SharedArrayBuffer (zero-copy). Check "Transfer"
 * to fall back to the transfer-based Web Worker.
 *
 * All coordinate picking is handled by the extension context's
 * slicePointerMove / slicePointerUp events — no manual hit-testing.
 */
import type { NVExtensionEventMap } from '@niivue/niivue'
import NiiVue from '@niivue/niivue'
import {
  type Connectivity,
  type MagicWandResult,
  MagicWandShared,
  magicWand as magicWandWorker,
  type ThresholdMode,
} from '@niivue/nv-drawing'

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id)
  if (!el) throw new Error(`Element #${id} not found`)
  return el as T
}

// --- UI refs ---
const status = $('status')
const sliceTypeSelect = $<HTMLSelectElement>('sliceType')
const useWebGPUCb = $<HTMLInputElement>('useWebGPU')
const modeSelect = $<HTMLSelectElement>('modeSelect')
const penColorSelect = $<HTMLSelectElement>('penColor')
const undoBtn = $<HTMLButtonElement>('undoBtn')
const clearBtn = $<HTMLButtonElement>('clearBtn')
const toleranceSlider = $<HTMLInputElement>('toleranceSlider')
const toleranceVal = $('toleranceVal')
const toleranceGroup = $('toleranceGroup')
const percentSlider = $<HTMLInputElement>('percentSlider')
const percentVal = $('percentVal')
const percentGroup = $('percentGroup')
const thresholdModeSelect = $<HTMLSelectElement>('thresholdModeSelect')
const maxDistInput = $<HTMLInputElement>('maxDistInput')
const is2DCb = $<HTMLInputElement>('is2DCb')
const connectivitySelect = $<HTMLSelectElement>('connectivitySelect')
const useTransferCb = $<HTMLInputElement>('useTransferCb')
const wandParams = $('wandParams')

toleranceSlider.oninput = () => {
  toleranceVal.textContent = toleranceSlider.value
}
percentSlider.oninput = () => {
  percentVal.textContent = (Number(percentSlider.value) / 100).toFixed(2)
}
thresholdModeSelect.onchange = () => {
  const mode = thresholdModeSelect.value
  const usesTol = mode === 'symmetric' || mode === 'bright' || mode === 'dark'
  const usesPct = mode === 'percent' || mode === 'auto'
  toleranceGroup.style.display = usesTol ? '' : 'none'
  percentGroup.style.display = usesPct ? '' : 'none'
}

modeSelect.onchange = () => {
  const isWand = modeSelect.value === 'wand'
  wandParams.style.display = isWand ? 'flex' : 'none'
  nv.drawIsEnabled = !isWand
  if (isWand) {
    snapshotCommitted()
    initSharedIfNeeded()
  }
  status.textContent = isWand
    ? 'Magic Wand mode \u2014 hover to preview, click to apply.'
    : 'Draw mode \u2014 draw on slices with the pen.'
}

// --- Initialize NiiVue + extension context ---
const nv = new NiiVue()
const ctx = nv.createExtensionContext()

ctx.on('locationChange', (e) => {
  $('location').innerHTML = `&nbsp;&nbsp;${e.detail.string}`
})

await nv.attachToCanvas($<HTMLCanvasElement>('gl1'))
await nv.loadVolumes([{ url: '/volumes/mni152.nii.gz' }])

// Detect actual backend and sync checkbox
useWebGPUCb.checked = nv.backend === 'webgpu'

// --- WebGPU / WebGL2 toggle ---
useWebGPUCb.onchange = async () => {
  const backend = useWebGPUCb.checked ? 'webgpu' : 'webgl2'
  status.textContent = `Switching to ${backend}\u2026`
  const ok = await nv.reinitializeView({ backend })
  useWebGPUCb.checked = nv.backend === 'webgpu'
  status.textContent = ok
    ? `Backend: ${nv.backend}`
    : `Failed to switch to ${backend}`
}

ctx.createEmptyDrawing()
nv.drawIsEnabled = false

// --- Drawing controls ---
penColorSelect.onchange = () => {
  nv.drawPenValue = parseInt(penColorSelect.value, 10)
}

undoBtn.onclick = () => {
  ctx.drawUndo()
  snapshotCommitted()
  if (wandShared && committedBitmap) wandShared.updateCommitted(committedBitmap)
  clearPreview()
}

clearBtn.onclick = () => {
  ctx.closeDrawing()
  ctx.createEmptyDrawing()
  if (modeSelect.value === 'wand') nv.drawIsEnabled = false
  if (wandShared) {
    wandShared.dispose()
    wandShared = null
    sharedReady = false
  }
  snapshotCommitted()
  previewActive = false
  status.textContent = 'Drawing cleared.'
}

sliceTypeSelect.onchange = () => {
  nv.sliceType = parseInt(sliceTypeSelect.value, 10)
}

// ---------------------------------------------------------------------------
// Preview state
// ---------------------------------------------------------------------------

let committedBitmap: Uint8Array | null = null
let previewActive = false
let previewGen = 0

function snapshotCommitted() {
  const dr = ctx.drawing
  if (dr?.bitmap) committedBitmap = dr.bitmap.slice()
}
snapshotCommitted()

// ---------------------------------------------------------------------------
// SharedArrayBuffer — default backend (initialized eagerly on wand mode)
// ---------------------------------------------------------------------------

let wandShared: MagicWandShared | null = null
let sharedReady = false

async function initSharedIfNeeded() {
  if (wandShared) return
  if (typeof SharedArrayBuffer === 'undefined') {
    status.textContent =
      'SharedArrayBuffer not available — using transfer worker.'
    useTransferCb.checked = true
    return
  }
  const dr = ctx.drawing
  const bg = ctx.backgroundVolume
  if (!dr || !bg?.imgRAS) return
  status.textContent = 'Initializing SharedArrayBuffer worker\u2026'

  const committed =
    committedBitmap ||
    new Uint8Array(dr.dims.dimX * dr.dims.dimY * dr.dims.dimZ)

  wandShared = new MagicWandShared(
    dr.dims,
    bg.imgRAS,
    committed,
    dr.voxelSizeMM,
  )

  // Point niivue's drawing volume at the wand's shared bitmap
  // for zero-copy rendering (the wand worker writes here directly).
  const drawVol = nv.drawingVolume
  if (drawVol) drawVol.img = wandShared.bitmap
  if (committedBitmap) wandShared.bitmap.set(committedBitmap)

  await wandShared.ready
  sharedReady = true
  status.textContent = 'Ready \u2014 hover to preview, click to apply.'
}

// Initialize shared worker immediately (wand mode is the default)
initSharedIfNeeded()

// --- Helpers ---

function buildWandOptions(sliceAxis: number) {
  const bg = ctx.backgroundVolume
  if (!bg) return null
  return {
    tolerance: parseFloat(toleranceSlider.value),
    thresholdMode: thresholdModeSelect.value as ThresholdMode,
    percent: parseFloat(percentSlider.value) / 100,
    calMin: bg.calMin ?? bg.robustMin ?? 0,
    calMax: bg.calMax ?? bg.robustMax ?? 1,
    connectivity: parseInt(connectivitySelect.value, 10) as Connectivity,
    maxDistanceMM: maxDistInput.value.trim()
      ? parseFloat(maxDistInput.value)
      : Number.POSITIVE_INFINITY,
    is2D: is2DCb.checked,
    sliceAxis,
    penValue: parseInt(penColorSelect.value, 10),
  }
}

function clearPreview() {
  if (!previewActive) return
  previewActive = false
  const dr = ctx.drawing
  if (dr?.bitmap && committedBitmap) {
    dr.update(committedBitmap)
  }
}

function formatStatus(
  prefix: string,
  result: MagicWandResult,
  seed: number[],
  elapsed: string,
  backend: string,
): string {
  const brightStr =
    result.isBright !== undefined
      ? ` (${result.isBright ? 'bright' : 'dark'})`
      : ''
  const suffix = prefix === 'Preview' ? ' \u2014 click to apply' : ''
  return (
    `${prefix}: ${result.filledCount} voxels at [${seed}], ` +
    `intensity=${result.seedIntensity.toFixed(1)}, ` +
    `range=[${result.intensityMin.toFixed(1)}, ${result.intensityMax.toFixed(1)}]${brightStr} ` +
    `(${elapsed} ms, ${backend})${suffix}`
  )
}

// ---------------------------------------------------------------------------
// Preview on slicePointerMove
// ---------------------------------------------------------------------------

// --- SharedArrayBuffer (zero-copy, default) ---

async function runPreviewShared(
  seed: [number, number, number],
  sliceType: number,
) {
  if (!wandShared) return
  const opts = buildWandOptions(sliceType)
  if (!opts) return
  const t0 = performance.now()
  const result = await wandShared.preview(seed, opts)
  const elapsed = (performance.now() - t0).toFixed(1)
  if (!result) return // superseded
  previewActive = true
  ctx.refreshDrawing()
  status.textContent = formatStatus('Preview', result, seed, elapsed, 'shared')
}

// --- Transfer-based worker (fallback) ---

async function runPreviewWorker(
  seed: [number, number, number],
  sliceType: number,
) {
  const dr = ctx.drawing
  const bg = ctx.backgroundVolume
  if (!dr || !bg?.imgRAS) return
  const opts = buildWandOptions(sliceType)
  if (!opts) return
  const gen = ++previewGen
  const bitmapToSend = committedBitmap
    ? new Uint8Array(committedBitmap)
    : new Uint8Array(dr.bitmap.length)
  const t0 = performance.now()
  const { bitmap, result } = await magicWandWorker(
    seed,
    bitmapToSend,
    dr.dims,
    bg.imgRAS,
    opts,
    dr.voxelSizeMM,
  )
  const elapsed = (performance.now() - t0).toFixed(1)
  if (gen !== previewGen) return
  dr.update(bitmap)
  previewActive = true
  status.textContent = formatStatus('Preview', result, seed, elapsed, 'worker')
}

// ---------------------------------------------------------------------------
// Pointer event bindings
// ---------------------------------------------------------------------------

type SlicePointerDetail = NVExtensionEventMap['slicePointerMove']

ctx.on('slicePointerMove', (e: CustomEvent<SlicePointerDetail>) => {
  if (modeSelect.value !== 'wand') return
  if (e.detail.pointerEvent.buttons !== 0) return

  const seed = e.detail.voxel as [number, number, number]
  const sliceType = e.detail.sliceType

  if (!useTransferCb.checked && sharedReady) {
    runPreviewShared(seed, sliceType)
  } else {
    runPreviewWorker(seed, sliceType)
  }
})

ctx.on('slicePointerUp', (e: CustomEvent<SlicePointerDetail>) => {
  if (modeSelect.value !== 'wand') return
  if (e.detail.pointerEvent.button !== 0) return

  const seed = e.detail.voxel as [number, number, number]
  const sliceType = e.detail.sliceType
  const dr = ctx.drawing
  const bg = ctx.backgroundVolume

  if (previewActive) {
    // Preview is already rendered — just commit it
    if (dr?.bitmap) {
      committedBitmap = dr.bitmap.slice()
      previewActive = false
      if (wandShared) wandShared.updateCommitted(committedBitmap)
      status.textContent = status.textContent
        .replace('Preview:', 'Applied:')
        .replace(/ \u2014 click to apply/, '')
    }
    return
  }

  // Fallback: no preview active (fast click) — run via worker
  if (!dr || !bg?.imgRAS) return
  const opts = buildWandOptions(sliceType)
  if (!opts) return
  const bitmapToSend = committedBitmap
    ? new Uint8Array(committedBitmap)
    : new Uint8Array(dr.bitmap.length)
  const t0 = performance.now()
  magicWandWorker(
    seed,
    bitmapToSend,
    dr.dims,
    bg.imgRAS,
    opts,
    dr.voxelSizeMM,
  ).then(({ bitmap, result }) => {
    dr.update(bitmap)
    snapshotCommitted()
    if (wandShared && committedBitmap)
      wandShared.updateCommitted(committedBitmap)
    const elapsed = (performance.now() - t0).toFixed(1)
    status.textContent = formatStatus(
      'Applied',
      result,
      seed,
      elapsed,
      'worker',
    )
  })
})

ctx.on('slicePointerLeave', () => clearPreview())

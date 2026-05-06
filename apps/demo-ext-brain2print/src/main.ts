/**
 * NiiVue + brain2print WebGPU segmentation demo.
 *
 * Loads a 256³ T1, conforms it via `nv-ext-image-processing`, then runs a
 * tinygrad-generated WGSL pipeline (`tissue_fast` or `subcortical`) to
 * produce a label-coloured overlay. Pure browser — no backend.
 */

import NiiVueGPU, {
  type ImageFromUrlOptions,
  MULTIPLANAR_TYPE,
  SHOW_RENDER,
  SLICE_TYPE,
} from '@niivue/niivue'
import {
  BRAIN_MODELS,
  type BrainInferer,
  type BrainModelName,
  buildSegmentationVolume,
  COLORMAP_TISSUE_SUBCORTICAL,
  getBrainGPUDevice,
  prepareInput,
} from '@niivue/nv-ext-brain2print'
import { conform } from '@niivue/nv-ext-image-processing'

const WEIGHT_URLS: Record<BrainModelName, string> = {
  tissue_fast: 'net_tissue_fast.safetensors',
  subcortical: 'net_subcortical.safetensors',
}

const T1_URL = '/volumes/t1_crop.nii.gz'

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id)
  if (!el) throw new Error(`Element #${id} not found`)
  return el as T
}

const status = $('status')
const health = $('health')
const spinner = $('spinner')
const modelSelect = $<HTMLSelectElement>('modelSelect')
const bgOpacity = $<HTMLInputElement>('bgOpacity')
const ovOpacity = $<HTMLInputElement>('ovOpacity')
const segmentBtn = $<HTMLButtonElement>('segmentBtn')
const saveBtn = $<HTMLButtonElement>('saveBtn')

const nv = new NiiVueGPU({
  isDragDropEnabled: false,
  backgroundColor: [0.1, 0.1, 0.12, 1],
})
await nv.attachTo('gl1')
nv.multiplanarType = MULTIPLANAR_TYPE.GRID
nv.sliceType = SLICE_TYPE.MULTIPLANAR
nv.showRender = SHOW_RENDER.ALWAYS
nv.crosshairGap = 5
nv.isLegendVisible = false

const ctx = nv.createExtensionContext()
ctx.on('locationChange', (e) => {
  status.textContent = e.detail.string
})
// One-time registration: prepareInput dispatches the 'conform' transform
// through ctx.applyVolumeTransform, so the controller needs to know about it.
ctx.registerVolumeTransform(conform)

let device: GPUDevice | null = null
// Set by `loadAndPrepare`. Holds the conformed input ready to feed the model
// so a re-segment (model switch, repeat click) doesn't repeat the conform.
let cachedImg32: Float32Array | null = null
let activeInferer: { modelName: BrainModelName; inferer: BrainInferer } | null =
  null
let isCleanedUp = false

const listeners = new AbortController()

function canSegment(): boolean {
  return Boolean(device && cachedImg32 && !isCleanedUp)
}

function updateSegmentButton(): void {
  segmentBtn.disabled = !canSegment()
}

async function disposeActiveInferer(): Promise<void> {
  if (!activeInferer) return
  const toDispose = activeInferer
  activeInferer = null
  await toDispose.inferer.dispose()
}

async function getInferer(modelName: BrainModelName): Promise<BrainInferer> {
  if (activeInferer?.modelName === modelName) return activeInferer.inferer

  await disposeActiveInferer()
  const model = BRAIN_MODELS[modelName]
  status.textContent = `Loading ${model.label} weights + compiling pipeline…`
  if (!device) throw new Error('WebGPU device is not available')
  const inferer = await model.load(device, WEIGHT_URLS[modelName])
  if (isCleanedUp) {
    await inferer.dispose()
    throw new Error('brain2print demo was cleaned up')
  }
  activeInferer = { modelName, inferer }
  return inferer
}

// Serialize volume mutations so load, drop, and segmentation operations do not
// overlap. The catch keeps one failed task from poisoning later tasks.
let pending: Promise<unknown> = Promise.resolve()

function enqueue(fn: () => Promise<unknown>): void {
  pending = pending.then(fn).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err)
    status.textContent = `Failed: ${msg}`
    console.error('brain2print task failed', err)
  })
}

/**
 * Load a NIfTI source as the background, conform it once, and cache the
 * normalized model-ready buffer. After this returns, `nv.volumes[0]` is
 * always 256³ FreeSurfer-canonical and `cachedImg32` holds the inference
 * input — `runSegmentation` does no further volume mutation other than
 * appending the segmentation overlay.
 */
async function loadAndPrepare(source: ImageFromUrlOptions): Promise<void> {
  cachedImg32 = null
  saveBtn.disabled = true
  updateSegmentButton()
  await nv.loadVolumes([source])
  if (isCleanedUp) return
  const { conformed, img32 } = await prepareInput(ctx, nv.volumes[0])
  if (isCleanedUp) return
  if (conformed !== nv.volumes[0]) {
    // Replace the displayed (non-conformed) volume with its conformed copy
    // so the overlay we'll add later aligns with what the user sees. The
    // serial queue prevents anything else from observing the empty-volumes
    // window between these two awaits.
    await nv.removeVolume(0)
    await ctx.addVolume(conformed)
  }
  cachedImg32 = img32
  updateSegmentButton()
}

async function runSegmentation(): Promise<void> {
  if (!device || !cachedImg32 || isCleanedUp) {
    updateSegmentButton()
    return
  }
  segmentBtn.disabled = true
  spinner.classList.remove('hidden')
  const modelName = modelSelect.value as BrainModelName
  const model = BRAIN_MODELS[modelName]
  const t0 = performance.now()

  try {
    // Drop any previous overlay; volumes[0] (the conformed input) stays.
    while (nv.volumes.length > 1) await nv.removeVolume(1)

    const inferer = await getInferer(modelName)
    if (isCleanedUp) return

    status.textContent = `Running ${model.label}…`
    const [labels] = await inferer(cachedImg32)
    if (isCleanedUp) return

    const seg = buildSegmentationVolume(
      nv.volumes[0],
      labels,
      COLORMAP_TISSUE_SUBCORTICAL,
    )
    seg.opacity = Number(ovOpacity.value) / 100
    await ctx.addVolume(seg)

    saveBtn.disabled = false
    const ms = Math.round(performance.now() - t0)
    status.textContent = `${model.label}: segmented in ${ms} ms`
  } finally {
    updateSegmentButton()
    spinner.classList.add('hidden')
  }
}

async function init(): Promise<void> {
  status.textContent = 'Acquiring GPU…'
  device = await getBrainGPUDevice()
  if (!device) {
    health.textContent = 'WebGPU unavailable'
    health.classList.add('error')
    status.textContent =
      'Needs WebGPU + shader-f16 + 1.4 GB GPU buffer (recent desktop Chrome/Edge/Firefox-Nightly).'
    return
  }
  health.textContent = 'WebGPU ready'
  health.classList.add('ok')

  status.textContent = `Loading ${T1_URL.split('/').pop()}…`
  await loadAndPrepare({ url: T1_URL })
  await runSegmentation()
}

// --- Drag-and-drop: replace the background with the dropped NIfTI, then
//     auto-segment. prepareInput's conform step handles arbitrary input
//     dims/orientation — the model still receives a 256³ canonical volume.

function isNiftiName(name: string): boolean {
  const n = name.toLowerCase()
  return n.endsWith('.nii') || n.endsWith('.nii.gz')
}

async function handleDrop(file: File): Promise<void> {
  if (!device || isCleanedUp) return
  if (!isNiftiName(file.name)) {
    status.textContent = `Unsupported file: ${file.name} (need .nii or .nii.gz)`
    return
  }
  status.textContent = `Loading ${file.name}…`
  await loadAndPrepare({ url: file, name: file.name })
  await runSegmentation()
}

document.addEventListener(
  'dragover',
  (e) => {
    e.preventDefault()
  },
  { signal: listeners.signal },
)

document.addEventListener(
  'drop',
  (e) => {
    e.preventDefault()
    const file = e.dataTransfer?.files?.[0]
    if (file) enqueue(() => handleDrop(file))
  },
  { signal: listeners.signal },
)

// --- UI wiring ---

modelSelect.addEventListener(
  'change',
  () => {
    if (!device) return
    enqueue(runSegmentation)
  },
  { signal: listeners.signal },
)

segmentBtn.addEventListener(
  'click',
  () => {
    enqueue(runSegmentation)
  },
  { signal: listeners.signal },
)

bgOpacity.addEventListener(
  'input',
  () => {
    if (nv.volumes[0]) {
      void nv.setVolume(0, { opacity: Number(bgOpacity.value) / 100 })
    }
  },
  { signal: listeners.signal },
)

ovOpacity.addEventListener(
  'input',
  () => {
    if (nv.volumes.length > 1) {
      void nv.setVolume(1, { opacity: Number(ovOpacity.value) / 100 })
    }
  },
  { signal: listeners.signal },
)

saveBtn.addEventListener(
  'click',
  () => {
    if (nv.volumes.length < 2) return
    void nv.saveVolume({
      filename: 'brain2print-overlay.nii.gz',
      volumeByIndex: 1,
    })
  },
  { signal: listeners.signal },
)

async function cleanup(): Promise<void> {
  if (isCleanedUp) return
  isCleanedUp = true
  listeners.abort()
  // Awaiting dispose drains any in-flight inference and lets the lib's
  // tracked GPU buffers get destroyed *before* the device itself is gone.
  // Otherwise buffer.destroy() is called against a dead device — currently
  // swallowed, but order-of-operations is now correct on its own merits.
  await disposeActiveInferer()
  ctx.dispose()
  nv.destroy()
  device?.destroy()
  device = null
  cachedImg32 = null
  segmentBtn.disabled = true
  saveBtn.disabled = true
}

// Skip cleanup when the page is entering BFCache — the JS heap is preserved
// and the user may navigate back to a still-functional view. Tearing the
// device down here would leave them with a broken page on `pageshow`.
window.addEventListener(
  'pagehide',
  (e) => {
    if (e.persisted) return
    void cleanup()
  },
  { once: true, signal: listeners.signal },
)

if (import.meta.hot) {
  import.meta.hot.dispose(cleanup)
}

enqueue(init)

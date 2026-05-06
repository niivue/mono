/**
 * NiiVue + brain2print WebGPU segmentation demo.
 *
 * Loads a 256³ T1, conforms it via `nv-ext-image-processing`, then runs a
 * tinygrad-generated WGSL pipeline (`tissue_fast` or `subcortical`) to
 * produce a label-coloured overlay. Pure browser — no backend.
 *
 * Optional Mesh step: the segmentation overlay can be turned into a 3D
 * triangle mesh via either niimath (fast) or ITK-Wasm cuberille + repair +
 * smooth (quality), then exported as MZ3, OBJ, or STL.
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
  buildMeshFromVolumeFast,
  buildMeshFromVolumeQuality,
  buildSegmentationVolume,
  COLORMAP_TISSUE_SUBCORTICAL,
  getBrainGPUDevice,
  loadFastMeshAndFlipFaces,
  prepareInput,
} from '@niivue/nv-ext-brain2print'
import { conform } from '@niivue/nv-ext-image-processing'
import { Niimath } from '@niivue/nv-ext-niimath'

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
const meshBtn = $<HTMLButtonElement>('meshBtn')
const meshPanel = $<HTMLDetailsElement>('meshPanel')
const meshQuality = $<HTMLSelectElement>('meshQuality')
const meshHollow = $<HTMLInputElement>('meshHollow')
const meshClose = $<HTMLInputElement>('meshClose')
const meshSmooth = $<HTMLInputElement>('meshSmooth')
const meshShrink = $<HTMLInputElement>('meshShrink')
const meshLargest = $<HTMLInputElement>('meshLargest')
const meshBubbles = $<HTMLInputElement>('meshBubbles')
const meshApplyBtn = $<HTMLButtonElement>('meshApplyBtn')
const saveFormat = $<HTMLSelectElement>('saveFormat')
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

// Lazily-initialized niimath. Cold start of the WASM worker is ~1s; pay it
// once, the first time the user picks the Fast mesh path.
const niimath = new Niimath()
let niimathReady: Promise<void> | null = null

const listeners = new AbortController()

function canSegment(): boolean {
  return Boolean(device && cachedImg32 && !isCleanedUp)
}

function hasSegmentation(): boolean {
  return nv.volumes.length > 1
}

function hasMesh(): boolean {
  return nv.meshes.length > 0
}

function updateButtons(): void {
  segmentBtn.disabled = !canSegment()
  // The Mesh button lives inside <summary>, which can't be disabled — the
  // <details> opens on summary click regardless of the inner button's
  // disabled state. Mirror the disabled flag onto meshApplyBtn so the
  // panel's Create button is the real gate. Closing the panel itself is
  // a transition action, not a button-state computation — call sites do
  // it where the transition actually happens (e.g. loadAndPrepare).
  const noSeg = !hasSegmentation() || isCleanedUp
  meshBtn.disabled = noSeg
  meshApplyBtn.disabled = noSeg
  // Save is enabled when there's something to export — segmentation or mesh.
  // The dropdown decides which.
  saveBtn.disabled = !hasSegmentation() && !hasMesh()
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

// Serialize volume + mesh mutations so load, drop, segmentation, and mesh
// generation don't overlap. The catch keeps one failed task from poisoning
// later tasks.
let pending: Promise<unknown> = Promise.resolve()

function enqueue(fn: () => Promise<unknown>): void {
  pending = pending.then(fn).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err)
    status.textContent = `Failed: ${msg}`
    console.error('brain2print task failed', err)
  })
}

async function ensureNiimath(): Promise<void> {
  if (!niimathReady) {
    niimathReady = niimath.init().then(() => undefined)
  }
  await niimathReady
}

async function clearMeshes(): Promise<void> {
  while (nv.meshes.length > 0) {
    await nv.removeMesh(0)
  }
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
  // Close any open Mesh panel — a stale panel from a previous run shouldn't
  // suggest the controls apply to the freshly-loading volume.
  meshPanel.open = false
  await clearMeshes()
  updateButtons()
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
  updateButtons()
}

async function runSegmentation(): Promise<void> {
  if (!device || !cachedImg32 || isCleanedUp) {
    updateButtons()
    return
  }
  segmentBtn.disabled = true
  spinner.classList.remove('hidden')
  const modelName = modelSelect.value as BrainModelName
  const model = BRAIN_MODELS[modelName]
  const t0 = performance.now()

  try {
    // Drop any previous overlay/mesh; volumes[0] (the conformed input) stays.
    while (nv.volumes.length > 1) await nv.removeVolume(1)
    await clearMeshes()

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
    // After a fresh segmentation there's no mesh — bias Save toward the
    // overlay. The user can still pick a mesh format manually.
    saveFormat.value = 'volume'

    const ms = Math.round(performance.now() - t0)
    status.textContent = `${model.label}: segmented in ${ms} ms`
  } finally {
    updateButtons()
    spinner.classList.add('hidden')
  }
}

async function runMeshBuild(): Promise<void> {
  if (!hasSegmentation() || isCleanedUp) {
    updateButtons()
    return
  }
  meshApplyBtn.disabled = true
  spinner.classList.remove('hidden')
  const isQuality = meshQuality.value === 'quality'
  const t0 = performance.now()

  try {
    await clearMeshes()
    const seg = nv.volumes[nv.volumes.length - 1]
    const opts = {
      hollow: Number(meshHollow.value),
      close: Number(meshClose.value),
      reduce: Number(meshShrink.value) / 100,
      largestOnly: meshLargest.checked,
      fillBubbles: meshBubbles.checked,
    }
    if (isQuality) {
      status.textContent =
        'Building quality mesh (cuberille → repair → smooth)…'
      const buf = await buildMeshFromVolumeQuality(seg, {
        smoothIterations: Number(meshSmooth.value),
        shrinkPct: Number(meshShrink.value),
      })
      if (isCleanedUp) return
      await nv.loadMeshes([
        { url: new File([buf], 'mesh.iwm.cbor'), name: 'mesh.iwm.cbor' },
      ])
    } else {
      status.textContent = 'Building fast mesh (niimath)…'
      await ensureNiimath()
      const buf = await buildMeshFromVolumeFast(niimath, seg, opts)
      if (isCleanedUp) return
      await loadFastMeshAndFlipFaces(nv, buf)
    }
    meshPanel.open = false
    // A new mesh just landed — bias Save toward the mesh. User can still
    // override with the dropdown.
    saveFormat.value = 'mz3'
    const ms = Math.round(performance.now() - t0)
    status.textContent = `Mesh ready (${isQuality ? 'quality' : 'fast'}, ${ms} ms)`
  } finally {
    // updateButtons recomputes meshApplyBtn.disabled from current state —
    // forcing it false here would defeat the gate when seg has vanished.
    updateButtons()
    spinner.classList.add('hidden')
  }
}

async function runSave(): Promise<void> {
  const fmt = saveFormat.value
  if (fmt === 'volume') {
    if (!hasSegmentation()) {
      status.textContent = 'No segmentation to save — run Segment first.'
      return
    }
    await nv.saveVolume({
      filename: 'brain2print-overlay.nii.gz',
      volumeByIndex: 1,
    })
  } else {
    if (!hasMesh()) {
      status.textContent =
        'No mesh to save — open Mesh and click Create, or pick Volume to save the segmentation.'
      return
    }
    await nv.saveMesh(0, `brain2print-mesh.${fmt}`)
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

meshApplyBtn.addEventListener(
  'click',
  () => {
    enqueue(runMeshBuild)
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
    // Save is read-only — it doesn't mutate volumes or meshes — so don't
    // queue it behind in-flight loads, segmentations, or mesh builds. The
    // user clicking Save while a 30s Quality build runs should download
    // immediately, not after the build finishes.
    void runSave().catch((err) => {
      const msg = err instanceof Error ? err.message : String(err)
      status.textContent = `Save failed: ${msg}`
      console.error('brain2print save failed', err)
    })
  },
  { signal: listeners.signal },
)

async function cleanup(): Promise<void> {
  if (isCleanedUp) return
  isCleanedUp = true
  listeners.abort()
  // Wait for any queued task (load, segmentation, mesh build) to finish
  // before tearing down. Each enqueued task already checks `isCleanedUp`
  // mid-execution and bails early, but a task that already passed those
  // checks could still call into `nv` / `ctx` after they're disposed.
  // Awaiting `pending` gives the in-flight task a chance to settle on its
  // own short-circuit. The `.catch` inside `enqueue` makes this safe to
  // await without re-throwing.
  await pending
  // Awaiting dispose drains any in-flight inference and lets the lib's
  // tracked GPU buffers get destroyed *before* the device itself is gone.
  // Otherwise buffer.destroy() is called against a dead device — currently
  // swallowed, but order-of-operations is now correct on its own merits.
  await disposeActiveInferer()
  // @niivue/niimath has no public terminate() API but its internal worker
  // is reachable through the private field. Best-effort cleanup keeps an
  // HMR dispose / pagehide from leaking the WASM worker for the page's
  // life. Routed through `unknown` because `worker` is declared private.
  try {
    ;(niimath as unknown as { worker?: Worker }).worker?.terminate()
  } catch {
    // The worker may already be gone (cold lib, dead worker, …). Swallow.
  }
  ctx.dispose()
  nv.destroy()
  device?.destroy()
  device = null
  cachedImg32 = null
  segmentBtn.disabled = true
  meshBtn.disabled = true
  meshApplyBtn.disabled = true
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

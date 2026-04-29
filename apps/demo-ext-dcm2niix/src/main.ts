/**
 * Demo: convert a folder of DICOM files to NIfTI in the browser via
 * the dcm2niix WASM build, then view the result with NiiVue.
 *
 * Three input paths:
 *   1. <input webkitdirectory>            → runDcm2niix(input.files)
 *   2. drag-drop a folder onto the page   → traverseDataTransferItems → runDcm2niix
 *   3. "Load demo" button                 → fetchDemoManifest → runDcm2niix
 */
import NiiVueGPU, {
  DRAG_MODE,
  MULTIPLANAR_TYPE,
  SHOW_RENDER,
  SLICE_TYPE,
} from '@niivue/niivue'
import { runDcm2niix, traverseDataTransferItems } from '@niivue/nv-ext-dcm2niix'

const DEMO_MANIFEST_URL =
  'https://niivue.github.io/niivue-demo-images/dicom/niivue-manifest.txt'

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id)
  if (!el) throw new Error(`Element #${id} not found`)
  return el as T
}

const status = $('status')
const dropTarget = $('dropTarget')
const fileInput = $<HTMLInputElement>('fileInput')
const fileSelect = $<HTMLSelectElement>('fileSelect')
const saveButton = $<HTMLButtonElement>('saveButton')
const loadManifestBtn = $<HTMLButtonElement>('loadManifestBtn')
const loadingCircle = $('loadingCircle')

let convertedFiles: File[] = []
let currentFile: File | null = null
let isConverting = false

// We handle the drop ourselves on the header drop-target div, so prevent
// the canvas from intercepting drops with its own (NIfTI-only) handler.
const nv = new NiiVueGPU({ isDragDropEnabled: false })
await nv.attachTo('gl1')
nv.crosshairGap = 5
nv.multiplanarType = MULTIPLANAR_TYPE.GRID
nv.sliceType = SLICE_TYPE.MULTIPLANAR
nv.showRender = SHOW_RENDER.ALWAYS
nv.primaryDragMode = DRAG_MODE.slicer3D
nv.addEventListener('locationChange', (e) => {
  status.textContent = e.detail.string
})

setStatus('Drop a DICOM folder, choose one, or load the demo series.')

// --- File picker (webkitdirectory) ---
fileInput.addEventListener('change', async () => {
  if (!fileInput.files || fileInput.files.length === 0) return
  try {
    await convertAndDisplay(fileInput.files)
  } catch (err) {
    handleError('Conversion failed', err)
  }
})

// --- Drag-and-drop folders ---
dropTarget.addEventListener('dragover', (e) => {
  e.preventDefault()
  dropTarget.classList.add('dragover')
})
dropTarget.addEventListener('dragleave', () => {
  dropTarget.classList.remove('dragover')
})
dropTarget.addEventListener('drop', async (e) => {
  e.preventDefault()
  dropTarget.classList.remove('dragover')
  const items = e.dataTransfer?.items
  if (!items || items.length === 0) return
  try {
    showLoading('Reading dropped folder…')
    const files = await traverseDataTransferItems(items)
    await convertAndDisplay(files)
  } catch (err) {
    handleError('Drop failed', err)
  }
})

// --- Demo manifest button ---
loadManifestBtn.addEventListener('click', async () => {
  try {
    showLoading('Fetching demo DICOM series…')
    const dicomFiles = await fetchDemoManifest(DEMO_MANIFEST_URL)
    await convertAndDisplay(dicomFiles)
  } catch (err) {
    handleError('Failed to load demo series', err)
  }
})

// --- File select dropdown (multiple outputs from one conversion) ---
fileSelect.addEventListener('change', async () => {
  const idx = Number(fileSelect.value)
  if (Number.isNaN(idx) || idx < 0) return
  await viewFile(convertedFiles[idx])
})

// --- Save the currently-viewed file ---
saveButton.addEventListener('click', () => {
  if (!currentFile) return
  const url = URL.createObjectURL(currentFile)
  const a = document.createElement('a')
  a.href = url
  a.download = currentFile.name
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
})

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function convertAndDisplay(files: FileList | File[]): Promise<void> {
  if (isConverting) {
    // Drop and manifest paths call showLoading() before us, so any
    // in-progress spinner from this rejected attempt must be cleared.
    hideLoading()
    setStatus('Conversion already in progress — please wait.')
    return
  }
  isConverting = true
  setInputsDisabled(true)
  hide(saveButton)
  hide(fileSelect)
  showLoading('Converting DICOM to NIfTI…')
  try {
    const t0 = performance.now()
    const niftiFiles = await runDcm2niix(files)
    const elapsed = ((performance.now() - t0) / 1000).toFixed(2)

    if (niftiFiles.length === 0) {
      hideLoading()
      setStatus('No NIfTI output produced. Are these DICOM images?')
      return
    }

    convertedFiles = niftiFiles
    populateFileSelect(niftiFiles)
    show(fileSelect)
    show(saveButton)
    hideLoading()
    setStatus(`Converted ${niftiFiles.length} file(s) in ${elapsed} s`)

    fileSelect.value = '0'
    await viewFile(niftiFiles[0])
  } finally {
    isConverting = false
    setInputsDisabled(false)
  }
}

/**
 * Fetch a newline-delimited manifest of relative DICOM URLs and return
 * them as `File`s ready for `runDcm2niix`. Demo-only — the manifest
 * URL must be trusted (each line is treated as a fetchable URL).
 */
async function fetchDemoManifest(manifestUrl: string): Promise<File[]> {
  const baseUrl = new URL(manifestUrl, window.location.href)
  const manifestRes = await fetch(baseUrl)
  if (!manifestRes.ok) {
    throw new Error(
      `Failed to fetch manifest ${baseUrl}: ${manifestRes.status}`,
    )
  }
  const text = await manifestRes.text()
  const relativePaths = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)

  return Promise.all(
    relativePaths.map(async (relativePath) => {
      const url = new URL(relativePath, baseUrl)
      const res = await fetch(url)
      if (!res.ok) {
        throw new Error(`Failed to fetch DICOM ${url}: ${res.status}`)
      }
      const buffer = await res.arrayBuffer()
      const filename = url.pathname.split('/').pop() ?? 'dicom'
      // dcm2niix groups by webkitRelativePath; standard webkitRelativePath
      // is read-only, so stamp the underscore-prefixed form it also reads.
      const file = new File([buffer], filename) as File & {
        _webkitRelativePath?: string
      }
      file._webkitRelativePath = `series/${filename}`
      return file
    }),
  )
}

function setInputsDisabled(disabled: boolean): void {
  fileInput.disabled = disabled
  loadManifestBtn.disabled = disabled
}

async function viewFile(file: File): Promise<void> {
  currentFile = file
  if (!/\.nii(\.gz)?$/i.test(file.name)) {
    // Non-image (e.g. BIDS sidecar) — keep it available for download but
    // don't try to render.
    return
  }
  await nv.loadVolumes([{ url: file, name: file.name }])
}

function populateFileSelect(files: File[]): void {
  fileSelect.innerHTML = ''
  for (let i = 0; i < files.length; i++) {
    const option = document.createElement('option')
    option.value = String(i)
    option.text = files[i].name
    fileSelect.appendChild(option)
  }
}

function setStatus(text: string): void {
  status.textContent = text
}
function showLoading(text: string): void {
  setStatus(text)
  show(loadingCircle)
}
function hideLoading(): void {
  hide(loadingCircle)
}
function show(el: HTMLElement): void {
  el.classList.remove('hidden')
}
function hide(el: HTMLElement): void {
  el.classList.add('hidden')
}
function handleError(prefix: string, err: unknown): void {
  hideLoading()
  hide(fileSelect)
  hide(saveButton)
  const msg = err instanceof Error ? err.message : String(err)
  setStatus(`${prefix}: ${msg}`)
  console.error(prefix, err)
}

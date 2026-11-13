import { Pool } from '@niivue/geotiff-rs'
import type {
  NVSlideAttribution,
  NVSlidePoint,
  SlideTileSource,
  SlideView,
} from '@niivue/niivue'
import {
  attachSlideLens,
  createSlideView,
  DRAG_MODE,
  formatSlideSample,
  linkSlideViews,
  NVSlide,
  slideStatsSummary,
} from '@niivue/niivue'
import { registerDcm2niixDecoders } from '@niivue/nv-ext-tile/dicom'
import { openSlide, type SlideCandidate } from '@niivue/nv-ext-tile/open'
import { registerDcm2niixTiffDecoders } from '@niivue/nv-ext-tile/tiff'
// Optional: drop these calls and the @niivue/uikit dependency to lose the
// minimap, the HUD and the channel panel.
import {
  attachSlideChannelPanel,
  attachSlideHud,
  attachSlideMinimap,
  attachSlidePlaneControl,
} from '@niivue/uikit'
import { droppedFiles } from './drop'

const filesInput = document.getElementById('files') as HTMLInputElement
const slideSelect = document.getElementById('slides') as HTMLSelectElement
const seriesLabel = document.getElementById('series') as HTMLLabelElement
const sourceSelect = document.getElementById('source') as HTMLSelectElement
const customDialog = document.getElementById(
  'customDialog',
) as HTMLDialogElement
const customUrl = document.getElementById('customUrl') as HTMLInputElement
const customCancel = document.getElementById(
  'customCancel',
) as HTMLButtonElement
const levelSelect = document.getElementById('level') as HTMLSelectElement
const status = document.getElementById('status') as HTMLSpanElement
const spinner = document.getElementById('spinner') as HTMLSpanElement
// The ring replaces the status text on screen; screen readers still read it.
function spin(on: boolean): void {
  spinner.hidden = !on
  status.classList.toggle('spinning', on)
}
const iccToggle = document.getElementById('icc') as HTMLInputElement
const hud = document.getElementById('hud') as HTMLDivElement
const hudToggle = document.getElementById('hudToggle') as HTMLInputElement
const gridToggle = document.getElementById('grid') as HTMLInputElement
const scaleBarToggle = document.getElementById('scaleBar') as HTMLInputElement
const backendSelect = document.getElementById('backend') as HTMLSelectElement
const aaToggle = document.getElementById('aa') as HTMLInputElement
const hidpiToggle = document.getElementById('hidpi') as HTMLInputElement
const filterSelect = document.getElementById('filter') as HTMLSelectElement
const credit = document.getElementById('credit') as HTMLDivElement
const readout = document.getElementById('readout') as HTMLOutputElement
const dragSelect = document.getElementById('drag') as HTMLSelectElement
// Drag modes that set a channel window.
const channelDragModes = ['windowLevel', 'contrastBox'].map(
  (id) => document.getElementById(id) as HTMLOptionElement,
)
const channelsPanel = document.getElementById('channels') as HTMLElement
const minimapToggle = document.getElementById('minimap') as HTMLInputElement
const compareSelect = document.getElementById('compare') as HTMLSelectElement
let compareCanvas = document.getElementById('canvas2') as HTMLCanvasElement
const compareChannels = document.getElementById('channels2') as HTMLElement

// Backend and AA are fixed when the canvas context is made, so changing them
// reloads the page with ?backend= / ?aa=.
const params = new URLSearchParams(location.search)
// WebKit (Safari, every iOS browser) misrenders with anti-aliasing on.
const isWebKit =
  /AppleWebKit/.test(navigator.userAgent) &&
  !/Chrome|Chromium|Edg\//.test(navigator.userAgent)
const antialias = params.get('aa') ? params.get('aa') === 'on' : !isWebKit
// Menu state: set on a pick, restored from `shown` if the pick fails.
let current = '' // the menu value of what is open or opening
let currentLabel = ''
// The slides of the local files, as listed in the Series menu.
let indexed: SlideCandidate[] | null = null
let indexNote = '' // kept in the status line while an indexed slide is open
let lastFiles: File[] = []
function reloadWith(name: string, value: string): void {
  const url = new URL(location.href)
  url.searchParams.set(name, value)
  // Keep the slide on screen (not a pending pick); local files cannot survive a reload.
  url.searchParams.set('url', shown.value === 'local' ? '' : shown.value)
  location.href = url.href
}
backendSelect.onchange = () => reloadWith('backend', backendSelect.value)
aaToggle.onchange = () => reloadWith('aa', aaToggle.checked ? 'on' : 'off')

// One view for every slide: WebGPU unless ?backend=webgl2 or no adapter.
let hover: NVSlidePoint | null = null
const view = await createSlideView(
  document.getElementById('canvas') as HTMLCanvasElement,
  {
    backend: params.get('backend') === 'webgl2' ? 'webgl2' : 'webgpu',
    antialias,
    hidpi: hidpiToggle.checked,
    overlayStyle: { isRulerVisible: scaleBarToggle.checked },
    // Left and middle drag pan, right drag zooms to a box, the wheel zooms.
    controller: {
      primaryDragMode: DRAG_MODE.pan,
      secondaryDragMode: DRAG_MODE.roiSelection,
      onHover: (point) => {
        hover = point
        showReadout()
      },
    },
    onRender: afterRender,
  },
)
const { renderer } = view
const requestRender = view.requestRender
backendSelect.value = view.backend
aaToggle.checked = antialias
// The toggles below reach the compare pane too.
const views = (): SlideView[] => (compare ? [view, compare.view] : [view])
hidpiToggle.addEventListener('change', () => {
  for (const v of views()) v.hidpi = hidpiToggle.checked
})
scaleBarToggle.addEventListener('change', () => {
  view.overlayStyle = { isRulerVisible: scaleBarToggle.checked }
  // The lens shows through the main view's bar.
  if (compare && compareSelect.value !== 'lens')
    compare.view.overlayStyle = { isRulerVisible: scaleBarToggle.checked }
})
// Outlines each drawn tile; fires 'change', which redraws.
gridToggle.addEventListener('change', () => {
  for (const v of views()) v.slide?.setTileGridVisible(gridToggle.checked)
})
filterSelect.addEventListener('change', () => {
  for (const v of views()) {
    v.renderer.isNearestInterpolation = filterSelect.value === 'nearest'
    v.requestRender()
  }
})
// Windowing and contrast set the channel the panel's radio picks.
dragSelect.addEventListener('change', () => {
  if (view.controller)
    view.controller.primaryDragMode = Number(dragSelect.value) as DRAG_MODE
})
let detachMinimap: (() => void) | null = null
const syncMinimap = () => {
  detachMinimap?.()
  detachMinimap = minimapToggle.checked
    ? attachSlideMinimap(view, { corner: 'top-right' })
    : null
}
minimapToggle.addEventListener('change', syncMinimap)
syncMinimap()
attachSlideHud(view, hud, (slide, s) => [
  [
    'backend',
    `${view.backend === 'webgpu' ? 'WebGPU' : 'WebGL2'}${antialias ? ' AA' : ''}, ${filterSelect.value}, ${s.devicePixelRatio}x`,
  ],
  ...slideStatsSummary(slide, s),
])
attachSlideChannelPanel(view, channelsPanel)
attachSlidePlaneControl(view, document.getElementById('planes') as HTMLElement)

// The values under the pointer, from resident tiles (refined as tiles land),
// in place of the credit while hovering.
function showReadout(): void {
  const slide = view.slide
  readout.value =
    slide && hover
      ? formatSlideSample(hover.x, hover.y, slide.sampleAt(hover.x, hover.y))
      : ''
  readout.title = readout.value
  readout.hidden = !readout.value
  credit.hidden = !readout.hidden
}

// RGB samples have no channel to window (core's isRgbSlide, not exported).
// Switch to core's export once #770 lands.
const isRgb = (slide: NVSlide): boolean =>
  !slide.manifest.channelInfo &&
  !slide.manifest.levels.some(
    (l) =>
      l.codec === 'raw-gray' ||
      (l.photometric?.startsWith('MONOCHROME') ?? false),
  )
// RGB slides have no channel window, so they get navigation instead.
function syncDragModes(slide: NVSlide): void {
  const rgb = isRgb(slide)
  for (const option of channelDragModes) option.disabled = rgb
  if (!dragSelect.selectedOptions[0]?.disabled) return
  dragSelect.value = String(DRAG_MODE.pan)
  if (view.controller) {
    view.controller.primaryDragMode = DRAG_MODE.pan
    view.controller.selection = null
  }
  requestRender()
}

function afterRender(): void {
  // HiDPI is offered only on a HiDPI display (another monitor, browser zoom).
  hidpiToggle.disabled = window.devicePixelRatio <= 1
  if (hover) showReadout()
  // Failures stay visible with the HUD off; an open in progress owns the status.
  const failures = view.slide?.stats.failures
  if (!opening && failures)
    status.textContent = `${indexNote}${failures} tiles failed`
}

// Decode tiles in web workers rather than on the main thread.
const pool = new Pool()

const slideOptions = () => ({
  colorManagement: iccToggle.checked,
  showTileGrid: gridToggle.checked,
})

hudToggle.addEventListener('change', () => {
  hud.hidden = !hudToggle.checked
  requestRender()
})
// I (info) toggles the HUD, as in examples/slides.html.
addEventListener('keydown', (e) => {
  if (
    e.repeat ||
    e.key.toUpperCase() !== 'I' ||
    e.ctrlKey ||
    e.metaKey ||
    e.altKey
  )
    return
  // Checkboxes keep focus after a click; text fields and selects take keys.
  if (
    e.target instanceof Element &&
    e.target.matches('input:not([type=checkbox]), select, textarea')
  )
    return
  hudToggle.click()
})

// Opens can overlap (a slow URL, then a local file); only the latest wins.
// `opening` is non-null from a pick until its slide is shown; after a failure
// it stays set, so the error keeps the status line until the next open.
let openCount = 0
let opening: AbortController | null = null
// The menu state of the slide on screen, restored when a later pick fails.
function snapshot() {
  return {
    value: current,
    label: currentLabel,
    title: status.title,
    note: indexNote,
    files: lastFiles,
    indexed,
    series: seriesLabel.hidden,
    seriesOptions: [...slideSelect.options],
    seriesValue: slideSelect.value,
  }
}
let shown = snapshot()

function restoreMenu(): void {
  spin(false) // every failed open ends here
  const s = shown
  if (s.value) showCurrent(s.value, s.label)
  else sourceSelect.value = current = ''
  if (customOption.value !== s.value) customOption.remove()
  status.title = s.title
  indexNote = s.note
  lastFiles = s.files
  indexed = s.indexed
  seriesLabel.hidden = s.series
  slideSelect.replaceChildren(...s.seriesOptions)
  slideSelect.value = s.seriesValue
}

type Load = (signal: AbortSignal) => Promise<SlideTileSource>
// The loader of the slide on show: the compare view opens its own copy (a
// source serves one slide).
let shownLoad: Load | null = null

// A slide for a loaded source; a source NVSlide rejects is disposed.
function slideFor(next: SlideTileSource): NVSlide {
  try {
    return NVSlide.fromSource(next, slideOptions())
  } catch (err) {
    next.dispose?.()
    throw err
  }
}

// Side by side or lens (Avivator): a second, linked view of the same slide
// with its own channels, synced in physical units.
let compare: { view: SlideView; detach: () => void } | null = null
let compareCount = 0
let compareAbort: AbortController | null = null
// Runs one at a time: two starts on one canvas would share its context.
let compareChain = Promise.resolve()
function syncCompare(): Promise<void> {
  const id = ++compareCount
  compareAbort?.abort()
  const abort = new AbortController()
  compareAbort = abort
  compareChain = compareChain
    .then(() => runCompare(id, abort.signal))
    .catch((err) => console.error(err))
  return compareChain
}
async function runCompare(id: number, signal: AbortSignal): Promise<void> {
  if (id !== compareCount) return
  compare?.detach()
  compare?.view.destroy()
  compare = null
  const mode = compareSelect.value
  const main = document.querySelector('main') as HTMLElement
  // Shown only once attached: an unclipped lens canvas would cover the view
  // and take its input, a failed side pane would sit dead.
  const hide = (): void => {
    main.dataset.compare = 'single'
    compareCanvas.hidden = true
    compareChannels.hidden = true
  }
  hide()
  if (mode === 'single' || !shownLoad) return
  const load = shownLoad
  const second = await createSlideView(compareCanvas, {
    backend: view.backend,
    antialias,
    hidpi: hidpiToggle.checked,
    // The lens shows through the main view's scale bar, not its own.
    overlayStyle: { isRulerVisible: mode !== 'lens' && scaleBarToggle.checked },
    controller:
      mode === 'lens'
        ? false
        : {
            primaryDragMode: DRAG_MODE.pan,
            secondaryDragMode: DRAG_MODE.roiSelection,
          },
  }).catch((err) => {
    console.error(err)
    return null
  })
  if (!second) return hide()
  // A failed WebGPU start can hand back a fresh canvas.
  compareCanvas = second.canvas
  if (id !== compareCount) {
    second.destroy()
    return hide()
  }
  try {
    const slide = slideFor(await load(signal))
    slide.setLevelChoice(levelChoice())
    second.renderer.isNearestInterpolation = filterSelect.value === 'nearest'
    // No fit: the link puts it where the main view is.
    second.setSlide(slide, { fit: false })
    if (id !== compareCount) throw new Error('superseded')
  } catch (err) {
    second.destroy()
    if (id === compareCount) {
      console.error(err)
      status.textContent = `Compare view: ${err instanceof Error ? err.message : String(err)}`
    }
    return hide()
  }
  const unlink =
    mode === 'lens'
      ? attachSlideLens(view, second)
      : linkSlideViews([view, second])
  main.dataset.compare = mode
  compareCanvas.hidden = false
  second.requestRender()
  const removePanel = attachSlideChannelPanel(second, compareChannels)
  compare = {
    view: second,
    detach: () => {
      unlink()
      removePanel()
    },
  }
}
compareSelect.addEventListener('change', () => void syncCompare())

async function open(load: Load): Promise<void> {
  const id = ++openCount
  opening?.abort()
  opening = new AbortController()
  status.textContent = 'Opening...'
  spin(true)
  try {
    const next = await load(opening.signal)
    if (id !== openCount) {
      next.dispose?.()
      return
    }
    // Build the replacement before releasing the slide on screen, so a source
    // NVSlide rejects leaves the current slide showing. The slide owns (and
    // disposes) its source; the view owns the slide.
    const nextSlide = slideFor(next)
    view.setSlide(nextSlide)
    syncDragModes(nextSlide)
    shownLoad = load
    if (compareSelect.value !== 'single') void syncCompare()
    showCredit(nextSlide.manifest.attribution ?? credits.get(current))
    opening = null
    spin(false)
    shown = snapshot()
    status.textContent = indexNote // slide stats are in the HUD
    levelSelect.replaceChildren(
      new Option('auto LOD', 'auto'),
      ...nextSlide.manifest.levels.map(
        (l) =>
          new Option(`L${l.index} ${l.width}x${l.height}`, String(l.index)),
      ),
    )
  } catch (err) {
    if (id !== openCount) return
    console.error(err)
    status.textContent = err instanceof Error ? err.message : String(err)
    restoreMenu()
  }
}

// DICOM-WSI files: index the headers (no pixel data), list the slides, open one.
// JPEG 2000 and JPEG-LS tiles decode in dcm2niix's WASM workers, for DICOM-WSI
// and for JPEG 2000 TIFF (Aperio 33003/33005) alike.
registerDcm2niixDecoders()
registerDcm2niixTiffDecoders()
const SYNTAX: Record<string, string> = {
  '1.2.840.10008.1.2.4.50': 'JPEG',
  '1.2.840.10008.1.2.4.51': 'JPEG',
  '1.2.840.10008.1.2.4.80': 'JPEG-LS',
  '1.2.840.10008.1.2.4.81': 'JPEG-LS',
  '1.2.840.10008.1.2.4.90': 'JPEG 2000',
  '1.2.840.10008.1.2.4.91': 'JPEG 2000',
}
function openIndexed(i: number): void {
  const candidate = indexed?.[i]
  if (candidate) void open((signal) => candidate.open(signal))
}
const describe = (s: NonNullable<SlideCandidate['slide']>) => {
  const l0 = s.levels[0]
  const frames = s.levels.reduce((n, l) => n + l.frames.offset.length, 0)
  const holes = s.levels.reduce((n, l) => n + l.holes, 0)
  const syntax = s.instances[0]?.transferSyntax ?? ''
  return `${s.container ?? s.series.slice(-12)} path ${s.opticalPath} z ${s.focalPlane}: ${s.levels.length} levels, ${l0?.width}x${l0?.height}, ${SYNTAX[syntax] ?? syntax}, ${l0?.sparse ? 'sparse' : 'full'}, ${frames} frames, ${holes} holes`
}

// Custom files: tiled TIFFs and the files of DICOM-WSI slides, listed together.
async function openFiles(files: File[]): Promise<void> {
  const first = files[0]
  if (!first) return
  showCurrent(
    'local',
    files.length === 1 ? first.name : `${files.length} files`,
  )
  // Take an open generation (and own the status) before listing, so a newer
  // pick wins the await and aborts the indexing.
  const id = ++openCount
  opening?.abort()
  opening = new AbortController()
  status.textContent = 'Opening...'
  spin(true)
  try {
    const t0 = performance.now()
    const { candidates, index } = await openSlide(files, {
      pool,
      signal: opening.signal,
      onProgress: (done, total) => {
        if (id === openCount)
          status.textContent = `Indexing ${done}/${total} files...`
      },
    })
    if (id !== openCount) return
    const ms = performance.now() - t0
    const skipped = (index?.skipped ?? []).map((k) => `${k.file}: ${k.reason}`)
    if (!candidates.length) {
      restoreMenu()
      status.title = skipped.join('\n')
      status.textContent = `No tiled DICOM-WSI slide in ${files.length} files (${skipped.length} skipped).`
      return
    }
    indexed = candidates
    slideSelect.replaceChildren(
      ...candidates.map(
        (c, i) => new Option(c.slide ? describe(c.slide) : c.label, String(i)),
      ),
    )
    seriesLabel.hidden = !index && candidates.length === 1
    status.title = skipped.join('\n')
    if (index)
      indexNote = `Indexed in ${ms.toFixed(0)} ms (${skipped.length} files skipped). `
    // Every candidate keeps the listing signal, so it is never aborted from here.
    opening = null
    openIndexed(0)
  } catch (err) {
    if (id !== openCount) return
    console.error(err)
    status.textContent = err instanceof Error ? err.message : String(err)
    restoreMenu()
  }
}
filesInput.addEventListener('change', () => {
  const files = [...(filesInput.files ?? [])]
  filesInput.value = '' // so the same files can be picked again
  if (!files.length) return
  lastFiles = files
  void openFiles(files)
})
// Drop files or folders anywhere on the page: the same path as Custom files.
const dropZone = document.querySelector('main') as HTMLElement
const dragsFiles = (e: DragEvent) => e.dataTransfer?.types.includes('Files')
for (const type of ['dragenter', 'dragover'] as const)
  document.addEventListener(type, (e) => {
    if (!dragsFiles(e)) return
    e.preventDefault() // allows the drop
    dropZone.classList.add('drop')
  })
document.addEventListener('dragleave', (e) => {
  if (!e.relatedTarget) dropZone.classList.remove('drop') // left the window
})
document.addEventListener('drop', async (e) => {
  if (!e.dataTransfer || !dragsFiles(e)) return
  e.preventDefault()
  dropZone.classList.remove('drop')
  // Claim the open generation now: an open started while the folder is walked
  // is newer and wins, so a slow walk must not replace it (or its status).
  const id = ++openCount
  let failure = 'Drop had no files'
  const files = await droppedFiles(e.dataTransfer).catch((err) => {
    failure = `Drop failed: ${err instanceof Error ? err.message : err}`
    return []
  })
  if (id !== openCount) return
  if (!files.length) {
    // This drop claimed the generation, so it ends the open it superseded.
    opening?.abort()
    restoreMenu()
    status.textContent = failure
    return
  }
  lastFiles = files
  void openFiles(files)
})
iccToggle.addEventListener('change', () => {
  // Fires 'change', which redraws.
  for (const v of views())
    if (v.slide) v.slide.colorManagement = iccToggle.checked
})
const levelChoice = () =>
  levelSelect.value === 'auto' ? ('auto' as const) : Number(levelSelect.value)
levelSelect.addEventListener('change', () => {
  for (const v of views()) v.slide?.setLevelChoice(levelChoice())
})
slideSelect.addEventListener('change', () =>
  openIndexed(Number(slideSelect.value)),
)

// OpenSlide test slides mirrored on Hugging Face (pinned commit; Range + CORS
// after a redirect to its CDN). Only single-file TIFF-based formats stream;
// the JPEG 2000 SVS files (compression 33003/33005) decode through dcm2niix.
const HF =
  'https://huggingface.co/datasets/neurodeskorg/webapps/resolve/cfff0272e4e7cdbc324863f15f55edd8a848acfb/openslide/'
// Credits for the listed non-Zarr slides, keyed by menu value; shown like a
// Zarr store's `attribution`. OpenSlide licences and credits are from
// openslide-testdata/index.json (CC0-1.0 unless noted).
const credits = new Map<string, NVSlideAttribution>()
const OPENSLIDE = 'https://openslide.cs.cmu.edu/download/openslide-testdata/'
const FREE = 'Free to use and distribute, with or without modification'
const RADBOUD = {
  credit: 'Computational Pathology Group, Radboud University Medical Center',
}
const HURON = { credit: 'Huron Digital Pathology' }
const OPENSLIDE_CREDITS: Record<string, NVSlideAttribution> = {
  'Aperio/JP2K-33003-1.svs': { license: FREE },
  'Aperio/JP2K-33003-2.svs': { license: FREE },
  'Huron/Huron-1.tif': HURON,
  'Huron/Huron-1-40x.tif': HURON,
  'Huron/Huron-1-Uncompressed.tif': HURON,
  'Philips-TIFF/Philips-1.tiff': RADBOUD,
  'Philips-TIFF/Philips-2.tiff': RADBOUD,
  'Philips-TIFF/Philips-4.tiff': RADBOUD,
  'Leica/Leica-1.scn': { credit: 'Yves Sucaet', license: FREE },
  'Ventana/Ventana-1.bif': { credit: 'PathAI' },
  'DICOM/3DHISTECH-1.zip': { credit: '3DHISTECH' },
  'DICOM/3DHISTECH-2.zip': { credit: 'Dr. Mario Kreutzfeldt' },
  'DICOM/Hamamatsu-2.zip': { credit: 'Hamamatsu' },
  'DICOM/Leica-4.zip': { credit: 'Leica' },
  'DICOM/JP2K-33003-1-v2.zip': { license: FREE },
}
const openslideCredit = (
  file: string,
  title = `OpenSlide test data ${file}`,
) => ({
  title,
  url: `${OPENSLIDE}${file.split('/')[0]}/`,
  license: 'CC0-1.0',
  ...OPENSLIDE_CREDITS[file],
})
const credited = (option: HTMLOptionElement, a: NVSlideAttribution) => {
  credits.set(option.value, a)
  return option
}
const tiffOption = (path: string, note: string) => {
  const name = path.split('/').pop()
  const remote = path.startsWith('https:') // the LFS copy of an Aperio slide
  return credited(
    new Option(`${name} (${note})`, remote ? path : HF + path),
    openslideCredit(remote ? `Aperio/${name}` : path),
  )
}
// Hosted DICOM-WSI manifests (dicom-wsi-range-v1), each naming its .dcm files.
const DICOM =
  'https://raw.githubusercontent.com/niivue/niivue-demo-images-lfs/main/streaming/dicom-wsi/'
// Each hosted slide's source: an OpenSlide DICOM archive, or its own credit.
const LUMINANCE = openslideCredit(
  'DICOM/3DHISTECH-1.zip',
  'Luminance of OpenSlide test data DICOM/3DHISTECH-1.zip',
)
const DICOM_CREDITS: Record<string, NVSlideAttribution> = {
  '3dhistech-1': openslideCredit('DICOM/3DHISTECH-1.zip'),
  '3dhistech-2': openslideCredit('DICOM/3DHISTECH-2.zip'),
  // TCIA's collection page: CC BY 4.0, citation (with DOI) required.
  'cptac-brca': {
    title: 'CPTAC-BRCA, The Cancer Imaging Archive',
    url: 'https://www.cancerimagingarchive.net/collection/cptac-brca/',
    citation:
      'National Cancer Institute Clinical Proteomic Tumor Analysis Consortium (CPTAC) (2020). The Clinical Proteomic Tumor Analysis Consortium Breast Invasive Carcinoma Collection (CPTAC-BRCA) (Version 1). The Cancer Imaging Archive. https://doi.org/10.7937/TCIA.CAEM-YS80',
    license: 'CC BY 4.0',
  },
  'hamamatsu-2': openslideCredit('DICOM/Hamamatsu-2.zip'),
  'leica-4': openslideCredit('DICOM/Leica-4.zip'),
  'cmu-1-jp2k-rct': openslideCredit('DICOM/CMU-1-JP2K-RCT-v2.zip'),
  'jp2k-33003-1': openslideCredit('DICOM/JP2K-33003-1-v2.zip'),
  'mono12-jls': LUMINANCE,
  'mono8-jls-m1': LUMINANCE,
}
const dicomOption = (dir: string, label: string) =>
  credited(
    new Option(label, `${DICOM}${dir}/manifest.json`),
    DICOM_CREDITS[dir] ?? {},
  )
const group = (label: string, options: HTMLOptionElement[]) => {
  const g = Object.assign(document.createElement('optgroup'), { label })
  g.append(...options)
  return g
}
// 2D OME-Zarr stores mirrored on Hugging Face (pinned commit); credits are
// read from each store's `attribution` attribute.
const ZARR =
  'https://huggingface.co/datasets/neurodeskorg/webapps/resolve/f7cb7ad92d8ceacb1f922ecb17b0a60fd9710c71/omezarr2d/'
const zarrOption = (name: string, note: string) =>
  new Option(`${name} (${note})`, `${ZARR}${name}.ome.zarr`)
// Shows what is open when it is not a listed slide: a custom URL or local files.
const customOption = new Option()
const customUrlOption = new Option('Custom URL...', 'custom-url')
sourceSelect.replaceChildren(
  group('TIFF / SVS', [
    tiffOption(
      'https://media.githubusercontent.com/media/niivue/niivue-demo-images-lfs/main/streaming/svs/CMU-1-Small-Region.svs',
      '2 MB',
    ),
    tiffOption('Aperio/CMU-1.svs', '178 MB, ICC'),
    tiffOption('Aperio/CMU-2.svs', '391 MB'),
    tiffOption('Aperio/CMU-3.svs', '254 MB'),
    tiffOption('Aperio/CMU-1-JP2K-33005.svs', '133 MB, JPEG 2000 RGB'),
    tiffOption('Aperio/JP2K-33003-1.svs', '64 MB, JPEG 2000 YCbCr'),
    tiffOption('Aperio/JP2K-33003-2.svs', '289 MB, JPEG 2000 YCbCr'),
    tiffOption('Generic-TIFF/CMU-1.tiff', '204 MB, 9 levels'),
    tiffOption('Huron/Huron-1.tif', '36 MB'),
    tiffOption('Huron/Huron-1-40x.tif', '116 MB'),
    tiffOption('Huron/Huron-1-Uncompressed.tif', '214 MB, uncompressed'),
    tiffOption('Argos/Argos-1.avs', '93 MB, very wide'),
    tiffOption('Philips-TIFF/Philips-1.tiff', '327 MB'),
    tiffOption('Philips-TIFF/Philips-2.tiff', '914 MB, largest'),
    tiffOption('Philips-TIFF/Philips-4.tiff', '291 MB, sparse'),
    tiffOption('Leica/Leica-1.scn', '292 MB'),
    tiffOption('Ventana/Ventana-1.bif', '227 MB, tile joints placed'),
  ]),
  group('DICOM-WSI', [
    dicomOption('3dhistech-1', '3DHISTECH-1'),
    dicomOption('3dhistech-2', '3DHISTECH-2 (sparse, split level 0)'),
    dicomOption('cptac-brca', 'CPTAC-BRCA (IDC)'),
    dicomOption('hamamatsu-2', 'Hamamatsu-2 (extended offset table)'),
    dicomOption('leica-4', 'Leica-4 (sparse)'),
    dicomOption('cmu-1-jp2k-rct', 'CMU-1 (JPEG 2000 reversible colour)'),
    dicomOption('jp2k-33003-1', 'JP2K-33003-1 (JPEG 2000)'),
    dicomOption('mono12-jls', 'Monochrome 12-bit (JPEG-LS)'),
    dicomOption(
      'mono8-jls-m1',
      'Monochrome 8-bit MONOCHROME1 (JPEG-LS near-lossless)',
    ),
  ]),
  group('OME-Zarr', [
    zarrOption('webb-cosmic-cliffs', '238 MB, RGB'),
    zarrOption('nasa-moon-lroc-color', '187 MB, RGB'),
    zarrOption('nasa-black-marble-europe', '161 MB, RGB'),
    zarrOption('idr0157-asterella-thallus', '174 MB, brightfield RGB'),
    zarrOption('idr0073-lung-tlo', '178 MB, IHC RGB'),
    zarrOption('sentinel2-richat-structure', '231 MB, uint16, 6 bands'),
    zarrOption('idr0033-cell-painting', '28 MB, uint16, 5 channels'),
    zarrOption('idr0158-lymphoma-mxif', '189 MB, 5 channels'),
    zarrOption('idr0054-tonsil-imc', '93 MB, 27 channels'),
    zarrOption('idr0066-chick-embryo-mip', '25 MB, light-sheet'),
    zarrOption('empiar10404-sars-cov-2-organoid', '186 MB, TEM'),
    zarrOption('empiar12850-mouse-brain-tem', '164 MB, TEM, 27000 px'),
  ]),
  // Deep Zoom: core reads DZI itself (DziSource), no extension needed.
  group('Deep Zoom (DZI)', [
    credited(
      new Option(
        'OpenSeadragon highsmith (web)',
        'https://openseadragon.github.io/example-images/highsmith/highsmith.dzi',
      ),
      // OpenSeadragon states no credit or licence for this image (owner, 2026-11-12).
      {
        title: "OpenSeadragon's home-page demo image",
        url: 'https://openseadragon.github.io/',
        license: 'No licence stated',
      },
    ),
  ]),
  group('Custom', [
    customUrlOption,
    new Option('Custom files...', 'custom-files'),
  ]),
)
// Picks what the menu shows and resets the previous pick's notes.
function showCurrent(value: string, label: string): void {
  current = value
  currentLabel = label
  sourceSelect.value = value
  if (sourceSelect.value !== value) {
    customOption.value = value
    customOption.text = `${label} (custom)`
    customUrlOption.before(customOption)
    sourceSelect.value = value
  }
  seriesLabel.hidden = true
  indexNote = ''
  status.title = ''
}

function showCredit(a: NVSlideAttribution | undefined): void {
  credit.replaceChildren()
  credit.title = ''
  if (typeof a?.title !== 'string') return
  // Remote metadata: a link only for http(s), so a javascript: URL stays text.
  const url = typeof a.url === 'string' ? URL.parse(a.url) : null
  const title =
    url && /^https?:$/.test(url.protocol)
      ? Object.assign(document.createElement('a'), {
          href: url.href,
          target: '_blank',
          rel: 'noopener',
          textContent: a.title,
        })
      : a.title
  const str = (t: unknown): t is string => typeof t === 'string' && t !== ''
  const rest = [[a.credit, a.citation].find(str), a.license]
    .filter(str)
    .map((t) => `. ${t.replace(/\.$/, '')}`)
  credit.append(title, ...rest)
  // The bar truncates it: the tooltip has it all.
  credit.title = [
    credit.textContent,
    str(a.modified) && `Modified: ${a.modified}`,
  ]
    .filter(Boolean)
    .join('\n')
}

const openUrl = (url: string) => {
  showCurrent(url, url.replace(/\/+$/, '').split('/').pop() || url)
  // Inside the loader, so a malformed URL is reported in the status line.
  return open(async (signal) => {
    const [candidate] = (
      await openSlide(url, {
        pool,
        signal,
        // GitHub raw serves LFS pointers, so the listed manifests' relative .dcm
        // paths resolve against its media endpoint, which serves the LFS files.
        baseUrl: url.startsWith(DICOM)
          ? url.replace(
              'https://raw.githubusercontent.com/',
              'https://media.githubusercontent.com/media/',
            )
          : undefined,
      })
    ).candidates
    // A URL is one slide.
    return (candidate as SlideCandidate).open(signal)
  })
}
sourceSelect.addEventListener('change', () => {
  const value = sourceSelect.value
  if (value === 'custom-files') {
    filesInput.click()
    sourceSelect.value = current // a pick updates it; a cancel leaves it
    return
  }
  if (value === 'local') return void openFiles(lastFiles)
  if (value !== 'custom-url') return void openUrl(value)
  customUrl.value = current === 'local' ? '' : current
  // Escape closes without setting returnValue, so clear the last one.
  customDialog.returnValue = ''
  customDialog.showModal()
  customUrl.select()
})
// Cancel closes without a returnValue, so Enter in the URL field opens.
customCancel.addEventListener('click', () => customDialog.close())
customDialog.addEventListener('close', () => {
  if (customDialog.returnValue === 'open') void openUrl(customUrl.value)
  else sourceSelect.value = current // cancelled: show what is open
})

// ?bench exposes the view to bench/run.mjs (apps/demo-ext-tile/README.md).
if (params.has('bench'))
  Object.assign(window, {
    nvBench: {
      slide: () => view.slide,
      renderer,
      screen: view.screen,
      openUrl,
      requestRender,
      compare: () => compare?.view.slide ?? null,
    },
  })
// Default slide so the Pages demo is not empty; ?url= (empty) starts blank.
const startUrl = params.get('url') ?? sourceSelect.options[0]?.value ?? ''
if (startUrl) void openUrl(startUrl)
else sourceSelect.value = ''

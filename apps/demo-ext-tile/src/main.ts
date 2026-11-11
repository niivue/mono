import { fromBlob, Pool } from '@niivue/geotiff-rs'
import type { NVSlideScreen, SlideTileSource } from '@niivue/niivue'
import {
  DRAG_MODE,
  DziSource,
  NVSlide,
  NVSlideController,
  SlideRenderer,
  SlideRendererGPU,
  slideOverlayContent,
} from '@niivue/niivue'
import {
  DicomWsiSource,
  indexDicomWsi,
  registerDcm2niixDecoders,
  type SlideIndex,
} from '@niivue/nv-ext-tile/dicom'
import {
  registerDcm2niixTiffDecoders,
  TiffSlideSource,
} from '@niivue/nv-ext-tile/tiff'
import { ZarrSlideSource } from '@niivue/nv-ext-tile/zarr'
// Optional: remove this import, its call and the @niivue/uikit dependency to drop the minimap.
import { attachMinimap } from './minimap'

let canvas = document.getElementById('canvas') as HTMLCanvasElement
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
const backendSelect = document.getElementById('backend') as HTMLSelectElement
const aaToggle = document.getElementById('aa') as HTMLInputElement
const hidpiToggle = document.getElementById('hidpi') as HTMLInputElement
const filterSelect = document.getElementById('filter') as HTMLSelectElement
const credit = document.getElementById('credit') as HTMLDivElement

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
let indexed: { index: SlideIndex; files: File[] } | null = null
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

// WebGPU unless ?backend=webgl2 or no adapter.
const gpu =
  params.get('backend') === 'webgl2'
    ? null
    : await SlideRendererGPU.create(canvas, { antialias }).catch((err) => {
        console.warn('WebGPU unavailable, using WebGL2', err)
        return null
      })
const webgl2 = () => canvas.getContext('webgl2', { alpha: false, antialias })
let gl = gpu ? null : webgl2()
if (!gpu && !gl) {
  // A WebGPU failure after getContext('webgpu') leaves this canvas unusable for WebGL2.
  const fresh = canvas.cloneNode() as HTMLCanvasElement
  canvas.replaceWith(fresh)
  canvas = fresh
  gl = webgl2()
}
const renderer = gpu ?? new SlideRenderer()
if (renderer instanceof SlideRenderer) {
  if (!gl) throw new Error('Neither WebGPU nor WebGL2 is available')
  renderer.init(gl)
}
backendSelect.value = gpu ? 'webgpu' : 'webgl2'
aaToggle.checked = antialias
// HiDPI draws at the display's pixel ratio; it is disabled on a 1x display and
// re-checked when the ratio changes (another monitor, browser zoom).
function watchPixelRatio(): void {
  hidpiToggle.disabled = window.devicePixelRatio <= 1
  matchMedia(`(resolution: ${window.devicePixelRatio}dppx)`).addEventListener(
    'change',
    () => {
      watchPixelRatio()
      requestRender()
    },
    { once: true },
  )
}
watchPixelRatio()
hidpiToggle.addEventListener('change', () => requestRender())
// Outlines each drawn tile; fires 'change', which redraws.
gridToggle.addEventListener('change', () =>
  slide?.setTileGridVisible(gridToggle.checked),
)
filterSelect.addEventListener('change', () => {
  renderer.isNearestInterpolation = filterSelect.value === 'nearest'
  requestRender()
})
// Decode tiles in web workers rather than on the main thread.
const pool = new Pool()

let slide: NVSlide | null = null
const slideOptions = () => ({
  colorManagement: iccToggle.checked,
  showTileGrid: gridToggle.checked,
})
// TIFF sources hold geotiff state; DICOM-WSI sources only hold Files.
// An OME-Zarr store may carry an `attribution` attribute (the demo stores do).
type Attribution = Partial<
  Record<
    'title' | 'url' | 'license' | 'credit' | 'citation' | 'modified',
    string
  >
>
type Source = SlideTileSource & {
  dispose?(): void
  attribution?: Attribution
}
let source: Source | null = null
let frame = 0
let needsFit = false

function screen(): NVSlideScreen {
  const rect = canvas.getBoundingClientRect()
  return {
    widthCss: rect.width,
    heightCss: rect.height,
    // Never below 1: browser zoom-out would otherwise draw a blurry canvas.
    devicePixelRatio: hidpiToggle.checked
      ? Math.max(1, window.devicePixelRatio || 1)
      : 1,
  }
}

function render(): void {
  frame = 0
  if (!slide) return
  const s = screen()
  const dpr = s.devicePixelRatio ?? 1
  const width = Math.max(1, Math.floor(s.widthCss * dpr))
  const height = Math.max(1, Math.floor(s.heightCss * dpr))
  // Resizing resets the canvas, so only when the size changed.
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width
    canvas.height = height
  }
  // Fit after the canvas is sized, so the first frame is centred.
  if (needsFit) slide.fitToScreen(s)
  needsFit = false
  slide.clampViewport(s)
  renderer.overlay = slideOverlayContent(slide, s, gestures)
  if (renderer instanceof SlideRendererGPU) renderer.render([slide], s)
  else if (gl) renderer.draw(gl, [slide], s)
  updateHud(s)
  // Failures stay visible with the HUD off; an open in progress owns the status.
  const { failures } = slide.stats
  if (!opening && failures)
    status.textContent = `${indexNote}${failures} tiles failed`
}

function updateHud(s: NVSlideScreen): void {
  if (!slide || !hudToggle.checked) return
  const { level, tiles, requestedLevel, capped } = slide.visibleTiles(s)
  const st = slide.stats
  const scale = slide.viewport.scale
  const mode = capped
    ? '(no level fits the tile cache: centre only, zoom in)'
    : requestedLevel
      ? `(L${requestedLevel.index} exceeds the tile cache)`
      : slide.levelChoice === 'auto'
        ? 'auto'
        : 'fixed'
  hud.textContent = [
    `${slide.name}: ${slide.manifest.levels.length} levels${slide.colorLut ? `, ICC profile${slide.colorManagement ? '' : ' (off)'}` : ''}`,
    `backend   ${gpu ? 'WebGPU' : 'WebGL2'}${antialias ? ' AA' : ''}, ${filterSelect.value}, ${s.devicePixelRatio}x`,
    `level     ${level ? `L${level.index} ${mode} ${level.width}x${level.height}` : '-'}`,
    `codec     ${level?.codec ?? '-'}`,
    `zoom      ${scale >= 1 ? `${scale.toFixed(2)}x` : `1:${(1 / scale).toFixed(1)}`}`,
    `tiles     ${tiles.length} visible, ${slide.pendingCount} pending`,
    `requests  ${st.completed}/${st.requested} done, ${st.rangeHits} HTTP 206, ${st.fullFileFallbacks} HTTP 200`,
    `wire      ${(st.wireBytes / 1e6).toFixed(2)} MB`,
    `cache     ${(st.cacheBytes / 1e6).toFixed(2)} MB, ${st.cacheHits} hits`,
    `failures  ${st.failures}`,
  ].join('\n')
}
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

function requestRender(): void {
  if (!frame) frame = requestAnimationFrame(render)
}

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

// A loader returns a tile source, or a slide it built itself (a hosted manifest).
async function open(
  load: (signal: AbortSignal) => Promise<Source | NVSlide>,
): Promise<void> {
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
    // NVSlide rejects leaves the current slide showing.
    let nextSlide: NVSlide
    try {
      nextSlide =
        next instanceof NVSlide
          ? next
          : NVSlide.fromSource(next, slideOptions())
    } catch (err) {
      next.dispose?.()
      throw err
    }
    slide?.removeEventListener('change', requestRender)
    slide?.dispose()
    source?.dispose?.()
    renderer.clearTextures()
    source = next instanceof NVSlide ? null : next
    slide = nextSlide
    if (next instanceof ZarrSlideSource && next.window)
      slide.setChannel(0, next.window)
    showCredit(source?.attribution ?? credits.get(current))
    slide.addEventListener('change', requestRender)
    opening = null
    spin(false)
    shown = snapshot()
    status.textContent = indexNote // slide stats are in the HUD
    levelSelect.replaceChildren(
      new Option('auto LOD', 'auto'),
      ...slide.manifest.levels.map(
        (l) =>
          new Option(`L${l.index} ${l.width}x${l.height}`, String(l.index)),
      ),
    )
    needsFit = true
    requestRender()
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
  const slide = indexed?.index.slides[i]
  if (!indexed || !slide) return
  const files = indexed.files
  void open(async () => new DicomWsiSource(slide, files))
}

// Custom files: one tiled TIFF, or the files of a DICOM-WSI slide (or several).
const sniff = async (file: File) => {
  const b = new Uint8Array(await file.slice(0, 132).arrayBuffer())
  // II*. / MM.* (TIFF) and II+. / MM.+ (BigTIFF)
  const tiff =
    (b[0] === 0x49 && b[1] === 0x49 && b[3] === 0) ||
    (b[0] === 0x4d && b[1] === 0x4d && b[2] === 0)
  // TIFF magic plus DICM at 128 is a dual-personality DICOM-TIFF, or a TIFF
  // whose padding holds those bytes: try DICOM, fall back to TIFF.
  const dicm = new TextDecoder().decode(b.subarray(128, 132)) === 'DICM'
  return tiff ? (dicm ? 'dual' : 'tiff') : 'dicom'
}

async function openFiles(files: File[]): Promise<void> {
  const first = files[0]
  if (!first) return
  showCurrent(
    'local',
    files.length === 1 ? first.name : `${files.length} files`,
  )
  // Take an open generation (and own the status) before sniffing, so a newer
  // pick wins the await.
  const id = ++openCount
  opening?.abort()
  opening = new AbortController()
  spin(true)
  const openTiff = () =>
    void open(async () =>
      TiffSlideSource.fromGeoTIFF(await fromBlob(first), {
        id: first.name,
        pool,
      }),
    )
  try {
    const kind = files.length === 1 ? await sniff(first) : 'dicom'
    if (id !== openCount) return
    if (kind === 'tiff') return openTiff()
    status.textContent = `Indexing ${files.length} files...`
    const t0 = performance.now()
    const index = await indexDicomWsi(files)
    if (id !== openCount) return
    const ms = performance.now() - t0
    const skipped = index.skipped.map((k) => `${k.file}: ${k.reason}`)
    if (!index.slides.length) {
      if (kind === 'dual') return openTiff()
      restoreMenu()
      status.title = skipped.join('\n')
      status.textContent = `No tiled DICOM-WSI slide in ${files.length} files (${skipped.length} skipped).`
      return
    }
    indexed = { index, files }
    slideSelect.replaceChildren(
      ...index.slides.map((s, i) => {
        const l0 = s.levels[0]
        const frames = s.levels.reduce((n, l) => n + l.frames.offset.length, 0)
        const holes = s.levels.reduce((n, l) => n + l.holes, 0)
        const syntax = s.instances[0]?.transferSyntax ?? ''
        const option = document.createElement('option')
        option.value = String(i)
        option.textContent = `${s.container ?? s.series.slice(-12)} path ${s.opticalPath} z ${s.focalPlane}: ${s.levels.length} levels, ${l0?.width}x${l0?.height}, ${SYNTAX[syntax] ?? syntax}, ${l0?.sparse ? 'sparse' : 'full'}, ${frames} frames, ${holes} holes`
        return option
      }),
    )
    seriesLabel.hidden = false
    status.title = skipped.join('\n')
    indexNote = `Indexed in ${ms.toFixed(0)} ms (${skipped.length} files skipped). `
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
iccToggle.addEventListener('change', () => {
  if (slide) slide.colorManagement = iccToggle.checked // fires 'change', which redraws
})
levelSelect.addEventListener('change', () =>
  slide?.setLevelChoice(
    levelSelect.value === 'auto' ? 'auto' : Number(levelSelect.value),
  ),
)
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
const credits = new Map<string, Attribution>()
const OPENSLIDE = 'https://openslide.cs.cmu.edu/download/openslide-testdata/'
const FREE = 'Free to use and distribute, with or without modification'
const RADBOUD = {
  credit: 'Computational Pathology Group, Radboud University Medical Center',
}
const HURON = { credit: 'Huron Digital Pathology' }
const OPENSLIDE_CREDITS: Record<string, Attribution> = {
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
const credited = (option: HTMLOptionElement, a: Attribution) => {
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
const DICOM_CREDITS: Record<string, Attribution> = {
  '3dhistech-1': openslideCredit('DICOM/3DHISTECH-1.zip'),
  '3dhistech-2': openslideCredit('DICOM/3DHISTECH-2.zip'),
  // ponytail: source only; its licence is not recorded here.
  'cptac-brca': {
    title: 'CPTAC-BRCA, NCI Imaging Data Commons',
    url: 'https://portal.imaging.datacommons.cancer.gov/',
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
    tiffOption('Leica/Leica-1.scn', '292 MB, offsets not applied'),
    tiffOption('Ventana/Ventana-1.bif', '227 MB, tile joints not applied'),
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
      // ponytail: OpenSeadragon gives no credit or licence for this image.
      {
        title: 'OpenSeadragon example image',
        url: 'https://openseadragon.github.io/examples/tilesource-dzi/',
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

function showCredit(a: Attribution | undefined): void {
  credit.replaceChildren()
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
  credit.title = str(a.modified) ? `Modified: ${a.modified}` : ''
}

// zarr.json is OME-Zarr 0.5 (v3); a v2 store (.zattrs) shows no credit.
const fetchAttribution = (href: string, signal: AbortSignal) => {
  const u = new URL(href)
  u.pathname = u.pathname.replace(/\/*$/, '/zarr.json')
  return fetch(u, { signal })
    .then((r) => r.json())
    .then((j) => j.attributes?.attribution as Attribution | undefined)
    .catch(() => undefined)
}

const openUrl = (url: string) => {
  showCurrent(url, url.replace(/\/+$/, '').split('/').pop() || url)
  return open(async (signal) => {
    // Inside the loader, so a malformed URL is reported in the status line.
    const href = new URL(url, location.href).href
    const path = new URL(href).pathname
    // A .zarr path or a directory (trailing /) is OME-Zarr; it must name the
    // store's group root, so a path to an array inside a store is refused.
    if (/\.zarr(\/|$)|\/$/.test(path)) {
      const [zarr, attribution] = await Promise.all([
        ZarrSlideSource.fromUrl(href, { signal }),
        fetchAttribution(href, signal),
      ])
      return Object.assign(zarr, { attribution })
    }
    if (/\.dzi$/i.test(path)) return DziSource.fromUrl(href, undefined, signal)
    // ponytail: a .json path is a hosted DICOM-WSI manifest; sniff if names lie.
    if (!path.endsWith('.json'))
      return TiffSlideSource.fromUrl(href, { pool, signal })
    const response = await fetch(href, { signal })
    if (!response.ok) throw new Error(`Slide manifest HTTP ${response.status}`)
    // GitHub raw serves LFS pointers, so the listed manifests' relative .dcm
    // paths resolve against its media endpoint, which serves the LFS files.
    return new NVSlide(await response.json(), {
      ...slideOptions(),
      manifestUrl: href.startsWith(DICOM)
        ? href.replace(
            'https://raw.githubusercontent.com/',
            'https://media.githubusercontent.com/media/',
          )
        : href,
    })
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

// Left and middle drag pan, right drag zooms to a box, the wheel zooms.
const gestures = new NVSlideController(canvas, {
  slide: () => slide,
  screen,
  primaryDragMode: DRAG_MODE.pan,
  secondaryDragMode: DRAG_MODE.roiSelection,
  onChange: requestRender,
})
window.addEventListener('resize', requestRender)
attachMinimap(canvas, renderer, () => slide, requestRender)

// Default slide so the Pages demo is not empty; ?url= (empty) starts blank.
const startUrl = params.get('url') ?? sourceSelect.options[0]?.value ?? ''
if (startUrl) void openUrl(startUrl)
else sourceSelect.value = ''

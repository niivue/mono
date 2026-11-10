import { fromBlob, Pool } from '@niivue/geotiff-rs'
import type { NVSlideScreen, SlideTileSource } from '@niivue/niivue'
import { NVSlide, SlideRenderer, SlideRendererGPU } from '@niivue/niivue'
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
const iccToggle = document.getElementById('icc') as HTMLInputElement
const hud = document.getElementById('hud') as HTMLDivElement
const hudToggle = document.getElementById('hudToggle') as HTMLInputElement
const backendSelect = document.getElementById('backend') as HTMLSelectElement
const aaToggle = document.getElementById('aa') as HTMLInputElement
const hidpiToggle = document.getElementById('hidpi') as HTMLInputElement
const filterSelect = document.getElementById('filter') as HTMLSelectElement

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

// WebGPU unless ?backend=webgl2 or no adapter; SlideRendererGPU has no MSAA.
const gpu =
  params.get('backend') === 'webgl2'
    ? null
    : await SlideRendererGPU.create(canvas).catch((err) => {
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
aaToggle.checked = antialias && !gpu
aaToggle.disabled = !!gpu
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
filterSelect.addEventListener('change', () => {
  renderer.isNearestInterpolation = filterSelect.value === 'nearest'
  requestRender()
})
// Decode tiles in web workers rather than on the main thread.
const pool = new Pool()

let slide: NVSlide | null = null
// TIFF sources hold geotiff state; DICOM-WSI sources only hold Files.
type Source = SlideTileSource & { dispose?(): void }
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
    `backend   ${gpu ? 'WebGPU' : `WebGL2${antialias ? ' AA' : ''}`}, ${filterSelect.value}, ${s.devicePixelRatio}x`,
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
  try {
    const next = await load(opening.signal)
    if (id !== openCount) {
      next.dispose?.()
      return
    }
    slide?.removeEventListener('change', requestRender)
    slide?.dispose()
    source?.dispose?.()
    renderer.clearTextures()
    source = next instanceof NVSlide ? null : next
    slide =
      next instanceof NVSlide
        ? next
        : NVSlide.fromSource(next, { colorManagement: iccToggle.checked })
    slide.addEventListener('change', requestRender)
    opening = null
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
  const kind = files.length === 1 ? await sniff(first) : 'dicom'
  if (id !== openCount) return
  const openTiff = () =>
    void open(async () =>
      TiffSlideSource.fromGeoTIFF(await fromBlob(first), {
        id: first.name,
        pool,
      }),
    )
  if (kind === 'tiff') return openTiff()
  status.textContent = `Indexing ${files.length} files...`
  try {
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
const tiffOption = (path: string, note: string) =>
  new Option(
    `${path.split('/').pop()} (${note})`,
    path.startsWith('https:') ? path : HF + path,
  )
// Hosted DICOM-WSI manifests (dicom-wsi-range-v1), each naming its .dcm files.
const DICOM =
  'https://raw.githubusercontent.com/niivue/niivue-demo-images-lfs/main/streaming/dicom-wsi/'
const dicomOption = (dir: string, label: string) =>
  new Option(label, `${DICOM}${dir}/manifest.json`)
const group = (label: string, options: HTMLOptionElement[]) => {
  const g = Object.assign(document.createElement('optgroup'), { label })
  g.append(...options)
  return g
}
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

const openUrl = (url: string) => {
  showCurrent(url, url.split('/').pop() ?? url)
  return open(async (signal) => {
    // Inside the loader, so a malformed URL is reported in the status line.
    const href = new URL(url, location.href).href
    // ponytail: a .json path is a hosted DICOM-WSI manifest; sniff if names lie.
    if (!new URL(href).pathname.endsWith('.json'))
      return TiffSlideSource.fromUrl(href, { pool, signal })
    const response = await fetch(href, { signal })
    if (!response.ok) throw new Error(`Slide manifest HTTP ${response.status}`)
    // GitHub raw serves LFS pointers, so the listed manifests' relative .dcm
    // paths resolve against its media endpoint, which serves the LFS files.
    return new NVSlide(await response.json(), {
      colorManagement: iccToggle.checked,
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

let drag: { x: number; y: number } | null = null
canvas.addEventListener('pointerdown', (e) => {
  drag = { x: e.clientX, y: e.clientY }
  canvas.setPointerCapture(e.pointerId)
})
canvas.addEventListener('pointermove', (e) => {
  if (!drag || !slide) return
  slide.panByScreenDelta(e.clientX - drag.x, e.clientY - drag.y, screen())
  drag = { x: e.clientX, y: e.clientY }
  requestRender()
})
canvas.addEventListener('pointerup', () => {
  drag = null
})
canvas.addEventListener(
  'wheel',
  (e) => {
    e.preventDefault()
    if (!slide) return
    const rect = canvas.getBoundingClientRect()
    slide.zoomBy(
      Math.exp(-e.deltaY * 0.0013),
      e.clientX - rect.left,
      e.clientY - rect.top,
      screen(),
    )
    requestRender()
  },
  { passive: false },
)
window.addEventListener('resize', requestRender)

// Default slide so the Pages demo is not empty; ?url= (empty) starts blank.
const startUrl = params.get('url') ?? sourceSelect.options[0]?.value ?? ''
if (startUrl) void openUrl(startUrl)
else sourceSelect.value = ''

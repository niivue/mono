import type { NVSlideScreen, SlideTileSource } from '@niivue/niivue'
import { NVSlide, SlideRenderer } from '@niivue/niivue'
import {
  DicomWsiSource,
  indexDicomWsi,
  registerDcm2niixDecoders,
  type SlideIndex,
  TiffSlideSource,
} from '@niivue/nv-ext-wsi'
import { fromBlob, Pool } from 'geotiff'

const canvas = document.getElementById('canvas') as HTMLCanvasElement
const fileInput = document.getElementById('file') as HTMLInputElement
const folderInput = document.getElementById('folder') as HTMLInputElement
const slideSelect = document.getElementById('slides') as HTMLSelectElement
const urlInput = document.getElementById('url') as HTMLInputElement
const openButton = document.getElementById('open') as HTMLButtonElement
const status = document.getElementById('status') as HTMLSpanElement

const gl = canvas.getContext('webgl2', { alpha: false, antialias: false })
if (!gl) throw new Error('WebGL2 is not available')
const renderer = new SlideRenderer()
renderer.init(gl)
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
    devicePixelRatio: window.devicePixelRatio || 1,
  }
}

function render(): void {
  frame = 0
  if (!gl || !slide) return
  const s = screen()
  const dpr = s.devicePixelRatio ?? 1
  canvas.width = Math.max(1, Math.floor(s.widthCss * dpr))
  canvas.height = Math.max(1, Math.floor(s.heightCss * dpr))
  // Fit after the canvas is sized, so the first frame is centred.
  if (needsFit) slide.fitToScreen(s)
  needsFit = false
  slide.clampViewport(s)
  renderer.draw(gl, [slide], s)
  const { wireBytes, completed, failures } = slide.stats
  status.textContent = `${indexNote}${slide.name}: ${slide.manifest.levels.length} levels, ${completed} tiles, ${(wireBytes / 1e6).toFixed(1)} MB read, ${failures} failed`
}

function requestRender(): void {
  if (!frame) frame = requestAnimationFrame(render)
}

// Opens can overlap (a slow URL, then a local file); only the latest wins.
let openCount = 0
let opening: AbortController | null = null

async function open(
  load: (signal: AbortSignal) => Promise<Source>,
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
    source = next
    slide = NVSlide.fromSource(next)
    slide.addEventListener('change', requestRender)
    needsFit = true
    requestRender()
  } catch (err) {
    console.error(err)
    if (id !== openCount) return
    status.textContent = err instanceof Error ? err.message : String(err)
  }
}

fileInput.addEventListener('change', () => {
  const file = fileInput.files?.[0]
  indexNote = ''
  if (file) {
    void open(async () =>
      TiffSlideSource.fromGeoTIFF(await fromBlob(file), {
        id: file.name,
        pool,
      }),
    )
  }
})
// DICOM-WSI folder: index the headers (no pixel data), list the slides, open one.
// JPEG 2000 and JPEG-LS tiles decode in dcm2niix's WASM workers.
registerDcm2niixDecoders()
const SYNTAX: Record<string, string> = {
  '1.2.840.10008.1.2.4.50': 'JPEG',
  '1.2.840.10008.1.2.4.51': 'JPEG',
  '1.2.840.10008.1.2.4.80': 'JPEG-LS',
  '1.2.840.10008.1.2.4.81': 'JPEG-LS',
  '1.2.840.10008.1.2.4.90': 'JPEG 2000',
  '1.2.840.10008.1.2.4.91': 'JPEG 2000',
}
let folder: { index: SlideIndex; files: File[] } | null = null
let indexNote = '' // kept in the status line while a folder's slide is open

function openIndexed(i: number): void {
  const slide = folder?.index.slides[i]
  if (!folder || !slide) return
  const files = folder.files
  void open(async () => new DicomWsiSource(slide, files))
}

folderInput.addEventListener('change', async () => {
  const files = [...(folderInput.files ?? [])]
  if (!files.length) return
  status.textContent = `Indexing ${files.length} files...`
  try {
    const t0 = performance.now()
    const index = await indexDicomWsi(files)
    const ms = performance.now() - t0
    folder = { index, files }
    slideSelect.replaceChildren(
      ...index.slides.map((s, i) => {
        const l0 = s.levels[0]
        const frames = s.levels.reduce((n, l) => n + l.frames.offset.length, 0)
        const holes = s.levels.reduce(
          (n, l) => n + l.tile.filter((t) => t < 0).length,
          0,
        )
        const syntax = s.instances[0]?.transferSyntax ?? ''
        const option = document.createElement('option')
        option.value = String(i)
        option.textContent = `${s.container ?? s.series.slice(-12)} path ${s.opticalPath} z ${s.focalPlane}: ${s.levels.length} levels, ${l0?.width}x${l0?.height}, ${SYNTAX[syntax] ?? syntax}, ${l0?.sparse ? 'sparse' : 'full'}, ${frames} frames, ${holes} holes`
        return option
      }),
    )
    slideSelect.hidden = index.slides.length === 0
    const skipped = index.skipped.map((k) => `${k.file}: ${k.reason}`)
    status.title = skipped.join('\n')
    if (!index.slides.length) {
      status.textContent = `No tiled DICOM-WSI slide in ${files.length} files (${skipped.length} skipped).`
      return
    }
    indexNote = `Indexed in ${ms.toFixed(0)} ms (${skipped.length} files skipped). `
    openIndexed(0)
  } catch (err) {
    console.error(err)
    status.textContent = err instanceof Error ? err.message : String(err)
  }
})
slideSelect.addEventListener('change', () =>
  openIndexed(Number(slideSelect.value)),
)

const openUrl = (url: string) => {
  indexNote = ''
  return open((signal) => TiffSlideSource.fromUrl(url, { pool, signal }))
}
openButton.addEventListener('click', () => {
  if (urlInput.value) void openUrl(urlInput.value)
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

// Default slide so the Pages demo is not empty; GitHub LFS serves Range + CORS.
urlInput.value =
  new URLSearchParams(location.search).get('url') ??
  'https://media.githubusercontent.com/media/niivue/niivue-demo-images-lfs/main/streaming/svs/CMU-1-Small-Region.svs'
void openUrl(urlInput.value)

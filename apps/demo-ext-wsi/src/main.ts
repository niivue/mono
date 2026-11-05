import type { NVSlideScreen } from '@niivue/niivue'
import { NVSlide, SlideRenderer } from '@niivue/niivue'
import { TiffSlideSource } from '@niivue/nv-ext-wsi'
import { fromBlob, Pool } from 'geotiff'

const canvas = document.getElementById('canvas') as HTMLCanvasElement
const fileInput = document.getElementById('file') as HTMLInputElement
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
let source: TiffSlideSource | null = null
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
  status.textContent = `${slide.name}: ${slide.manifest.levels.length} levels, ${completed} tiles, ${(wireBytes / 1e6).toFixed(1)} MB read, ${failures} failed`
}

function requestRender(): void {
  if (!frame) frame = requestAnimationFrame(render)
}

// Opens can overlap (a slow URL, then a local file); only the latest wins.
let openCount = 0
let opening: AbortController | null = null

async function open(
  load: (signal: AbortSignal) => Promise<TiffSlideSource>,
): Promise<void> {
  const id = ++openCount
  opening?.abort()
  opening = new AbortController()
  status.textContent = 'Opening...'
  try {
    const next = await load(opening.signal)
    if (id !== openCount) {
      next.dispose()
      return
    }
    slide?.removeEventListener('change', requestRender)
    slide?.dispose()
    source?.dispose()
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
  if (file) {
    void open(async () =>
      TiffSlideSource.fromGeoTIFF(await fromBlob(file), {
        id: file.name,
        pool,
      }),
    )
  }
})
const openUrl = (url: string) =>
  open((signal) => TiffSlideSource.fromUrl(url, { pool, signal }))
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

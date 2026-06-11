// Whole-slide-image tile viewer built on the NVSlide core class.
//
// NVSlide owns the manifest/levels/tiles model, the viewport (pan/zoom), HTTP
// Range-request tile streaming, the ImageBitmap cache and request stats. This
// demo just wires DOM controls to it and draws it with a backend-selected
// renderer: SlideRenderer (WebGL2) or SlideRendererGPU (WebGPU). Add
// `?backend=webgpu` to the URL to use the WebGPU renderer.
//
// The synthetic pyramid (public/tile-range-poc/) streams one tile's worth of
// bytes at a time over HTTP 206 range requests, so a multi-gigabyte slide never
// has to be downloaded whole.
import { NVSlide, SlideRenderer, SlideRendererGPU } from '../src/index.ts'

const SYNTHETIC_MANIFEST_PATH = 'tile-range-poc/tiles.json'
// DICOM-WSI series downloaded + manifest-built by scripts/fetch-dicom-wsi.ts.
// The manifest is dicom-wsi-range-v1: per-level JPEG tiles addressed by byte
// offset, which NVSlide fetches over HTTP Range and decodes in-browser. Only
// present after running the fetch script (the fixture is gitignored).
const DICOM_WSI_PATH = 'dicom-wsi/cptac-brca/manifest.json'
const MAX_CACHE_BYTES = 96 * 1024 * 1024
const TARGET_SCREEN_PIXELS_PER_TILE_PIXEL = 0.75
const RANGE_LOG_LENGTH = 24

function el(id) {
  const node = document.getElementById(id)
  if (!node) throw new Error(`Missing #${id}`)
  return node
}

const els = {
  source: el('source'),
  levelMode: el('levelMode'),
  zoomOut: el('zoomOut'),
  zoomIn: el('zoomIn'),
  fit: el('fit'),
  showGrid: el('showGrid'),
  canvas: el('tileCanvas'),
  hud: el('hud'),
  rangeLog: el('rangeLog'),
  fallback: el('fallback'),
}

let view = null
let slide = null
let animationFrame = 0
let hasFit = false
let drag = null

function backendFromUrl() {
  const raw = new URLSearchParams(window.location.search).get('backend')
  return raw === 'webgpu' ? 'webgpu' : 'webgl2'
}

function manifestUrl() {
  const base = import.meta.env.BASE_URL || '/'
  const normalized = base.endsWith('/') ? base : `${base}/`
  const path =
    els.source.value === 'dicom-wsi' ? DICOM_WSI_PATH : SYNTHETIC_MANIFEST_PATH
  return new URL(`${normalized}${path}`, window.location.href).toString()
}

function html(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(2)} MB`
}

function screenForCanvas() {
  const rect = els.canvas.getBoundingClientRect()
  return {
    widthCss: rect.width,
    heightCss: rect.height,
    devicePixelRatio: window.devicePixelRatio || 1,
  }
}

function resizeCanvas(screen) {
  const dpr = screen.devicePixelRatio ?? 1
  const width = Math.max(1, Math.floor(screen.widthCss * dpr))
  const height = Math.max(1, Math.floor(screen.heightCss * dpr))
  if (els.canvas.width !== width || els.canvas.height !== height) {
    els.canvas.width = width
    els.canvas.height = height
  }
}

async function createView() {
  if (backendFromUrl() === 'webgpu' && 'gpu' in navigator) {
    const renderer = await SlideRendererGPU.create(els.canvas)
    if (renderer) return { kind: 'gpu', renderer }
    console.warn('WebGPU unavailable; falling back to WebGL2')
  }
  const gl = els.canvas.getContext('webgl2', { alpha: false, antialias: false })
  if (!gl) throw new Error('WebGL2 is not available')
  const renderer = new SlideRenderer()
  renderer.init(gl)
  return { kind: 'gl', gl, renderer }
}

function drawView(screen) {
  if (!view || !slide) return
  const slides = [slide]
  if (view.kind === 'gpu') {
    view.renderer.render(slides, screen)
  } else {
    view.renderer.draw(view.gl, slides, screen)
  }
}

function requestRender() {
  if (animationFrame !== 0) return
  animationFrame = window.requestAnimationFrame(() => {
    animationFrame = 0
    render()
  })
}

function render() {
  const screen = screenForCanvas()
  resizeCanvas(screen)
  if (slide && !hasFit) {
    slide.fitToScreen(screen)
    hasFit = true
  }
  if (slide) slide.clampViewport(screen)
  drawView(screen)
  updateHud(screen)
  updateRangeLog()
}

function updateHud(screen) {
  if (!slide) {
    els.hud.innerHTML = '<div class="title">Loading tile manifest</div>'
    return
  }
  const level = slide.selectLevel()
  if (!level) {
    els.hud.innerHTML = '<div class="title">Loading tile manifest</div>'
    return
  }
  const s = slide.stats
  const mode = slide.levelChoice === 'auto' ? 'auto' : 'fixed'
  const scale = slide.viewport.scale
  const zoom =
    scale >= 1 ? `${scale.toFixed(2)}x` : `1:${(1 / scale).toFixed(1)}`
  const visible = slide.visibleTiles(screen).tiles.length
  const codec = level.codec ?? 'raw-rgba'
  const backendLabel = view?.kind === 'gpu' ? 'WebGPU' : 'WebGL2'
  els.hud.innerHTML = `
    <div class="title">${html(slide.manifest.name)}</div>
    <div class="row"><span class="key">backend</span><span>${backendLabel}</span></div>
    <div class="row"><span class="key">source</span><span>${html(slide.sourceLabelForLevel(level))}</span></div>
    <div class="row"><span class="key">codec</span><span>${html(codec)}</span></div>
    <div class="row"><span class="key">level</span><span>L${level.index} ${mode} ${level.width}x${level.height}</span></div>
    <div class="row"><span class="key">zoom</span><span>${zoom}</span></div>
    <div class="row"><span class="key">tiles</span><span>${visible} visible, ${slide.pendingCount} pending</span></div>
    <div class="row"><span class="key">requests</span><span>${s.completed}/${s.requested} done</span></div>
    <div class="row"><span class="key">range</span><span class="ok">${s.rangeHits} HTTP 206</span></div>
    <div class="row"><span class="key">fallback</span><span class="${s.fullFileFallbacks > 0 ? 'warn' : ''}">${s.fullFileFallbacks} HTTP 200</span></div>
    <div class="row"><span class="key">wire</span><span>${formatBytes(s.wireBytes)}</span></div>
    <div class="row"><span class="key">cache</span><span>${formatBytes(s.cacheBytes)} / ${s.cacheHits} hits</span></div>
    <div class="row"><span class="key">failures</span><span class="${s.failures > 0 ? 'bad' : ''}">${s.failures}</span></div>
  `
}

function updateRangeLog() {
  const events = slide?.stats.lastRequests ?? []
  const spans = []
  for (let i = 0; i < RANGE_LOG_LENGTH - events.length; i++) {
    spans.push(document.createElement('span'))
  }
  for (const event of events) {
    const span = document.createElement('span')
    span.className = event.status === 'hit' ? 'hit' : event.status
    span.title = event.label
    spans.push(span)
  }
  els.rangeLog.replaceChildren(...spans)
}

function populateLevels(manifest) {
  els.levelMode.replaceChildren()
  const auto = document.createElement('option')
  auto.value = 'auto'
  auto.textContent = 'auto lod'
  els.levelMode.appendChild(auto)
  for (const level of manifest.levels) {
    const option = document.createElement('option')
    option.value = String(level.index)
    option.textContent = `L${level.index} ${level.width}x${level.height}`
    els.levelMode.appendChild(option)
  }
  els.levelMode.value = 'auto'
}

function showFallback(message) {
  els.fallback.textContent = message
  els.fallback.setAttribute('aria-hidden', 'false')
}

function zoomCentered(factor) {
  if (!slide) return
  const screen = screenForCanvas()
  slide.zoomBy(factor, screen.widthCss / 2, screen.heightCss / 2, screen)
}

els.canvas.addEventListener('pointerdown', (event) => {
  els.canvas.setPointerCapture(event.pointerId)
  drag = {
    pointerId: event.pointerId,
    lastX: event.clientX,
    lastY: event.clientY,
  }
})

els.canvas.addEventListener('pointermove', (event) => {
  if (!drag || drag.pointerId !== event.pointerId || !slide) return
  const dx = event.clientX - drag.lastX
  const dy = event.clientY - drag.lastY
  drag.lastX = event.clientX
  drag.lastY = event.clientY
  slide.panByScreenDelta(dx, dy, screenForCanvas())
})

els.canvas.addEventListener('pointerup', (event) => {
  if (drag?.pointerId === event.pointerId) drag = null
})

els.canvas.addEventListener('pointercancel', (event) => {
  if (drag?.pointerId === event.pointerId) drag = null
})

els.canvas.addEventListener(
  'wheel',
  (event) => {
    event.preventDefault()
    if (!slide) return
    const rect = els.canvas.getBoundingClientRect()
    slide.zoomBy(
      Math.exp(-event.deltaY * 0.0013),
      event.clientX - rect.left,
      event.clientY - rect.top,
      screenForCanvas(),
    )
  },
  { passive: false },
)

els.levelMode.addEventListener('change', () => {
  slide?.setLevelChoice(
    els.levelMode.value === 'auto' ? 'auto' : Number(els.levelMode.value),
  )
})
els.showGrid.addEventListener('change', () => {
  slide?.setTileGridVisible(els.showGrid.checked)
})
els.fit.addEventListener('click', () => slide?.fitToScreen(screenForCanvas()))
els.zoomIn.addEventListener('click', () => zoomCentered(1.45))
els.zoomOut.addEventListener('click', () => zoomCentered(1 / 1.45))
els.source.addEventListener('change', () => {
  void loadSlide()
})
window.addEventListener('resize', requestRender)

async function loadSlide() {
  els.fallback.setAttribute('aria-hidden', 'true')
  els.fallback.textContent = ''
  slide = null
  hasFit = false
  try {
    const next = await NVSlide.fromManifestUrl(manifestUrl(), {
      maxCacheBytes: MAX_CACHE_BYTES,
      targetScreenPixelsPerTilePixel: TARGET_SCREEN_PIXELS_PER_TILE_PIXEL,
      showTileGrid: els.showGrid.checked,
    })
    next.addEventListener('change', requestRender)
    slide = next
    populateLevels(slide.manifest)
    requestRender()
  } catch (err) {
    console.error(err)
    const hint =
      els.source.value === 'dicom-wsi'
        ? ' Did you run scripts/fetch-dicom-wsi.ts?'
        : ''
    showFallback((err instanceof Error ? err.message : String(err)) + hint)
  }
}

async function main() {
  view = await createView()
  await loadSlide()
}

main().catch((err) => {
  console.error(err)
  showFallback(err instanceof Error ? err.message : String(err))
})

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
import {
  buildDrawingLut,
  DziSource,
  drawingBitmapToRGBA,
  lookupColorMap,
  NVSlide,
  SlideDrawing,
  SlideRenderer,
  SlideRendererGPU,
} from '../src/index.ts'
import { decodeJp2 } from './openjpeg-decoder.js'
import { createTiffSource } from './tiff-source.js'

// DZI sources construct via NVSlide.fromSource(DziSource.fromUrl(...)) rather
// than a manifest URL. This OpenSeadragon example (overlap 2) is CORS-enabled.
const DZI_URLS = {
  'dzi-highsmith':
    'https://openseadragon.github.io/example-images/highsmith/highsmith.dzi',
}

// TIFF/SVS sources build a geotiff-backed SlideTileSource. The OpenSlide server
// has no CORS, so the .svs must be served same-origin (public/svs/, gitignored).
const TIFF_URLS = {
  'tiff-cmu1': 'svs/CMU-1-Small-Region.svs',
}

// NVSlide core ships no JPEG 2000 codec; register an OpenJPEG WASM decoder so
// image/jp2 tiles (OpenSlide DICOM JP2K archives) decode in-browser.
NVSlide.registerTileDecoder('image/jp2', decodeJp2)

const SYNTHETIC_MANIFEST_PATH = 'tile-range-poc/tiles.json'
// DICOM-WSI series downloaded + manifest-built by scripts/fetch-dicom-wsi.ts.
// The manifest is dicom-wsi-range-v1: per-level JPEG tiles addressed by byte
// offset, which NVSlide fetches over HTTP Range and decodes in-browser. Only
// present after running the fetch script (the fixture is gitignored).
const DICOM_WSI_PATH = 'dicom-wsi/cptac-brca/manifest.json'
// Manifest path per source-dropdown value. OpenSlide DICOM-WSI archives are
// fetched + manifest-built by scripts/fetch-openslide-dicom.ts (gitignored);
// only the JPEG TILED_FULL ones are loadable in-browser (see that script).
const MANIFEST_PATHS = {
  synthetic: SYNTHETIC_MANIFEST_PATH,
  'dicom-wsi': DICOM_WSI_PATH,
  'openslide-3dhistech-1': 'dicom-wsi/3dhistech-1/manifest.json',
  'openslide-hamamatsu-2': 'dicom-wsi/hamamatsu-2/manifest.json',
  'openslide-jp2k-33003-1': 'dicom-wsi/jp2k-33003-1/manifest.json',
}
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
  overlay: el('drawOverlay'),
  drawBtn: el('drawBtn'),
  penValue: el('penValue'),
  drawUndo: el('drawUndo'),
  drawClear: el('drawClear'),
  hud: el('hud'),
  rangeLog: el('rangeLog'),
  fallback: el('fallback'),
}

let view = null
let slide = null
let animationFrame = 0
let hasFit = false
let drag = null
// Slide-space drawing: a SlideDrawing raster (painted with the shared pen tools,
// in slide pixels) shown via a stacked Canvas2D overlay mapped through NVSlide's
// screen<->slide transform, so the annotation stays registered under pan/zoom.
const DRAW_RASTER_CAP = 1536
let drawing = null
let drawMode = false
let drawStroke = null // { pointerId } while a stroke is in progress
let lastRasterPt = null
let overlayDirty = false
let rasterCanvas = null
let rasterCtx = null
let rasterImageData = null
let penValue = 1
// The shared "_draw" label colormap, so annotation colors match the 3D demo and
// each pen value paints a distinct label color. Resolved lazily (Vite glob).
let drawLut = null
const DRAW_OPACITY = 0.85

function backendFromUrl() {
  const raw = new URLSearchParams(window.location.search).get('backend')
  return raw === 'webgpu' ? 'webgpu' : 'webgl2'
}

function resolveDemoUrl(path) {
  const base = import.meta.env.BASE_URL || '/'
  const normalized = base.endsWith('/') ? base : `${base}/`
  return new URL(`${normalized}${path}`, window.location.href).toString()
}

function manifestUrl() {
  return resolveDemoUrl(
    MANIFEST_PATHS[els.source.value] ?? SYNTHETIC_MANIFEST_PATH,
  )
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
  drawOverlay(screen)
  updateHud(screen)
  updateRangeLog()
}

// Build (or rebuild) the slide-space drawing raster for the active slide.
function ensureDrawing() {
  if (!slide) {
    drawing = null
    return
  }
  const sw = slide.manifest.width
  const sh = slide.manifest.height
  const scale = Math.min(1, DRAW_RASTER_CAP / Math.max(1, sw, sh))
  const rw = Math.max(1, Math.round(sw * scale))
  const rh = Math.max(1, Math.round(sh * scale))
  drawing = new SlideDrawing(rw, rh)
  lastRasterPt = null
  rasterCanvas = document.createElement('canvas')
  rasterCanvas.width = rw
  rasterCanvas.height = rh
  rasterCtx = rasterCanvas.getContext('2d')
  rasterImageData = rasterCtx.createImageData(rw, rh)
  overlayDirty = true
}

// Repaint the offscreen raster from the label bitmap via the "_draw" LUT, so
// each pen value shows its label color (same palette as the 3D slide demo).
function rebuildRaster() {
  if (!drawing || !rasterCtx || !rasterImageData) return
  if (!drawLut) {
    const cm = lookupColorMap('_draw')
    if (cm) drawLut = buildDrawingLut(cm)
  }
  const data = rasterImageData.data
  if (drawLut) {
    const rgba = drawingBitmapToRGBA(
      drawing.img,
      drawLut.lut,
      drawLut.min ?? 0,
      DRAW_OPACITY,
    )
    data.set(rgba)
  } else {
    // Fallback if the colormap isn't available: single color.
    const img = drawing.img
    for (let i = 0; i < img.length; i++) {
      const o = i * 4
      if (img[i]) {
        data[o] = 235
        data[o + 1] = 45
        data[o + 2] = 55
        data[o + 3] = 210
      } else {
        data[o + 3] = 0
      }
    }
  }
  rasterCtx.putImageData(rasterImageData, 0, 0)
}

// Inverse of NVSlide.screenToSlide: slide base pixel -> canvas CSS coords.
function slideToCss(sx, sy, screen) {
  const vp = slide.viewport
  const sc = vp.scale
  const leftSlide = vp.centerX - screen.widthCss / (2 * sc)
  const xCss = (sx - leftSlide) * sc
  const yCss = slide.isYAxisUp()
    ? screen.heightCss / 2 - (sy - vp.centerY) * sc
    : (sy - (vp.centerY - screen.heightCss / (2 * sc))) * sc
  return [xCss, yCss]
}

// Draw the annotation raster over the tiles, mapped to the current viewport.
function drawOverlay(screen) {
  const ov = els.overlay
  if (ov.width !== els.canvas.width || ov.height !== els.canvas.height) {
    ov.width = els.canvas.width
    ov.height = els.canvas.height
  }
  const octx = ov.getContext('2d')
  octx.clearRect(0, 0, ov.width, ov.height)
  if (!slide || !drawing) return
  if (overlayDirty) {
    rebuildRaster()
    overlayDirty = false
  }
  const dpr = screen.devicePixelRatio ?? 1
  const sw = slide.manifest.width
  const sh = slide.manifest.height
  const [x0, y0] = slideToCss(0, 0, screen)
  const [x1, y1] = slideToCss(sw, sh, screen)
  const dx = Math.min(x0, x1) * dpr
  const dy = Math.min(y0, y1) * dpr
  const dW = Math.abs(x1 - x0) * dpr
  const dH = Math.abs(y1 - y0) * dpr
  octx.imageSmoothingEnabled = false
  if (y0 > y1) {
    // yAxis up: slide row 0 is at the bottom — flip vertically.
    octx.save()
    octx.translate(0, dy + dH)
    octx.scale(1, -1)
    octx.drawImage(rasterCanvas, dx, 0, dW, dH)
    octx.restore()
  } else {
    octx.drawImage(rasterCanvas, dx, dy, dW, dH)
  }
}

// Convert a pointer event to a slide-drawing raster pixel, or null if off-slide.
function eventToRaster(event) {
  if (!slide || !drawing) return null
  const rect = els.canvas.getBoundingClientRect()
  const sp = slide.screenToSlide(
    event.clientX - rect.left,
    event.clientY - rect.top,
    screenForCanvas(),
  )
  const rx = Math.round((sp.x / slide.manifest.width) * drawing.width)
  const ry = Math.round((sp.y / slide.manifest.height) * drawing.height)
  if (rx < 0 || ry < 0 || rx >= drawing.width || ry >= drawing.height) {
    return null
  }
  return [rx, ry]
}

function penSizeForRaster() {
  return Math.max(2, Math.round(drawing.width / 300))
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
  auto.textContent = 'auto LOD'
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

// Let the user drag a floating panel (the HUD) out of the way of a tile.
// Switches the element to left/top positioning and clamps it to the viewport.
function makeDraggable(node) {
  let dragging = null
  node.addEventListener('pointerdown', (event) => {
    if (event.button !== 0) return
    const rect = node.getBoundingClientRect()
    dragging = {
      pointerId: event.pointerId,
      offsetX: event.clientX - rect.left,
      offsetY: event.clientY - rect.top,
    }
    node.setPointerCapture(event.pointerId)
    node.classList.add('dragging')
  })
  node.addEventListener('pointermove', (event) => {
    if (!dragging || dragging.pointerId !== event.pointerId) return
    const width = node.offsetWidth
    const height = node.offsetHeight
    const maxX = Math.max(0, window.innerWidth - width)
    const maxY = Math.max(0, window.innerHeight - height)
    const x = Math.min(maxX, Math.max(0, event.clientX - dragging.offsetX))
    const y = Math.min(maxY, Math.max(0, event.clientY - dragging.offsetY))
    node.style.left = `${x}px`
    node.style.top = `${y}px`
    node.style.right = 'auto'
    node.style.bottom = 'auto'
  })
  const end = (event) => {
    if (!dragging || dragging.pointerId !== event.pointerId) return
    dragging = null
    node.classList.remove('dragging')
  }
  node.addEventListener('pointerup', end)
  node.addEventListener('pointercancel', end)
}

function zoomCentered(factor) {
  if (!slide) return
  const screen = screenForCanvas()
  slide.zoomBy(factor, screen.widthCss / 2, screen.heightCss / 2, screen)
}

els.canvas.addEventListener('pointerdown', (event) => {
  els.canvas.setPointerCapture(event.pointerId)
  // Draw mode paints the slide instead of panning.
  if (drawMode && drawing) {
    const pt = eventToRaster(event)
    drawStroke = { pointerId: event.pointerId }
    if (pt) {
      drawing.beginStroke()
      drawing.point(pt[0], pt[1], penValue, penSizeForRaster(), true)
      lastRasterPt = pt
      overlayDirty = true
      requestRender()
    }
    return
  }
  drag = {
    pointerId: event.pointerId,
    lastX: event.clientX,
    lastY: event.clientY,
  }
})

els.canvas.addEventListener('pointermove', (event) => {
  if (drawStroke && drawStroke.pointerId === event.pointerId) {
    const pt = eventToRaster(event)
    if (pt) {
      if (lastRasterPt) {
        drawing.line(
          lastRasterPt[0],
          lastRasterPt[1],
          pt[0],
          pt[1],
          penValue,
          penSizeForRaster(),
          true,
        )
      } else {
        drawing.point(pt[0], pt[1], penValue, penSizeForRaster(), true)
      }
      lastRasterPt = pt
      overlayDirty = true
      requestRender()
    }
    return
  }
  if (!drag || drag.pointerId !== event.pointerId || !slide) return
  const dx = event.clientX - drag.lastX
  const dy = event.clientY - drag.lastY
  drag.lastX = event.clientX
  drag.lastY = event.clientY
  slide.panByScreenDelta(dx, dy, screenForCanvas())
})

els.canvas.addEventListener('pointerup', (event) => {
  if (drawStroke?.pointerId === event.pointerId) {
    drawStroke = null
    lastRasterPt = null
  }
  if (drag?.pointerId === event.pointerId) drag = null
})

els.canvas.addEventListener('pointercancel', (event) => {
  if (drawStroke?.pointerId === event.pointerId) {
    drawStroke = null
    lastRasterPt = null
  }
  if (drag?.pointerId === event.pointerId) drag = null
})

els.drawBtn.addEventListener('click', () => {
  drawMode = !drawMode
  els.drawBtn.textContent = `Draw: ${drawMode ? 'on' : 'off'}`
  els.canvas.style.cursor = drawMode ? 'crosshair' : 'grab'
})
els.penValue.addEventListener('change', () => {
  penValue = Number(els.penValue.value) || 1
})
els.drawUndo.addEventListener('click', () => {
  if (drawing?.undo()) {
    overlayDirty = true
    requestRender()
  }
})
els.drawClear.addEventListener('click', () => {
  if (drawing) {
    drawing.clear()
    overlayDirty = true
    requestRender()
  }
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
    const opts = {
      maxCacheBytes: MAX_CACHE_BYTES,
      targetScreenPixelsPerTilePixel: TARGET_SCREEN_PIXELS_PER_TILE_PIXEL,
      showTileGrid: els.showGrid.checked,
    }
    const dziUrl = DZI_URLS[els.source.value]
    const tiffUrl = TIFF_URLS[els.source.value]
    let next
    if (dziUrl) {
      next = NVSlide.fromSource(await DziSource.fromUrl(dziUrl), opts)
    } else if (tiffUrl) {
      next = NVSlide.fromSource(
        await createTiffSource(resolveDemoUrl(tiffUrl)),
        opts,
      )
    } else {
      next = await NVSlide.fromManifestUrl(manifestUrl(), opts)
    }
    next.addEventListener('change', requestRender)
    slide = next
    ensureDrawing()
    populateLevels(slide.manifest)
    requestRender()
  } catch (err) {
    console.error(err)
    const src = els.source.value
    const hint = src.startsWith('openslide-')
      ? ` Did you run scripts/fetch-openslide-dicom.ts --slide=${src.replace('openslide-', '')}?`
      : src === 'dicom-wsi'
        ? ' Did you run scripts/fetch-dicom-wsi.ts?'
        : ''
    showFallback((err instanceof Error ? err.message : String(err)) + hint)
  }
}

async function main() {
  makeDraggable(els.hud)
  view = await createView()
  await loadSlide()
}

main().catch((err) => {
  console.error(err)
  showFallback(err instanceof Error ? err.message : String(err))
})

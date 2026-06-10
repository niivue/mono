// Texture stitching diagnostic.
//
// A single source RGBA test pattern is split into NxN GPU textures. Each tile
// is drawn as its own quad in screen-adjacent positions; a global shear matrix
// applies to all quads together so the same sample geometry can be inspected
// at every interior boundary at once.
//
// The settings exposed in the toolbar are the four knobs that drive boundary
// artifacts under linear interpolation:
//   - filter mode (LINEAR/NEAREST)
//   - wrap mode  (CLAMP_TO_EDGE/REPEAT)
//   - overlap padding in source pixels (0/1/2/4) — the textbook fix: each
//     tile's texture carries `p` extra pixels of its neighbour's data on
//     each side, so when a shear-skewed sample lands just past the inner
//     rect it reads the right neighbour's pixel instead of clamping to
//     this tile's edge.
//   - tile count — more tiles = more interior boundaries to check
//
// Reference mode (a single texture covering the full image) renders the same
// pattern under the same shear, with no internal seams, so the eye has a
// known-good A/B comparison.

import { installNav } from './nav'

installNav()

const SOURCE_SIZE = 768
const VIEWPORT_FILL = 0.86 // fraction of canvas the image occupies at zoom=1

type SyntheticPattern = 'gradient' | 'grid' | 'checker' | 'rings' | 'noise'
type ImageKey = 'cytology'
type Source = ImageKey | SyntheticPattern
type Filter = 'linear' | 'nearest'
type Wrap = 'clamp' | 'repeat'

// Hi-resolution images bundled in this app's public/textures/ dir. Adding an
// entry here, plus a matching <option> in the Image select in stitch.html, is
// all that's needed to expose a new image.
type ImageSpec = { url: string; label: string }
const IMAGE_SOURCES: Record<ImageKey, ImageSpec> = {
  cytology: {
    url: '/textures/cytology-peritoneal-fluid.jpg',
    label: 'Cytology peritoneal fluid (4272×2848)',
  },
}

function isImageKey(s: string): s is ImageKey {
  return s in IMAGE_SOURCES
}

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id)
  if (!el) throw new Error(`Missing #${id}`)
  return el as T
}

const els = {
  canvas: $<HTMLCanvasElement>('gl-canvas'),
  statusPill: $<HTMLSpanElement>('statusPill'),
  imageSelect: $<HTMLSelectElement>('imageSelect'),
  patternSelect: $<HTMLSelectElement>('patternSelect'),
  tilesSelect: $<HTMLSelectElement>('tilesSelect'),
  filterSelect: $<HTMLSelectElement>('filterSelect'),
  wrapSelect: $<HTMLSelectElement>('wrapSelect'),
  overlapSelect: $<HTMLSelectElement>('overlapSelect'),
  shearX: $<HTMLInputElement>('shearX'),
  shearY: $<HTMLInputElement>('shearY'),
  zoom: $<HTMLInputElement>('zoom'),
  shearXNum: $<HTMLSpanElement>('shearXNum'),
  shearYNum: $<HTMLSpanElement>('shearYNum'),
  zoomNum: $<HTMLSpanElement>('zoomNum'),
  showBorders: $<HTMLInputElement>('showBorders'),
  reference: $<HTMLInputElement>('reference'),
  hud: $<HTMLDivElement>('hud'),
}

const gl = els.canvas.getContext('webgl2', {
  antialias: false,
  preserveDrawingBuffer: false,
})
if (!gl) throw new Error('WebGL2 not available')
const MAX_TEX = gl.getParameter(gl.MAX_TEXTURE_SIZE) as number

// --- Shaders ---------------------------------------------------------------

const VS = `#version 300 es
in vec2 a_pos;
in vec2 a_uv;
uniform mat3 u_mvp;
out vec2 v_uv;
void main() {
  vec3 p = u_mvp * vec3(a_pos, 1.0);
  gl_Position = vec4(p.xy, 0.0, 1.0);
  v_uv = a_uv;
}`

const FS = `#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
out vec4 outColor;
void main() {
  outColor = texture(u_tex, v_uv);
}`

const LINE_VS = `#version 300 es
in vec2 a_pos;
uniform mat3 u_mvp;
void main() {
  vec3 p = u_mvp * vec3(a_pos, 1.0);
  gl_Position = vec4(p.xy, 0.0, 1.0);
}`

const LINE_FS = `#version 300 es
precision highp float;
uniform vec4 u_color;
out vec4 outColor;
void main() {
  outColor = u_color;
}`

function compile(type: number, src: string): WebGLShader {
  if (!gl) throw new Error('no gl')
  const sh = gl.createShader(type)
  if (!sh) throw new Error('createShader failed')
  gl.shaderSource(sh, src)
  gl.compileShader(sh)
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    const log = gl.getShaderInfoLog(sh) ?? '(no log)'
    gl.deleteShader(sh)
    throw new Error(`shader compile failed: ${log}`)
  }
  return sh
}

function link(vs: string, fs: string): WebGLProgram {
  if (!gl) throw new Error('no gl')
  const prog = gl.createProgram()
  if (!prog) throw new Error('createProgram failed')
  gl.attachShader(prog, compile(gl.VERTEX_SHADER, vs))
  gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, fs))
  gl.linkProgram(prog)
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
    const log = gl.getProgramInfoLog(prog) ?? '(no log)'
    gl.deleteProgram(prog)
    throw new Error(`program link failed: ${log}`)
  }
  return prog
}

const texProg = link(VS, FS)
const texAPos = gl.getAttribLocation(texProg, 'a_pos')
const texAUv = gl.getAttribLocation(texProg, 'a_uv')
const texUMvp = gl.getUniformLocation(texProg, 'u_mvp')
const texUTex = gl.getUniformLocation(texProg, 'u_tex')

const lineProg = link(LINE_VS, LINE_FS)
const lineAPos = gl.getAttribLocation(lineProg, 'a_pos')
const lineUMvp = gl.getUniformLocation(lineProg, 'u_mvp')
const lineUColor = gl.getUniformLocation(lineProg, 'u_color')

// --- Source pattern --------------------------------------------------------

// Master RGBA8 source image (CPU-side; persists across pattern switches so
// the tile rebuild path can re-slice from the same buffer). Generated
// patterns are SOURCE_SIZE x SOURCE_SIZE; image-backed patterns (e.g.
// 'cytology') keep their native dimensions, so sourceW / sourceH are tracked
// separately rather than assumed equal to SOURCE_SIZE.
let sourcePixels: Uint8Array = generatePattern('gradient', SOURCE_SIZE)
let sourceW = SOURCE_SIZE
let sourceH = SOURCE_SIZE

function generatePattern(kind: SyntheticPattern, size: number): Uint8Array {
  const buf = new Uint8Array(size * size * 4)
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const o = (y * size + x) * 4
      const fx = x / (size - 1)
      const fy = y / (size - 1)
      let r = 0
      let g = 0
      let b = 0
      switch (kind) {
        case 'gradient': {
          // Smooth diagonal gradient — any luminance step at a tile boundary
          // is immediately obvious to the eye.
          r = Math.round(fx * 255)
          g = Math.round(fy * 255)
          b = Math.round((1 - fx * 0.5 - fy * 0.5) * 255)
          break
        }
        case 'grid': {
          // 1px black lines on a coloured field every 32 source px. Linear
          // interp across a tile seam softens these lines unevenly compared
          // to interior lines.
          const step = 32
          const onLine = x % step === 0 || y % step === 0
          if (onLine) {
            r = 0
            g = 0
            b = 0
          } else {
            r = 200
            g = 210
            b = 215
          }
          break
        }
        case 'checker': {
          const cell = 24
          const cx = Math.floor(x / cell)
          const cy = Math.floor(y / cell)
          const on = (cx + cy) % 2 === 0
          r = on ? 230 : 20
          g = on ? 230 : 20
          b = on ? 230 : 20
          break
        }
        case 'rings': {
          // Concentric rings around the center — exposes both axis-aligned
          // and oblique tile boundaries with the same pattern.
          const cx = (size - 1) / 2
          const cy = (size - 1) / 2
          const dx = x - cx
          const dy = y - cy
          const d = Math.sqrt(dx * dx + dy * dy)
          const t = (Math.sin(d * 0.18) + 1) * 0.5
          r = Math.round(t * 255)
          g = Math.round(t * 180)
          b = Math.round((1 - t) * 200)
          break
        }
        case 'noise': {
          // Deterministic high-frequency noise — every pixel has a unique
          // color so a seam shows as a 1-pixel-wide tonal discontinuity.
          const h = hash2d(x, y)
          r = (h >> 16) & 0xff
          g = (h >> 8) & 0xff
          b = h & 0xff
          break
        }
      }
      buf[o] = r
      buf[o + 1] = g
      buf[o + 2] = b
      buf[o + 3] = 255
    }
  }
  return buf
}

function hash2d(x: number, y: number): number {
  let h = (x * 374761393 + y * 668265263) | 0
  h = (h ^ (h >>> 13)) * 1274126177
  return (h ^ (h >>> 16)) >>> 0
}

// --- Tile management -------------------------------------------------------

type Tile = {
  texture: WebGLTexture
  // Inner-rect placement in source pixels (the quad covers exactly this rect
  // in normalized world space — the texture may extend past it with overlap).
  innerX0: number
  innerY0: number
  innerX1: number
  innerY1: number
  // Texture dimensions in source pixels (inner rect plus overlap on each side
  // where the source extends that far; clamped at image edges).
  texW: number
  texH: number
  // Where the inner rect lives within the texture in normalized texture coords.
  uInner0: number
  uInner1: number
  vInner0: number
  vInner1: number
}

let tiles: Tile[] = []
let refTexture: WebGLTexture | null = null

const quadVbo = gl.createBuffer()
if (!quadVbo) throw new Error('createBuffer failed')
const quadVao = gl.createVertexArray()
if (!quadVao) throw new Error('createVertexArray failed')

const lineVbo = gl.createBuffer()
if (!lineVbo) throw new Error('createBuffer failed')
const lineVao = gl.createVertexArray()
if (!lineVao) throw new Error('createVertexArray failed')

function rebuildTiles(nx: number, ny: number, overlapPx: number): void {
  if (!gl) return
  disposeTiles()
  const W = sourceW
  const H = sourceH
  const tw = W / nx
  const th = H / ny
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      // Inner (non-overlap) rect, in floating-point source pixels.
      const innerX0 = i * tw
      const innerY0 = j * th
      const innerX1 = (i + 1) * tw
      const innerY1 = (j + 1) * th
      // Outer rect (texture extent), in integer source pixels, clamped to
      // image bounds. The non-integer split position from tw/th is rounded
      // to the nearest pixel — this keeps inner-rect boundaries at integer
      // pixels so the inner uv math doesn't drift.
      const ix0 = Math.round(innerX0)
      const iy0 = Math.round(innerY0)
      const ix1 = Math.round(innerX1)
      const iy1 = Math.round(innerY1)
      const ox0 = Math.max(0, ix0 - overlapPx)
      const oy0 = Math.max(0, iy0 - overlapPx)
      const ox1 = Math.min(W, ix1 + overlapPx)
      const oy1 = Math.min(H, iy1 + overlapPx)
      const texW = ox1 - ox0
      const texH = oy1 - oy0
      const pixels = slicePixels(sourcePixels, W, H, ox0, oy0, texW, texH)
      const texture = uploadTexture(pixels, texW, texH)
      tiles.push({
        texture,
        innerX0: ix0,
        innerY0: iy0,
        innerX1: ix1,
        innerY1: iy1,
        texW,
        texH,
        uInner0: (ix0 - ox0) / texW,
        uInner1: (ix1 - ox0) / texW,
        vInner0: (iy0 - oy0) / texH,
        vInner1: (iy1 - oy0) / texH,
      })
    }
  }
  if (refTexture) gl.deleteTexture(refTexture)
  // Reference texture is a single upload of the full source. Skip if it would
  // exceed MAX_TEXTURE_SIZE on this device (typical desktop limit is 16384,
  // mobile is often 4096). Tile textures are smaller, so they're unaffected.
  if (W <= MAX_TEX && H <= MAX_TEX) {
    refTexture = uploadTexture(sourcePixels, W, H)
  } else {
    refTexture = null
  }
}

function slicePixels(
  src: Uint8Array,
  srcW: number,
  _srcH: number,
  x0: number,
  y0: number,
  w: number,
  h: number,
): Uint8Array {
  const out = new Uint8Array(w * h * 4)
  for (let row = 0; row < h; row++) {
    const srcOff = ((y0 + row) * srcW + x0) * 4
    const dstOff = row * w * 4
    out.set(src.subarray(srcOff, srcOff + w * 4), dstOff)
  }
  return out
}

function uploadTexture(pixels: Uint8Array, w: number, h: number): WebGLTexture {
  if (!gl) throw new Error('no gl')
  const tex = gl.createTexture()
  if (!tex) throw new Error('createTexture failed')
  gl.bindTexture(gl.TEXTURE_2D, tex)
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1)
  gl.texImage2D(
    gl.TEXTURE_2D,
    0,
    gl.RGBA,
    w,
    h,
    0,
    gl.RGBA,
    gl.UNSIGNED_BYTE,
    pixels,
  )
  return tex
}

function disposeTiles(): void {
  if (!gl) return
  for (const t of tiles) gl.deleteTexture(t.texture)
  tiles = []
}

function applyFilter(tex: WebGLTexture, filter: Filter, wrap: Wrap): void {
  if (!gl) return
  gl.bindTexture(gl.TEXTURE_2D, tex)
  const f = filter === 'linear' ? gl.LINEAR : gl.NEAREST
  const w = wrap === 'clamp' ? gl.CLAMP_TO_EDGE : gl.REPEAT
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, f)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, f)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, w)
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, w)
}

// --- Geometry --------------------------------------------------------------

function setupQuadVao(): void {
  if (!gl) return
  gl.bindVertexArray(quadVao)
  gl.bindBuffer(gl.ARRAY_BUFFER, quadVbo)
  gl.enableVertexAttribArray(texAPos)
  gl.vertexAttribPointer(texAPos, 2, gl.FLOAT, false, 16, 0)
  gl.enableVertexAttribArray(texAUv)
  gl.vertexAttribPointer(texAUv, 2, gl.FLOAT, false, 16, 8)
  gl.bindVertexArray(null)
}

function setupLineVao(): void {
  if (!gl) return
  gl.bindVertexArray(lineVao)
  gl.bindBuffer(gl.ARRAY_BUFFER, lineVbo)
  gl.enableVertexAttribArray(lineAPos)
  gl.vertexAttribPointer(lineAPos, 2, gl.FLOAT, false, 8, 0)
  gl.bindVertexArray(null)
}

setupQuadVao()
setupLineVao()

// Build a triangle-strip-of-two-triangles for a quad placed at world rect
// [x0, y0, x1, y1] (with y0 bottom) and texture-coord rect [u0, v0, u1, v1].
function quadAttribs(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  u0: number,
  v0: number,
  u1: number,
  v1: number,
): Float32Array {
  // Two triangles: (x0,y0)-(x1,y0)-(x0,y1) and (x1,y0)-(x1,y1)-(x0,y1)
  return new Float32Array([
    x0,
    y0,
    u0,
    v0,
    x1,
    y0,
    u1,
    v0,
    x0,
    y1,
    u0,
    v1,
    x1,
    y0,
    u1,
    v0,
    x1,
    y1,
    u1,
    v1,
    x0,
    y1,
    u0,
    v1,
  ])
}

// --- Math ------------------------------------------------------------------

// 3x3 column-major matrix multiplication.
function mat3Mul(a: Float32Array, b: Float32Array): Float32Array {
  const out = new Float32Array(9)
  for (let r = 0; r < 3; r++) {
    for (let c = 0; c < 3; c++) {
      let s = 0
      for (let k = 0; k < 3; k++) {
        s += a[r + k * 3] * b[k + c * 3]
      }
      out[r + c * 3] = s
    }
  }
  return out
}

function mat3Identity(): Float32Array {
  const m = new Float32Array(9)
  m[0] = 1
  m[4] = 1
  m[8] = 1
  return m
}

function mat3Scale(sx: number, sy: number): Float32Array {
  const m = mat3Identity()
  m[0] = sx
  m[4] = sy
  return m
}

function mat3Shear(shx: number, shy: number): Float32Array {
  // [ 1   shx 0 ]
  // [ shy 1   0 ]
  // [ 0   0   1 ]  in column-major: [1, shy, 0,  shx, 1, 0,  0, 0, 1]
  const m = mat3Identity()
  m[3] = shx
  m[1] = shy
  return m
}

// --- State -----------------------------------------------------------------

type State = {
  // What's actually displayed right now (could be a synthetic pattern or
  // an image, depending on the most recent successful load).
  source: Source
  // Last-chosen synthetic pattern from the Pattern select (so we can fall
  // back to it when the image select is cleared).
  syntheticPattern: SyntheticPattern
  // Currently selected image key, or null when the image select is on
  // "(none)" — in which case the synthetic pattern is shown.
  imageKey: ImageKey | null
  nTiles: number
  filter: Filter
  wrap: Wrap
  overlap: number
  shearX: number
  shearY: number
  zoom: number
  showBorders: boolean
  reference: boolean
}

const state: State = {
  source: 'gradient',
  syntheticPattern: 'gradient',
  imageKey: null,
  nTiles: 3,
  filter: 'linear',
  wrap: 'clamp',
  overlap: 0,
  shearX: 0,
  shearY: 0,
  zoom: 1,
  showBorders: false,
  reference: false,
}

let needsRebuild = true

// --- Image loading ---------------------------------------------------------

// Decode a JPEG/PNG to RGBA8 via the browser, then read the pixels out of a
// 2D canvas. Used for image-backed sources (e.g. 'cytology').
async function loadImageRgba(
  url: string,
): Promise<{ pixels: Uint8Array; w: number; h: number }> {
  const img = new Image()
  img.crossOrigin = 'anonymous'
  await new Promise<void>((resolve, reject) => {
    img.onload = () => {
      resolve()
    }
    img.onerror = () => {
      reject(new Error(`failed to load ${url}`))
    }
    img.src = url
  })
  const w = img.naturalWidth
  const h = img.naturalHeight
  const off = document.createElement('canvas')
  off.width = w
  off.height = h
  const ctx = off.getContext('2d')
  if (!ctx) throw new Error('2d context unavailable')
  ctx.drawImage(img, 0, 0)
  const data = ctx.getImageData(0, 0, w, h)
  // ImageData.data is a Uint8ClampedArray; share the buffer as Uint8Array.
  const pixels = new Uint8Array(data.data.buffer)
  return { pixels, w, h }
}

type ImagePixels = { pixels: Uint8Array; w: number; h: number }
const imageCache: Map<ImageKey, ImagePixels> = new Map()
const imageLoading: Map<ImageKey, Promise<void>> = new Map()

function loadGeneratedPattern(p: SyntheticPattern): void {
  sourcePixels = generatePattern(p, SOURCE_SIZE)
  sourceW = SOURCE_SIZE
  sourceH = SOURCE_SIZE
  state.source = p
  state.syntheticPattern = p
  needsRebuild = true
}

function applyImage(key: ImageKey): void {
  const img = imageCache.get(key)
  if (!img) return
  sourcePixels = img.pixels
  sourceW = img.w
  sourceH = img.h
  state.source = key
  state.imageKey = key
  needsRebuild = true
}

function ensureImage(key: ImageKey): Promise<void> {
  if (imageCache.has(key)) {
    applyImage(key)
    return Promise.resolve()
  }
  let pending = imageLoading.get(key)
  if (!pending) {
    setStatus(`loading ${IMAGE_SOURCES[key].label}…`)
    pending = loadImageRgba(IMAGE_SOURCES[key].url)
      .then((img) => {
        imageCache.set(key, img)
      })
      .catch((err) => {
        imageLoading.delete(key)
        throw err
      })
    imageLoading.set(key, pending)
  }
  return pending.then(() => {
    applyImage(key)
  })
}

// --- Rendering -------------------------------------------------------------

function resizeCanvas(): void {
  const dpr = window.devicePixelRatio || 1
  const rect = els.canvas.getBoundingClientRect()
  const w = Math.max(1, Math.floor(rect.width * dpr))
  const h = Math.max(1, Math.floor(rect.height * dpr))
  if (els.canvas.width !== w) els.canvas.width = w
  if (els.canvas.height !== h) els.canvas.height = h
}

// Build the model-view-projection matrix for the current state. The source
// image is aspect-fit into the canvas (centered, letterboxed) with a
// VIEWPORT_FILL margin, scaled by zoom, then sheared in clip space.
function buildMvp(): Float32Array {
  if (!gl) return mat3Identity()
  const cw = els.canvas.width
  const ch = els.canvas.height
  const canvasAspect = cw / ch
  const sourceAspect = sourceW / sourceH
  // Aspect-fit the source rectangle into the canvas (letterbox), preserving
  // the source image's own proportions. VIEWPORT_FILL leaves a small margin.
  const fill = VIEWPORT_FILL * state.zoom
  let sx: number
  let sy: number
  if (canvasAspect >= sourceAspect) {
    sy = fill
    sx = fill * (sourceAspect / canvasAspect)
  } else {
    sx = fill
    sy = fill * (canvasAspect / sourceAspect)
  }
  // 1. Translate [0..1] -> [-0.5..0.5]
  const center = mat3Identity()
  center[6] = -0.5
  center[7] = -0.5
  // 2. Scale to clip-space cube (twice the half-extent).
  const scale = mat3Scale(2 * sx, 2 * sy)
  // 3. Apply shear in clip space.
  const shear = mat3Shear(state.shearX, state.shearY)
  return mat3Mul(shear, mat3Mul(scale, center))
}

function pxToFracX(p: number): number {
  return p / sourceW
}

function pxToFracY(p: number): number {
  return p / sourceH
}

function drawScene(): void {
  if (!gl) return
  resizeCanvas()
  gl.viewport(0, 0, els.canvas.width, els.canvas.height)
  gl.clearColor(0.04, 0.05, 0.07, 1)
  gl.clear(gl.COLOR_BUFFER_BIT)

  if (needsRebuild) {
    rebuildTiles(state.nTiles, state.nTiles, state.overlap)
    needsRebuild = false
  }

  const mvp = buildMvp()

  // Tile pass
  gl.useProgram(texProg)
  gl.uniformMatrix3fv(texUMvp, false, mvp)
  gl.uniform1i(texUTex, 0)
  gl.activeTexture(gl.TEXTURE0)
  gl.bindVertexArray(quadVao)

  if (state.reference) {
    // Single full-image texture covering the whole world rect. World y is
    // up, but source pixels have row 0 at the top and were uploaded without
    // UNPACK_FLIP_Y, so v=0 maps to source row 0. The tile path already
    // flips its uv-v to compensate; the reference path must do the same so
    // both modes show the image right-side up and are pixel-for-pixel
    // comparable.
    if (!refTexture) return
    applyFilter(refTexture, state.filter, state.wrap)
    gl.bindBuffer(gl.ARRAY_BUFFER, quadVbo)
    const data = quadAttribs(0, 0, 1, 1, 0, 1, 1, 0)
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW)
    gl.drawArrays(gl.TRIANGLES, 0, 6)
  } else {
    for (const t of tiles) {
      applyFilter(t.texture, state.filter, state.wrap)
      const x0 = pxToFracX(t.innerX0)
      // Source pixels grow downward in screen Y but our world has y-up;
      // flip so (0,0) of the source is at the top-left visually.
      const y0 = 1 - pxToFracY(t.innerY1)
      const x1 = pxToFracX(t.innerX1)
      const y1 = 1 - pxToFracY(t.innerY0)
      const data = quadAttribs(
        x0,
        y0,
        x1,
        y1,
        t.uInner0,
        t.vInner1,
        t.uInner1,
        t.vInner0,
      )
      gl.bindBuffer(gl.ARRAY_BUFFER, quadVbo)
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW)
      gl.drawArrays(gl.TRIANGLES, 0, 6)
    }
  }
  gl.bindVertexArray(null)

  if (state.showBorders && !state.reference) {
    drawBorders(mvp)
  }

  updateHud()
}

function drawBorders(mvp: Float32Array): void {
  if (!gl) return
  gl.useProgram(lineProg)
  gl.uniformMatrix3fv(lineUMvp, false, mvp)
  gl.uniform4f(lineUColor, 1.0, 0.35, 0.35, 0.9)
  gl.bindVertexArray(lineVao)
  // Build a single line list for all interior tile boundaries.
  const lines: number[] = []
  for (let i = 1; i < state.nTiles; i++) {
    const x = i / state.nTiles
    lines.push(x, 0, x, 1)
  }
  for (let j = 1; j < state.nTiles; j++) {
    const y = j / state.nTiles
    lines.push(0, y, 1, y)
  }
  if (lines.length === 0) {
    gl.bindVertexArray(null)
    return
  }
  gl.bindBuffer(gl.ARRAY_BUFFER, lineVbo)
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(lines), gl.DYNAMIC_DRAW)
  gl.drawArrays(gl.LINES, 0, lines.length / 2)
  gl.bindVertexArray(null)
}

function updateHud(): void {
  const mode = state.reference
    ? 'reference (1 texture)'
    : `${tiles.length} tiles`
  const overlap = state.overlap === 0 ? 'none' : `${state.overlap}px`
  const sourceLabel = isImageKey(state.source)
    ? `image ${state.source} (${sourceW}×${sourceH})`
    : `pattern ${state.source}`
  els.hud.textContent =
    `${mode} · ${state.filter} · wrap ${state.wrap} · overlap ${overlap}\n` +
    `shear (${state.shearX.toFixed(2)}, ${state.shearY.toFixed(2)}) · zoom ${state.zoom.toFixed(2)}× · ${sourceLabel}\n` +
    'Inspect interior tile boundaries — under linear+clamp+0px overlap, shear exposes a 1px-wide tonal discontinuity.'
}

// --- UI wiring -------------------------------------------------------------

function setStatus(msg: string): void {
  els.statusPill.textContent = msg
}

function readState(): void {
  // Pattern changes are handled by onPatternChange (async-aware for
  // image-backed patterns) — readState() only consumes the rest of the UI.
  const newTiles = Number(els.tilesSelect.value)
  if (newTiles !== state.nTiles) {
    state.nTiles = newTiles
    needsRebuild = true
  }
  state.filter = els.filterSelect.value as Filter
  state.wrap = els.wrapSelect.value as Wrap
  const newOverlap = Number(els.overlapSelect.value)
  if (newOverlap !== state.overlap) {
    state.overlap = newOverlap
    needsRebuild = true
  }
  state.shearX = Number(els.shearX.value)
  state.shearY = Number(els.shearY.value)
  state.zoom = Number(els.zoom.value)
  state.showBorders = els.showBorders.checked
  state.reference = els.reference.checked
  els.shearXNum.textContent = state.shearX.toFixed(2)
  els.shearYNum.textContent = state.shearY.toFixed(2)
  els.zoomNum.textContent = state.zoom.toFixed(2)
}

function scheduleRedraw(): void {
  readState()
  drawScene()
  setStatus('ready')
}

// Reflect select-disabled state: when an image is active, the synthetic
// Pattern select has no effect on what's drawn, so grey it out.
function syncSelectAvailability(): void {
  els.patternSelect.disabled = state.imageKey !== null
}

function loadImageOrFallback(key: ImageKey): void {
  ensureImage(key)
    .then(() => {
      if (els.imageSelect.value !== key) return
      drawScene()
      setStatus('ready')
    })
    .catch((err) => {
      console.error(err)
      setStatus(`image '${key}' failed; using ${state.syntheticPattern}`)
      els.imageSelect.value = ''
      state.imageKey = null
      loadGeneratedPattern(state.syntheticPattern)
      syncSelectAvailability()
      drawScene()
    })
}

function onImageChange(): void {
  const raw = els.imageSelect.value
  if (raw === '') {
    state.imageKey = null
    loadGeneratedPattern(state.syntheticPattern)
    syncSelectAvailability()
    drawScene()
    setStatus('ready')
    return
  }
  if (!isImageKey(raw)) return
  state.imageKey = raw
  syncSelectAvailability()
  loadImageOrFallback(raw)
}

function onPatternChange(): void {
  const newPattern = els.patternSelect.value as SyntheticPattern
  state.syntheticPattern = newPattern
  // Only apply immediately when no image is overriding.
  if (state.imageKey !== null) return
  loadGeneratedPattern(newPattern)
  drawScene()
  setStatus('ready')
}

els.imageSelect.addEventListener('change', onImageChange)
els.patternSelect.addEventListener('change', onPatternChange)
for (const select of [
  els.tilesSelect,
  els.filterSelect,
  els.wrapSelect,
  els.overlapSelect,
]) {
  select.addEventListener('change', scheduleRedraw)
}
for (const range of [els.shearX, els.shearY, els.zoom]) {
  range.addEventListener('input', scheduleRedraw)
}
els.showBorders.addEventListener('change', scheduleRedraw)
els.reference.addEventListener('change', scheduleRedraw)

window.addEventListener('resize', drawScene)

// Initial render. Pattern select sets the synthetic fallback. If the Image
// select has a non-empty default, paint the fallback synchronously (so the
// canvas isn't blank during the JPEG download) and kick off the async load.
state.syntheticPattern = els.patternSelect.value as SyntheticPattern
loadGeneratedPattern(state.syntheticPattern)
readState()
const initialImage = els.imageSelect.value
if (initialImage !== '' && isImageKey(initialImage)) {
  state.imageKey = initialImage
  syncSelectAvailability()
  drawScene()
  loadImageOrFallback(initialImage)
} else {
  syncSelectAvailability()
  drawScene()
  setStatus('ready')
}

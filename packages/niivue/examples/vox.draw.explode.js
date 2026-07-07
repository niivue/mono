import NiiVue, { chunkVolumeGrid } from '../src/index.ts'

// A dedicated drawing demo that exercises feature parity across:
//   - 2D slices and the 3D render (exploded blocks)
//   - pen / eraser / flood-fill / magic wand / vector (SVG) annotations
//   - WebGL2 and WebGPU
//
// The background volume fits in one texture, so we FORCE a 3x3x3 tiling
// (chunkVolumeGrid) to get an exploded-block-capable volume. Explode is a
// render-time per-brick offset (not a data change), so the slider just toggles
// vol.chunkExplode and redraws. Drawing writes into the shared drawingVolume
// bitmap (dimsRAS), independent of tiling, so it works on 2D slices and on the
// separated 3D blocks alike.

const GRID = [3, 3, 3]
// The forced grid's chunks are small (a normal volume split in 27); any device
// limit above the largest chunk edge works. 4096 is safely above real GPUs'
// per-chunk needs here.
const DEVICE_LIMIT = 4096
// Match the renderer's per-chunk gradient halo so brick faces stay seam-free.
const HALO = [3, 3, 3]

// Ensure the loaded volume is tiled into a stable 3x3x3 grid so its blocks can
// be exploded and drawn on directly. Re-run after a backend switch (the view is
// rebuilt, but the model — including chunkPlan/chunkExplode — persists).
async function ensureTiled() {
  const vol = nv1.volumes?.[0]
  if (!vol?.dimsRAS) return
  const d = vol.dimsRAS
  vol.chunkPlan = chunkVolumeGrid([d[1], d[2], d[3]], GRID, DEVICE_LIMIT, HALO)
  await nv1.updateGLVolume()
}

function applyExplode() {
  const vol = nv1.volumes?.[0]
  if (!vol) return
  const scale = parseInt(explode.value, 10) / 100
  const on = scale > 1.001
  vol.chunkExplode = on
    ? { enabled: true, scale: [scale, scale, scale] }
    : { enabled: false }
  explodeVal.textContent = on ? `${scale.toFixed(2)}x` : 'off'
  nv1.drawScene()
}

// Label index -> RGB for the Vector annotation style (mirrors the _draw LUT:
// 1=red, 2=green, 3=blue).
const COLOR_RGB = { 1: [1, 0, 0], 2: [0, 1, 0], 3: [0, 0, 1] }
const COLOR_CSS = { 1: '#ff0000', 2: '#00ff00', 3: '#0000ff' }

// Reflect the active Color in a swatch, dimmed when Color doesn't apply (Eraser/
// Off, which disable the Color select).
function updateColorSwatch() {
  colorSwatch.style.background =
    COLOR_CSS[parseInt(colorSel.value, 10)] ?? '#ff0000'
  colorSwatch.style.opacity = colorSel.disabled ? '0.3' : '1'
}

// Per-tool 2D-slice and 3D-block gestures, for the contextual hint line.
const TOOL_ACTIONS = {
  pen: { d2: 'left-drag to paint', d3: 'right-drag a block to paint' },
  eraser: { d2: 'left-drag to erase', d3: 'right-drag a block to erase' },
  fill: {
    d2: 'left-drag a closed loop to flood',
    d3: 'right-click a block to flood the blob',
  },
  wand: {
    d2: 'left-click to grow a region',
    d3: 'right-click a block to grow the region',
  },
  vector: {
    d2: 'left-drag to draw a polygon',
    d3: 'right-drag a block to draw a polygon',
  },
}
const TOOL_LABEL = {
  pen: 'Pen',
  eraser: 'Eraser',
  fill: 'Fill',
  wand: 'Magic wand',
  vector: 'Vector (SVG)',
  off: 'Off',
}

// Contextual "what to do now" line: reflects the active tool, the current view
// (does it show 2D slices / the 3D render?), and whether Explode is on (needed to
// draw on blocks). Addresses the left-drag(2D)/right-drag(3D) split and the
// hidden Explode requirement without making the user parse the static help.
function updateHint() {
  const tool = toolSel.value
  const viewVal = parseInt(view.value, 10)
  const has2D = viewVal <= 3 // axial/coronal/sagittal/multiplanar show slices
  const hasRender = viewVal === 3 || viewVal === 4 // A+C+S+R or Render
  const explodeOn = parseInt(explode.value, 10) / 100 > 1.001
  if (tool === 'off') {
    hint.innerHTML = 'Drawing is <b>off</b> — pick a Tool to start.'
    return
  }
  const a = TOOL_ACTIONS[tool]
  const parts = []
  if (has2D) parts.push(`2D slice: ${a.d2}`)
  if (hasRender) {
    parts.push(
      explodeOn
        ? `3D block: ${a.d3}`
        : '<span class="warn">turn on Explode to draw on the 3D blocks</span>',
    )
  }
  let msg = `<b>${TOOL_LABEL[tool]}</b> — ${parts.join('; ')}.`
  if (tool === 'vector') msg += ' <b>SVG</b> exports the shapes.'
  hint.innerHTML = msg
}

// One tool active at a time (no conflicting checkboxes). Each tool sets the full
// draw/annotation state and enables only its relevant options (Color/Size/2D/Tol/
// SVG), so an irrelevant control can't be silently ignored.
function applyTool() {
  const tool = toolSel.value // pen | eraser | fill | wand | vector | off
  const colorVal = parseInt(colorSel.value, 10)
  const vector = tool === 'vector'

  // Contextual control availability.
  colorSel.disabled = tool === 'eraser' || tool === 'off'
  penSize.disabled = !(tool === 'pen' || tool === 'eraser')
  wandTol.disabled = tool !== 'wand'
  wand2dCheck.disabled = tool !== 'wand'
  svgBtn.disabled = !vector
  updateColorSwatch()

  // Raster draw modes are mutually exclusive here.
  nv1.drawIsClickToSegment = tool === 'wand'
  nv1.drawPenFilled = tool === 'fill'
  nv1.drawPenAutoClose = tool === 'fill'
  nv1.annotationIsEnabled = vector

  if (vector) {
    nv1.drawIsEnabled = false // the annotation layer handles the stroke
    nv1.annotationTool = 'freehand'
    nv1.annotationBrushRadius = 1 // <=1 => closed-polygon mode
    const [r, g, b] = COLOR_RGB[colorVal] ?? COLOR_RGB[1]
    nv1.annotationStyle = {
      fillColor: [r, g, b, 0.3],
      strokeColor: [r, g, b, 1],
      strokeWidth: 2,
    }
    return
  }
  if (tool === 'off') {
    nv1.drawIsEnabled = false // keep the drawing visible but stop editing
    return
  }
  nv1.drawIsEnabled = true
  nv1.drawPenValue = tool === 'eraser' ? 0 : colorVal
}

toolSel.onchange = () => {
  applyTool()
  updateHint()
}
colorSel.onchange = applyTool

wand2dCheck.onchange = function () {
  // 2D on: a wand click grows only within the clicked slice; off: whole 3D
  // structure (the default). Ignored by the 3D exploded-block right-click.
  nv1.drawClickToSegmentIs2D = this.checked
}

wandTol.oninput = function () {
  // Slider is percent of the display window; the API takes a 0..1 fraction.
  nv1.drawClickToSegmentTolerance = parseInt(this.value, 10) / 100
  tolVal.textContent = `${this.value}%`
}

penSize.oninput = function () {
  nv1.drawPenSize = parseInt(this.value, 10)
}

explode.oninput = () => {
  applyExplode()
  updateHint()
}

overwriteCheck.onchange = function () {
  nv1.drawIsFillOverwriting = this.checked
}

clipCheck.onchange = function () {
  // Show/hide a clip-plane cutaway from its OWN control, so the right mouse
  // button stays free to draw on the blocks (in a raster pen/wand/fill mode
  // right-drag paints; it only adjusts the clip plane when no draw mode is on).
  // depth 2 = no clip; depth 0 = a cut through the middle.
  nv1.isClipPlaneCutaway = this.checked
  nv1.setClipPlane(this.checked ? [0, 0, 0] : [2, 0, 0])
}

const isVectorMode = () => toolSel.value === 'vector'
undoBtn.onclick = () => (isVectorMode() ? nv1.annotationUndo() : nv1.drawUndo())
saveBtn.onclick = () => nv1.saveDrawing('drawing.nii.gz')
svgBtn.onclick = () => {
  // Export the vector annotations on the current slice as SVG (Vector mode).
  const svg = nv1.annotationsToSVG()
  if (!svg) {
    alert('Draw a vector shape first (Tool -> Vector (SVG)).')
    return
  }
  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }))
  const a = document.createElement('a')
  a.href = url
  a.download = 'annotations.svg'
  a.click()
  URL.revokeObjectURL(url)
}
clearBtn.onclick = () => {
  // Reset to an empty raster drawing and wipe any vector annotations.
  nv1.createEmptyDrawing()
  nv1.clearAnnotations()
  nv1.drawScene()
}

view.onchange = () => {
  nv1.sliceType = parseInt(view.value, 10)
  updateHint()
}

backend.onchange = async () => {
  await nv1.reinitializeView({ backend: backend.value })
  // The rebuilt view must re-tile from the persisted chunkPlan, then re-apply
  // the current explode offset.
  await ensureTiled()
  applyExplode()
}

function handleLocationChange(data) {
  document.getElementById('location').innerHTML = `&nbsp;&nbsp;${data.string}`
}

// Optional `?backend=webgl2` (or webgpu) to pick the initial backend; the select
// mirrors it and can still switch at runtime.
const initialBackend =
  new URLSearchParams(window.location.search).get('backend') === 'webgl2'
    ? 'webgl2'
    : 'webgpu'
backend.value = initialBackend

const nv1 = new NiiVue({
  backgroundColor: [0.1, 0.1, 0.12, 1],
  backend: initialBackend,
})
nv1.addEventListener('locationChange', (e) => handleLocationChange(e.detail))
await nv1.attachToCanvas(gl1)
nv1.sliceType = parseInt(view.value, 10)
await nv1.loadVolumes([{ url: '/volumes/mni152.nii.gz' }])
await ensureTiled()

// Start with an empty drawing and the pen ready so painting works immediately.
nv1.createEmptyDrawing()
nv1.drawOpacity = 0.6
nv1.drawIsFillOverwriting = overwriteCheck.checked
nv1.drawClickToSegmentTolerance = parseInt(wandTol.value, 10) / 100
nv1.drawClickToSegmentIs2D = wand2dCheck.checked
// Show vector annotations in the 3D render; they track their exploded block.
nv1.annotationIsVisibleIn3D = true
applyTool()
nv1.drawPenSize = parseInt(penSize.value, 10)
applyExplode()
updateHint()

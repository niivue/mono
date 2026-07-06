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

function applyPen() {
  const val = parseInt(penValue.value, 10)
  // Vector (SVG) mode: draw freehand vector polygons (annotation layer) on the
  // 2D slices instead of the raster, and enable SVG export. The raster pen, wand,
  // and fill are off in this mode. Mirrors the slide demos' "Vector (SVG)" tool.
  const vector = val === 10
  nv1.annotationIsEnabled = vector
  svgBtn.disabled = !vector
  if (vector) {
    nv1.drawIsEnabled = false // let the annotation layer handle the click
    nv1.drawIsClickToSegment = false
    nv1.drawPenFilled = false
    nv1.annotationTool = 'freehand'
    nv1.annotationBrushRadius = 1 // <=1 => closed-polygon mode
    return
  }
  if (val < 0) {
    // "Off" — keep the drawing visible but stop the pen.
    nv1.drawIsEnabled = false
    return
  }
  nv1.drawIsEnabled = true
  nv1.drawPenValue = val
  // Magic wand (click-to-segment) takes priority over fill when both are on.
  const wand = wandCheck.checked
  nv1.drawIsClickToSegment = wand
  // Fill mode: on 2D a closed loop is flood-filled; on an exploded block a
  // right-click floods the connected tissue blob (3D region-grow).
  const fill = fillCheck.checked && !wand
  nv1.drawPenFilled = fill
  nv1.drawPenAutoClose = fill
}

penValue.onchange = applyPen
fillCheck.onchange = applyPen
wandCheck.onchange = applyPen

wand2dCheck.onchange = function () {
  // 2D on: a wand click grows only within the clicked slice; off: whole 3D
  // structure (the default). Ignored by the 3D exploded-block right-click.
  nv1.drawClickToSegmentIs2D = this.checked
}

wandTol.oninput = function () {
  // Slider is percent of the display window; the API takes a 0..1 fraction.
  nv1.drawClickToSegmentTolerance = parseInt(this.value, 10) / 100
}

penSize.oninput = function () {
  nv1.drawPenSize = parseInt(this.value, 10)
}

explode.oninput = applyExplode

overwriteCheck.onchange = function () {
  nv1.drawIsFillOverwriting = this.checked
}

const isVectorMode = () => penValue.value === '10'
undoBtn.onclick = () => (isVectorMode() ? nv1.annotationUndo() : nv1.drawUndo())
saveBtn.onclick = () => nv1.saveDrawing('drawing.nii.gz')
svgBtn.onclick = () => {
  // Export the vector annotations on the current slice as SVG (Vector mode).
  const svg = nv1.annotationsToSVG()
  if (!svg) {
    alert('Draw a vector shape first (Pen -> Vector (SVG)).')
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

const nv1 = new NiiVue({ backgroundColor: [0.1, 0.1, 0.12, 1] })
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
applyPen()
nv1.drawPenSize = parseInt(penSize.value, 10)
applyExplode()

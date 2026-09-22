import NiiVue, { chunkVolumeGrid, extractChunkBlock } from '../src/index.ts'

// Pick one block out of an exploded volume and open it, on its own, beside the
// parent.
//
// The point of the demo is the COORDINATE behaviour, not the copy. An extracted
// block is a genuinely separate NVImage with its own voxel indices starting at
// [0,0,0], and each viewer frames its own volume, so the block appears centred
// on its centroid. Its crosshair still reports the parent's anatomical mm,
// because `extractChunkBlock` gives the copy the parent's affine with the origin
// walked forward to the block's first voxel:
//
//     A_child = A_parent . translate(voxelOrigin)
//
// The rotation/scale block is untouched, so an oblique parent stays oblique and
// the mm frame is shared. That is why "link crosshairs" is a one-liner here:
// nv2.setCrosshairPos(nv1.getCrosshairPos()) with no correction term. The
// translation the block picked up on screen is carried by its affine, not by
// bookkeeping in the app.
//
// NIfTI carries that frame in sform/qform. OME-Zarr carries the same thing in
// its multiscale `coordinateTransformations` (a per-level `scale` plus
// `translation`), so the identity above is what a streamed store would use too.

// mni152 fits in a single texture, so we FORCE a tiling to get pickable bricks
// (the same trick vox.draw.explode.js uses). A streamed volume arrives chunked
// already, but its voxels live in GPU brick textures rather than CPU memory, so
// extraction is a CPU-side-data feature for now.
const DEVICE_LIMIT = 4096
// Match the renderer's per-chunk gradient halo so brick faces stay seam-free.
// Extraction uses each brick's DATA region, not its halo, so adjacent blocks
// tile the parent exactly.
const HALO = [3, 3, 3]

const PICK_SLOP_PX = 4 // a click that travelled further than this was a rotate

let picked = null // the last ExplodedBlockPick, or null
let pickSeq = 0 // serializes overlapping loads: last pick wins
let syncing = false // re-entrancy guard for the linked crosshairs
let downX = 0
let downY = 0

const fmt3 = (v) =>
  `(${v[0].toFixed(1).padStart(7)},${v[1].toFixed(1).padStart(7)},${v[2].toFixed(1).padStart(7)})`
const fmtVox = (v) =>
  `[${Math.round(v[0]).toString().padStart(4)},${Math.round(v[1]).toString().padStart(4)},${Math.round(v[2]).toString().padStart(4)}]`

/** Apply a flat row-major 4x4 (the matRAS convention) to a voxel coordinate. */
function applyMat(m, v) {
  return [
    m[0] * v[0] + m[1] * v[1] + m[2] * v[2] + m[3],
    m[4] * v[0] + m[5] * v[1] + m[6] * v[2] + m[7],
    m[8] * v[0] + m[9] * v[1] + m[10] * v[2] + m[11],
  ]
}

/** mm of a volume's centre voxel, in its own frame. */
function centreMM(vol) {
  const d = vol.dimsRAS
  return applyMat(vol.matRAS, [(d[1] - 1) / 2, (d[2] - 1) / 2, (d[3] - 1) / 2])
}

/** mm AABB of the extracted block, from its 8 corners (oblique-safe). */
function blockBoundsMM(block) {
  const [dx, dy, dz] = block.voxelDims
  const min = [Infinity, Infinity, Infinity]
  const max = [-Infinity, -Infinity, -Infinity]
  for (let c = 0; c < 8; c++) {
    const mm = applyMat(block.affine, [
      c & 1 ? dx - 1 : 0,
      c & 2 ? dy - 1 : 0,
      c & 4 ? dz - 1 : 0,
    ])
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k], mm[k])
      max[k] = Math.max(max[k], mm[k])
    }
  }
  return { min, max }
}

// `location` is window.location, so the footer is fetched explicitly.
const footer = document.getElementById('location')

const explodeScale = () => parseInt(explode.value, 10) / 100
const isExploded = () => explodeScale() > 1.001

// Force a stable grid on the loaded volume so its blocks can be exploded and
// picked. Re-run after a backend switch: the view is rebuilt, but the model
// (chunkPlan / chunkExplode) persists.
async function ensureTiled() {
  const vol = nv1.volumes?.[0]
  if (!vol?.dimsRAS) return
  const n = parseInt(grid.value, 10)
  const d = vol.dimsRAS
  vol.chunkPlan = chunkVolumeGrid(
    [d[1], d[2], d[3]],
    [n, n, n],
    DEVICE_LIMIT,
    HALO,
  )
  await nv1.updateGLVolume()
}

function applyExplode() {
  const vol = nv1.volumes?.[0]
  if (!vol) return
  const scale = explodeScale()
  vol.chunkExplode = isExploded()
    ? { enabled: true, scale: [scale, scale, scale] }
    : { enabled: false }
  explodeVal.textContent = isExploded() ? `${scale.toFixed(2)}x` : 'off'
  // Exploding grows the drawn extent past the volume's own bounds, so pull the
  // camera back by the same factor: the separated blocks stay framed instead of
  // spilling out of the pane.
  nv1.scaleMultiplier = 1 / scale
  // The outline is drawn in EXPLODED mm, so a changed offset invalidates it.
  if (picked) clearPick()
  nv1.drawScene()
  updateHint()
}

function updateHint() {
  if (!isExploded()) {
    hint.innerHTML =
      '<span class="warn">Raise <b>Explode</b> above 1.00x</span> to separate the blocks and make them pickable.'
    return
  }
  hint.innerHTML = picked
    ? `Showing block <b>#${picked.chunkIndex}</b>. Click another block, or move either crosshair to see both panes report the same anatomical mm.`
    : '<b>Click a block</b> in the left render to copy it into the right pane.'
}

function clearPick() {
  picked = null
  pickSeq++
  nv1.focusBox = null
  nv2.removeAllVolumes()
  blockOut.textContent = 'No block picked yet.'
  nv1.drawScene()
  updateHint()
}

async function pickAt(clientX, clientY) {
  const hit = nv1.pickExplodedBlock(clientX, clientY)
  if (!hit) return // empty space, or not over the render tile
  const vol = nv1.volumes[hit.volumeIndex]
  const block = extractChunkBlock(vol, hit.chunkIndex)
  if (!block) return

  picked = hit
  const seq = ++pickSeq
  // Outline the picked brick in place, in the same EXPLODED mm the render uses.
  nv1.focusBox = {
    min: hit.explodedMin,
    max: hit.explodedMax,
    color: [1, 0.83, 0.28, 1],
    thickness: 2,
  }
  nv1.drawScene()

  // A fresh File each pick: ephemeral by construction, nothing is cached.
  const file = new File([block.nifti], `block_${hit.chunkIndex}.nii`, {
    type: 'application/octet-stream',
  })
  await nv2.loadVolumes([
    {
      url: file,
      name: `block ${hit.chunkIndex}`,
      colormap: 'gray',
      calMin: block.calMin,
      calMax: block.calMax,
    },
  ])
  if (seq !== pickSeq) return // a later pick landed while this one loaded

  block.boundsMM = blockBoundsMM(block)
  picked.block = block
  // Open the block pane on the voxel that was clicked, addressed in PARENT mm.
  // When linked, move the parent there too: the two panes then show the SAME mm
  // from the start, which is the point the demo is making.
  syncing = true
  nv2.setCrosshairPos(hit.mm)
  if (linkCheck.checked) nv1.setCrosshairPos(hit.mm)
  syncing = false
  reportBlock()
  reportParent()
  updateHint()
}

function reportParent() {
  const vol = nv1.volumes?.[0]
  if (!vol) return
  const n = parseInt(grid.value, 10)
  const mm = nv1.getCrosshairPos()
  const lines = [
    `<span class="k">crosshair  </span> ${fmt3(mm)} mm`,
    `<span class="k">blocks     </span> ${n} x ${n} x ${n} (${vol.chunkPlan?.chunks.length ?? 0})   explode ${isExploded() ? `${explodeScale().toFixed(2)}x` : 'off'}`,
  ]
  lines.push(
    picked
      ? `<span class="k">picked     </span> <span class="hi">#${picked.chunkIndex}</span>  origin vox ${fmtVox(picked.voxelOrigin)}  dims ${picked.voxelDims.join(' x ')}`
      : '<span class="k">picked     </span> none',
  )
  parentOut.innerHTML = lines.join('\n')
}

function reportBlock() {
  const block = picked?.block
  const vol = nv2.volumes?.[0]
  if (!block || !vol) {
    blockOut.textContent = 'No block picked yet.'
    return
  }
  const parent = nv1.volumes?.[0]
  if (!parent) return
  const mm = nv2.getCrosshairPos()
  const parentCentre = centreMM(parent)
  const shift = [
    block.centroidMM[0] - parentCentre[0],
    block.centroidMM[1] - parentCentre[1],
    block.centroidMM[2] - parentCentre[2],
  ]
  blockOut.innerHTML = [
    `<span class="k">crosshair  </span> ${fmt3(mm)} mm  <span class="hi">same frame as the parent</span>`,
    `<span class="k">block dims </span> ${block.voxelDims.join(' x ')} vox @ ${block.spacingMM.map((s) => s.toFixed(2)).join(' x ')} mm`,
    `<span class="k">block [0,0,0]</span> ${fmt3(block.originMM)} mm  (parent vox ${fmtVox(block.voxelOrigin)})`,
    `<span class="k">centroid   </span> ${fmt3(block.centroidMM)} mm   offset from parent centre ${fmt3(shift)}`,
  ].join('\n')
}

// Both panes hold the same anatomical frame, so linking is a straight mm copy:
// no re-centring term, even though the block is drawn centred on its centroid.
function linkFromParent(mm) {
  if (!linkCheck.checked || syncing || !picked?.block) return
  const b = picked.block.boundsMM
  for (let k = 0; k < 3; k++) {
    if (mm[k] < b.min[k] || mm[k] > b.max[k]) return // outside this block
  }
  syncing = true
  nv2.setCrosshairPos([mm[0], mm[1], mm[2]])
  syncing = false
}

function linkFromBlock(mm) {
  if (!linkCheck.checked || syncing) return
  syncing = true
  nv1.setCrosshairPos([mm[0], mm[1], mm[2]])
  syncing = false
}

grid.onchange = async () => {
  clearPick()
  await ensureTiled()
  applyExplode()
  reportParent()
}

explode.oninput = () => {
  applyExplode()
  reportParent()
}

blockView.onchange = () => {
  nv2.sliceType = parseInt(blockView.value, 10)
}

linkCheck.onchange = () => {
  if (linkCheck.checked) linkFromParent(nv1.getCrosshairPos())
}

clearBtn.onclick = clearPick

backend.onchange = async () => {
  const b = backend.value
  clearPick()
  await nv1.reinitializeView({ backend: b })
  await nv2.reinitializeView({ backend: b })
  await ensureTiled()
  applyExplode()
  reportParent()
}

// Optional `?backend=webgl2` (or webgpu) to pick the initial backend; the select
// mirrors it and can still switch at runtime.
const initialBackend =
  new URLSearchParams(window.location.search).get('backend') === 'webgl2'
    ? 'webgl2'
    : 'webgpu'
backend.value = initialBackend

const nv1 = new NiiVue({
  backgroundColor: [0.08, 0.09, 0.11, 1],
  backend: initialBackend,
  sliceType: 4, // SLICE_TYPE.RENDER
  isColorbarVisible: false,
})
const nv2 = new NiiVue({
  backgroundColor: [0.08, 0.09, 0.11, 1],
  backend: initialBackend,
  sliceType: parseInt(blockView.value, 10),
  isColorbarVisible: false,
  placeholderText: 'Click a block on the left',
})

nv1.addEventListener('locationChange', (e) => {
  linkFromParent(e.detail.mm)
  reportParent()
  footer.innerHTML = `&nbsp;&nbsp;parent: ${e.detail.string}`
})
nv2.addEventListener('locationChange', (e) => {
  linkFromBlock(e.detail.mm)
  reportBlock()
  footer.innerHTML = `&nbsp;&nbsp;block: ${e.detail.string}`
})

// A left-drag on the render tile rotates the scene, so only a click that did not
// travel is treated as a pick.
gl1.addEventListener('mousedown', (e) => {
  downX = e.clientX
  downY = e.clientY
})
gl1.addEventListener('click', (e) => {
  if (Math.abs(e.clientX - downX) > PICK_SLOP_PX) return
  if (Math.abs(e.clientY - downY) > PICK_SLOP_PX) return
  pickAt(e.clientX, e.clientY)
})

await nv1.attachToCanvas(gl1)
await nv2.attachToCanvas(gl2)
await nv1.loadVolumes([{ url: '/volumes/mni152.nii.gz' }])
await ensureTiled()
applyExplode()
reportParent()
updateHint()

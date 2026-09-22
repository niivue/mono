// Gradient opacity, silhouette and matcap illumination on EXPLODED BLOCKS --
// vox.gradopacity.html's three controls applied to a volume force-tiled into a
// grid of bricks that can be pulled apart (the chunkExplode offset from
// vox.draw.explode.html).
//
// Two reasons this pairing is worth its own page.
//
// 1. All three features act on the INTERIOR, which a solid volume hides. The
//    usual way to see in is a clip plane, but that cuts the data and gives the
//    ray-march a flat artificial face. Exploding does not touch the data at all
//    -- it is a per-brick render-time offset -- so every surface you see is a
//    real one, and gradient opacity's "fade the homogeneous middle, keep the
//    edges" reads directly instead of by inference.
//
// 2. It exercises the CHUNKED gradient path. vox.gradopacity.html runs on the
//    single-texture path: one volume texture, one gradient texture. A tiled
//    volume instead builds a gradient texture PER BRICK and the ray-march walks
//    them as separate cubes. That is a second, structurally different
//    implementation of the same three features on each backend, and this is the
//    page that shows it agreeing with the first.
//
// THE HALO IS THE LOAD-BEARING DETAIL. A brick boundary is not an edge in the
// data, but a gradient estimator that only sees one brick cannot know that: at
// the last voxel of a brick the central difference would reach past the end,
// clamp, and report a large gradient. Every cut face would then light up under
// illumination and rim under silhouette -- 27 glowing boxes rather than a
// separated volume. So each brick's gradient is built over a HALO of
// neighbouring voxels (3 here, matching the renderer), and the estimator never
// sees the cut. Set HALO to [0, 0, 0] to watch that failure appear.
//
// Deferral note: the chunked path skips the gradient build for any brick whose
// scene has illumination, gradient opacity and silhouette all at 0, and fills it
// in on the frame after one of them moves off 0 (_uploadedUnlit /
// _refreshUnlitChunksForLighting in gl/render.ts and wgpu/render.ts; the
// non-chunked path does the same through _ensureSingleGradients). Drag all three
// sliders to 0 and back to exercise it -- the image must return unchanged.
//
// Backend parity: the two backends run the SAME gradient estimator, verified
// bit-for-bit by e2e/gradient-parity.spec.ts. See the header of
// vox.gradopacity.js for what that took. Switch Backend (or ?backend=webgl2) to
// compare.

import { cortex, shiny } from '../src/assets/matcaps'
import NiiVue, { chunkVolumeGrid } from '../src/index.ts'
import { SHOW_RENDER } from '../src/NVConstants.ts'

// mni152 and chris_t1 are MR (a skull-stripped brain and a whole head); the two
// CT volumes are the interesting silhouette cases, because a CT's air/tissue and
// tissue/bone steps give the gradient something much sharper to work with.
const VOLUMES = {
  mni152: { url: '/volumes/mni152.nii.gz' },
  chris_t1: { url: '/volumes/chris_t1.nii.gz' },
  visiblehuman: { url: '/volumes/visiblehuman.nii.gz' },
  torso: { url: '/volumes/torso.nii.gz' },
}

// These volumes all fit in one texture, so the tiling is FORCED rather than
// required: chunkVolumeGrid splits the volume into the selected grid regardless
// of whether any device limit demanded it. The limit passed here just has to
// exceed the largest brick edge.
const DEVICE_LIMIT = 4096
// Match the renderer's per-chunk gradient halo so brick faces stay seam-free.
// See the header: without this every cut face becomes a false edge.
const HALO = [3, 3, 3]

async function ensureTiled() {
  const vol = nv1.volumes?.[0]
  if (!vol?.dimsRAS) return
  const n = parseInt(gridSelect.value, 10)
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
  const scale = parseInt(explode.value, 10) / 100
  const on = scale > 1.001
  vol.chunkExplode = on
    ? { enabled: true, scale: [scale, scale, scale] }
    : { enabled: false }
  explodeVal.textContent = on ? `${scale.toFixed(2)}x` : 'off'
  nv1.drawScene()
}

// Repo convention: ?backend=webgl2 preselects the fallback so the same page can
// be verified on either backend from the URL.
const initialBackend =
  new URLSearchParams(location.search).get('backend') === 'webgl2'
    ? 'webgl2'
    : 'webgpu'
backend.value = initialBackend

const nv1 = new NiiVue({
  backend: initialBackend,
  backgroundColor: [0.1, 0.1, 0.12, 1],
  matcaps: { Cortex: cortex, Shiny: shiny },
  showRender: SHOW_RENDER.ALWAYS,
})
nv1.addEventListener('locationChange', (e) => {
  document.getElementById('location').innerHTML =
    `&nbsp;&nbsp;${e.detail.string}`
})
await nv1.attachToCanvas(gl1)

opacitySlider.oninput = function () {
  nv1.volumeGradientOpacity = Number(this.value) / 100
}
silhouetteSlider.oninput = function () {
  nv1.volumeSilhouette = Number(this.value) / 100
}
gradSlider.oninput = function () {
  nv1.volumeIllumination = Number(this.value) / 100
  matcapSelect.disabled = Number(this.value) < 1
}
matcapSelect.onchange = async function () {
  await nv1.loadMatcap(this.value)
}
// A depth of 2 is the "no clip" sentinel (the shaders read clipPlane.a > 1 as
// off). Off by default here: exploding is this page's way of getting inside, and
// the two cutting mechanisms are easier to read one at a time.
clipCheck.onclick = function () {
  nv1.setClipPlane([this.checked ? 0.35 : 2, 290, 0])
}
explode.oninput = applyExplode
gridSelect.onchange = async () => {
  await ensureTiled()
  applyExplode()
}
volumeSelect.onchange = async function () {
  await nv1.loadVolumes([VOLUMES[this.value]])
  // A new volume carries no chunkPlan, so re-tile before re-applying the offset.
  await ensureTiled()
  applyExplode()
}
backend.onchange = async function () {
  await nv1.reinitializeView({ backend: this.value })
  // The rebuilt view must re-tile from the model's persisted chunkPlan and get
  // the explode offset re-applied; the gradient sliders live in the model and
  // survive on their own.
  await ensureTiled()
  applyExplode()
}

nv1.sliceType = 4
await nv1.loadVolumes([VOLUMES[volumeSelect.value]])
await ensureTiled()
await nv1.loadMatcap(matcapSelect.value)
opacitySlider.oninput()
silhouetteSlider.oninput()
gradSlider.oninput()
clipCheck.onclick()
applyExplode()
// Explicit: assigning a property the value it already holds is a no-op, so the
// first frame can otherwise land before the volume is uploaded.
nv1.drawScene()

window.nv1 = nv1

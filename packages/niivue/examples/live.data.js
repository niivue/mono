import NiiVue, { SHOW_RENDER } from '../src/index.ts'

// Live data updates: animate voxels and mesh vertices that are already loaded.
//
// - Voxels: a glowing blob orbits through the brain. Each frame edits the
//   overlay's `img` in place and calls `updateVolumeData(1)`, which re-uploads
//   it into the existing GPU texture (no texture reallocation, no mesh rebuild).
// - Mesh: the left hemisphere ripples. Each frame writes displaced vertices
//   with `updateMeshPositions(0, positions)`, which rewrites the existing
//   vertex buffer (no rebuild of other meshes).

const nv1 = new NiiVue({
  backgroundColor: [0, 0, 0, 1],
  isColorbarVisible: false,
  // Always include the 3D tile so the rippling surface is visible.
  showRender: SHOW_RENDER.ALWAYS,
  // On 2D slices, draw only the mesh within 2 mm of the slice plane, so the
  // surface shows as a contour and does not hide the animated voxels.
  meshThicknessOn2D: 2,
  // Let the mesh show faintly where the volume would otherwise hide it.
  meshXRay: 0.1,
})
window.nv1 = nv1
await nv1.attachToCanvas(gl1)
await nv1.loadVolumes([
  { url: '/volumes/mni152.nii.gz', colormap: 'gray' },
  // Any volume on the background's grid works as the animated overlay; its
  // voxels are overwritten below, so the mask's own contents never show.
  {
    url: '/volumes/mni152_mask.nii.gz',
    colormap: 'warm',
    calMin: 30,
    calMax: 255,
    isColorbarVisible: false,
  },
])
await nv1.loadMeshes([
  { url: '/meshes/BrainMesh_ICBM152.lh.mz3', color: [0.4, 0.7, 1, 1] },
])
nv1.azimuth = 110
// Cut the underlay volume at the midline, removing the left hemisphere, so the
// left-hemisphere mesh is not hidden inside the volume rendering. The clip
// plane applies to volumes only; meshes are drawn whole.
nv1.setClipPlane([0, 270, 0])
nv1.elevation = 15

// ---- voxels: an orbiting gaussian blob -------------------------------------

const overlay = nv1.volumes[1]
const [, nx, ny, nz] = overlay.dims
const img = overlay.img
img.fill(0)
const BLOB_RADIUS = 14 // voxels
// Only the blob's bounding box is touched each frame: clear the previous box,
// write the new one. Rewriting all ~11M voxels per frame would dominate.
let prevBox = null

function clearBox(box) {
  for (let z = box[4]; z <= box[5]; z++) {
    for (let y = box[2]; y <= box[3]; y++) {
      const row = (z * ny + y) * nx
      img.fill(0, row + box[0], row + box[1] + 1)
    }
  }
}

function drawBlob(t) {
  // Orbit within the axial plane through the volume centre (where the
  // crosshair starts), bobbing less than a radius, so the axial slice always
  // cuts the blob and the coronal/sagittal slices catch it as it passes.
  const cx = nx / 2 + Math.cos(t) * nx * 0.22
  const cy = ny / 2 + Math.sin(t) * ny * 0.22
  const cz = nz / 2 + Math.sin(t * 0.7) * BLOB_RADIUS * 0.4
  const box = [
    Math.max(0, Math.floor(cx - BLOB_RADIUS)),
    Math.min(nx - 1, Math.ceil(cx + BLOB_RADIUS)),
    Math.max(0, Math.floor(cy - BLOB_RADIUS)),
    Math.min(ny - 1, Math.ceil(cy + BLOB_RADIUS)),
    Math.max(0, Math.floor(cz - BLOB_RADIUS)),
    Math.min(nz - 1, Math.ceil(cz + BLOB_RADIUS)),
  ]
  if (prevBox) clearBox(prevBox)
  const sigma2 = (BLOB_RADIUS / 2) ** 2
  const radius2 = BLOB_RADIUS ** 2
  for (let z = box[4]; z <= box[5]; z++) {
    for (let y = box[2]; y <= box[3]; y++) {
      const row = (z * ny + y) * nx
      for (let x = box[0]; x <= box[1]; x++) {
        const d2 = (x - cx) ** 2 + (y - cy) ** 2 + (z - cz) ** 2
        img[row + x] =
          d2 > radius2 ? 0 : Math.round(255 * Math.exp(-d2 / (2 * sigma2)))
      }
    }
  }
  prevBox = box
}

// ---- mesh: a ripple travelling across the hemisphere -----------------------

const mesh = nv1.meshes[0]
const basePositions = mesh.positions.slice()
const nVert = basePositions.length / 3
// Ripple outward from the mesh centroid so the surface breathes in and out.
const centroid = [0, 0, 0]
for (let i = 0; i < basePositions.length; i++) {
  centroid[i % 3] += basePositions[i] / nVert
}
const directions = new Float32Array(basePositions.length)
for (let v = 0; v < nVert; v++) {
  const dx = basePositions[v * 3] - centroid[0]
  const dy = basePositions[v * 3 + 1] - centroid[1]
  const dz = basePositions[v * 3 + 2] - centroid[2]
  const len = Math.hypot(dx, dy, dz) || 1
  directions[v * 3] = dx / len
  directions[v * 3 + 1] = dy / len
  directions[v * 3 + 2] = dz / len
}
const RIPPLE_MM = 3
const RIPPLE_WAVELENGTH_MM = 40
const nextPositions = new Float32Array(basePositions.length)

function rippleMesh(t) {
  for (let v = 0; v < nVert; v++) {
    const i = v * 3
    // Wave travels front to back (along y).
    const phase = (basePositions[i + 1] / RIPPLE_WAVELENGTH_MM) * 2 * Math.PI
    const offset = RIPPLE_MM * Math.sin(phase - t * 2)
    nextPositions[i] = basePositions[i] + directions[i] * offset
    nextPositions[i + 1] = basePositions[i + 1] + directions[i + 1] * offset
    nextPositions[i + 2] = basePositions[i + 2] + directions[i + 2] * offset
  }
  nv1.updateMeshPositions(0, nextPositions)
}

// ---- animation loop ---------------------------------------------------------

let t = 0
let last = performance.now()
let volumeBusy = false
let frames = 0
let voxelMs = 0
let meshMs = 0
let statsSince = performance.now()

function tick(now) {
  const dt = (now - last) / 1000
  last = now
  t += dt * (speedSlider.value / 10)
  // updateVolumeData is async; skip a voxel frame while the previous upload is
  // still in flight rather than queueing edits behind it.
  if (voxelCheck.checked && !volumeBusy) {
    const start = performance.now()
    drawBlob(t)
    volumeBusy = true
    nv1
      .updateVolumeData(1)
      .catch((e) => console.error(e))
      .finally(() => {
        volumeBusy = false
        voxelMs += performance.now() - start
      })
  }
  if (meshCheck.checked) {
    const start = performance.now()
    rippleMesh(t)
    meshMs += performance.now() - start
  }
  frames++
  const elapsed = now - statsSince
  if (elapsed > 1000) {
    const parts = [`${((frames * 1000) / elapsed).toFixed(0)} fps`]
    if (voxelCheck.checked) {
      parts.push(`voxel update ${(voxelMs / frames).toFixed(1)} ms`)
    }
    if (meshCheck.checked) {
      parts.push(
        `mesh update ${(meshMs / frames).toFixed(1)} ms (${nVert.toLocaleString()} vertices)`,
      )
    }
    stats.textContent = parts.join(' | ')
    frames = 0
    voxelMs = 0
    meshMs = 0
    statsSince = now
  }
  requestAnimationFrame(tick)
}
requestAnimationFrame(tick)

// ---- controls ---------------------------------------------------------------

sliceType.onchange = () => {
  nv1.sliceType = parseInt(sliceType.value, 10)
}
voxelCheck.onchange = () => {
  if (voxelCheck.checked) return
  // Leave the overlay empty rather than frozen mid-orbit.
  if (prevBox) clearBox(prevBox)
  prevBox = null
  nv1.updateVolumeData(1)
}
meshCheck.onchange = () => {
  if (!meshCheck.checked) nv1.updateMeshPositions(0, basePositions)
}
webgpuCheck.onchange = async function () {
  await nv1.reinitializeView({ backend: this.checked ? 'webgpu' : 'webgl2' })
}

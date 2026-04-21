import NiiVue from '../src/index.ts'

// Tract scalar layer names (derived from filenames by the loader, extension stripped)
const dpvName = 'mni152.SLF1_R' // from mni152.SLF1_R.tsf
const dpsName = 'mni152.SLF1_R' // from mni152.SLF1_R.txt

sliceType.onchange = () => {
  nv1.sliceType = parseInt(sliceType.value, 10)
}

radiusSlide.oninput = async function () {
  await nv1.setTractOptions(0, { fiberRadius: this.value * 0.1 })
}

webgpuCheck.onclick = function () {
  nv1.reinitializeView({ backend: this.checked ? 'webgpu' : 'webgl2' })
}

/** Update the Min slider range to match the active scalar overlay. */
function updateSliderRange() {
  const mesh = nv1.meshes[0]
  if (!mesh?.trx) return
  const mode = fiberColor.value
  let meta = null
  if (mode === 'dpv') meta = mesh.trx.dpvMeta[dpvName]
  else if (mode === 'dps') meta = mesh.trx.dpsMeta[dpsName]
  if (meta) {
    calMinSlide.min = Math.floor(meta.global_min)
    calMinSlide.max = Math.ceil(meta.global_max)
    calMinSlide.value = Math.floor(meta.global_min)
  }
}

fiberColor.onchange = async function () {
  const mode = this.value
  if (mode === 'dpv') {
    await nv1.setTractOptions(0, {
      colorBy: `dpv:${dpvName}`,
      colormap: fiberColormap.value,
    })
  } else if (mode === 'dps') {
    await nv1.setTractOptions(0, {
      colorBy: `dps:${dpsName}`,
      colormap: fiberColormap.value,
    })
  } else {
    await nv1.setTractOptions(0, { colorBy: mode })
  }
  updateSliderRange()
}

fiberColormap.onchange = async function () {
  await nv1.setTractOptions(0, { colormap: this.value })
}

calMinSlide.oninput = async function () {
  await nv1.setTractOptions(0, { calMin: parseFloat(this.value) })
}

const nv1 = new NiiVue({ backgroundColor: [0, 0, 0, 1] })
await nv1.attachToCanvas(gl1)
nv1.sliceType = 4
nv1.setClipPlanes([
  [0.1, 180, 20],
  [0.1, 0, -20],
])
await nv1.loadVolumes([{ url: '/volumes/mni152.nii.gz' }])
// Load TCK tract with TSF (per-vertex) and TXT (per-streamline) scalar layers
await nv1.loadMeshes([
  {
    url: '/meshes/tract.SLF1_R.tck',
    rgba255: [0, 255, 255, 255],
    layers: [
      { url: '/meshes/mni152.SLF1_R.tsf' },
      { url: '/meshes/mni152.SLF1_R.txt' },
    ],
    tractOptions: { colorBy: `dpv:${dpvName}`, colormap: 'inferno' },
  },
])

// Log scalar ranges from metadata
const mesh = nv1.meshes[0]
const dpvMeta = mesh.trx.dpvMeta[dpvName]
const dpsMeta = mesh.trx.dpsMeta[dpsName]
if (dpvMeta) console.log('dpv range:', dpvMeta.global_min, dpvMeta.global_max)
if (dpsMeta) console.log('dps range:', dpsMeta.global_min, dpsMeta.global_max)

// Set initial slider range to match the active dpv overlay
updateSliderRange()

import NiiVue from '../src/index.ts'

// Tiled (oversized) volume demo.
//
// A volume is split into per-chunk 3D sub-textures whenever any axis exceeds
// the GPU's `maxTextureDimension3D`. Real GPUs report a limit (2048+) far
// larger than ordinary medical images, so the tiled path almost never runs
// on normal data. The `maxTextureDimension3D` constructor option caps that
// limit artificially: with `128`, an ordinary ~200-voxel volume tiles into a
// 2x2x2 grid of chunks, exercising every chunked layer (background, overlay,
// PAQD, drawing) across both backends and both render paths.

const params = new URLSearchParams(window.location.search)
const max3d = parseInt(params.get('max3d') ?? '128', 10)
const backend = params.get('backend') === 'webgl2' ? 'webgl2' : 'webgpu'

// Reflect URL params in the controls.
limitSelect.value = String(Number.isFinite(max3d) ? max3d : 128)
webgpuCheck.checked = backend === 'webgpu'

const PAQD_LUT =
  'https://niivue.github.io/niivue-demo-images/Cerebellum/atl-Anatom.json'

let chunkInfo = ''
let locationInfo = ''

function renderFooter() {
  const sep = chunkInfo && locationInfo ? ' | ' : ''
  document.getElementById('location').innerHTML =
    `&nbsp;&nbsp;${chunkInfo}${sep}${locationInfo}`
}

function describeChunking() {
  const plan = nv1.volumes[0]?.chunkPlan
  if (!plan) {
    chunkInfo = 'background: single texture (not tiled)'
  } else {
    const g = plan.gridDims
    chunkInfo = `background: tiled ${g[0]}x${g[1]}x${g[2]} = ${plan.chunks.length} chunks`
  }
  renderFooter()
}

async function loadLayers(kind) {
  if (kind === 'overlay') {
    await nv1.loadVolumes([
      { url: '/volumes/mni152.nii.gz' },
      {
        url: '/volumes/spmMotor.nii.gz',
        colormap: 'warm',
        calMin: 4,
        calMax: 8,
      },
    ])
  } else if (kind === 'paqd') {
    await nv1.loadVolumes([
      { url: '/volumes/MNI152NLin6AsymC.nii.gz' },
      { url: '/volumes/atl-Anatom.nii.gz' },
    ])
    await nv1.setColormapLabelFromUrl(1, PAQD_LUT)
  } else {
    await nv1.loadVolumes([{ url: '/volumes/mni152.nii.gz' }])
  }
  describeChunking()
}

sliceType.onchange = () => {
  nv1.sliceType = parseInt(sliceType.value, 10)
}

limitSelect.onchange = function () {
  // The override is applied when the view initializes, so reload the page
  // with the new value. `0` removes the override (uses the real GPU limit).
  params.set('max3d', this.value)
  params.set('backend', webgpuCheck.checked ? 'webgpu' : 'webgl2')
  window.location.search = params.toString()
}

layerSelect.onchange = async function () {
  if (drawCheck.checked) {
    drawCheck.checked = false
    nv1.closeDrawing()
  }
  await loadLayers(this.value)
}

drawCheck.onchange = function () {
  if (this.checked) {
    nv1.createEmptyDrawing()
    nv1.drawIsEnabled = true
    nv1.drawPenValue = 1
    nv1.drawOpacity = 0.6
  } else {
    nv1.closeDrawing()
  }
}

webgpuCheck.onchange = function () {
  nv1.reinitializeView({ backend: this.checked ? 'webgpu' : 'webgl2' })
}

antiAliasCheck.onchange = function () {
  nv1.reinitializeView({ isAntiAlias: this.checked })
}

function handleLocationChange(data) {
  locationInfo = data.string
  renderFooter()
}

const nv1 = new NiiVue({
  backend,
  backgroundColor: [0.1, 0.1, 0.2, 1],
  // Debug override: 0 disables it (use the real GPU limit).
  maxTextureDimension3D: max3d > 0 ? max3d : undefined,
})
nv1.addEventListener('locationChange', (e) => handleLocationChange(e.detail))
await nv1.attachToCanvas(gl1)
sliceType.onchange()
await loadLayers(layerSelect.value)
nv1.volumeIllumination = 0.4

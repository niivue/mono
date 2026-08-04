import NiiVue from '../src/index.ts'

const nv1 = new NiiVue({
  backgroundColor: [0.3, 0, 0.1, 1],
  bounds: [
    [0, 0],
    [0.5, 1],
  ],
  showBoundsBorder: true,
  boundsBorderColor: [0.3, 0.3, 0.3, 1],
  boundsBorderThickness: 2,
  backend: 'webgpu',
})
const nv2 = new NiiVue({
  backgroundColor: [0.15, 0.15, 0.3, 1],
  bounds: [
    [0.5, 0],
    [1, 1],
  ],
  showBoundsBorder: true,
  boundsBorderColor: [0.3, 0.3, 0.3, 1],
  boundsBorderThickness: 2,
  backend: 'webgpu',
})

// Both instances share one canvas, so the WebGPU init fallback is declined by
// design (swapping the canvas would desync the sibling). On a machine without a
// WebGPU adapter the attach therefore throws instead of dropping to WebGL2. The
// library paints its own centered overlay; this reports the specific error too,
// so the failure is legible rather than an uncaught rejection in the console.
async function main() {
  await nv1.attachToCanvas(gl1)
  await nv2.attachToCanvas(gl1)

  await nv1.loadVolumes([{ url: '/volumes/mni152.nii.gz' }])
  await nv1.loadMeshes([
    {
      url: '/meshes/BrainMesh_ICBM152.lh.mz3',
      color: [0.3, 0.8, 0.7, 1],
      shaderType: 'outline',
    },
  ])

  await nv2.loadVolumes([{ url: '/volumes/mni152.nii.gz', colormap: 'hot' }])
  await nv2.loadMeshes([
    { url: '/meshes/BrainMesh_ICBM152.lh.mz3', color: [0.7, 0.5, 1, 1] },
  ])

  // Wired only once both instances are live: every handler below drives an
  // attached view, and the initial broadcast fires immediately.
  wireControls()
}

// Bounds controls
function parseBounds(str) {
  const parts = str.split(',').map(parseFloat)
  return parts
}

function wireControls() {
  // Slice type control
  sliceType.onchange = () => {
    nv1.sliceType = parseInt(sliceType.value, 10)
    nv2.sliceType = parseInt(sliceType.value, 10)
  }

  bounds1.onchange = () => {
    nv1.setBounds(parseBounds(bounds1.value))
    // Redraw nv2 too since canvas is shared
    nv2.drawScene()
  }

  bounds2.onchange = () => {
    nv2.setBounds(parseBounds(bounds2.value))
    // Redraw nv1 too since canvas is shared
    nv1.drawScene()
  }

  // Broadcast control
  broadcastSelect.onchange = () => {
    const v = parseInt(broadcastSelect.value, 10)
    if (v > 0) {
      nv1.broadcastTo([nv2])
      nv2.broadcastTo([nv1])
    } else {
      nv1.broadcastTo()
      nv2.broadcastTo()
    }
  }
  // Apply initial broadcast
  broadcastSelect.onchange()

  // WebGPU toggle
  webgpuCheck.onchange = async function () {
    await nv1.reinitializeView({ backend: this.checked ? 'webgpu' : 'webgl2' })
    await nv2.reinitializeView({ backend: this.checked ? 'webgpu' : 'webgl2' })
  }

  saveNv1.onclick = async () => {
    await nv1.saveBitmap('nv1.png')
  }

  saveNv2.onclick = async () => {
    await nv2.saveBitmap('nv2.png')
  }
}

main().catch((err) => {
  console.error('bounds demo setup failed', err)
  document.getElementById('location').textContent =
    `  Could not start the viewers: ${err?.message ?? err}`
})

import NiiVue from '../src/index.ts'

// Each instance has its own controls; the copy buttons move the whole scene
// (volumes, meshes, settings) between them as an in-memory NVD document.
const nv1 = new NiiVue({ backgroundColor: [0.2, 0.2, 0.3, 1] })
await nv1.attachToCanvas(gl1)
await nv1.loadVolumes([{ url: '/volumes/mni152.nii.gz' }])

const nv2 = new NiiVue({ backgroundColor: [0, 0, 0, 1] })
await nv2.attachToCanvas(gl2)
nv2.sliceType = 4
await nv2.loadMeshes([{ url: '/meshes/BrainMesh_ICBM152.lh.mz3' }])

// A copy replaces the receiving scene, so its controls are refreshed from the
// scene it now shows (layout, colormap, shader, azimuth all travel with it).
function syncTop() {
  sliceType.value = String(nv1.sliceType)
  colormapSelect.disabled = nv1.volumes.length === 0
  colormapSelect.value = nv1.volumes[0]?.colormap ?? ''
}
function syncBottom() {
  shaderSelect.disabled = nv2.meshes.length === 0
  if (nv2.meshes.length) shaderSelect.value = nv2.meshes[0].shaderType
  azimuth.value = String(Math.round(nv2.azimuth))
}

async function copyScene(from, to, sync) {
  // One copy at a time: a second click could serialize a half-loaded scene.
  topToBottom.disabled = bottomToTop.disabled = true
  const t = performance.now()
  try {
    const bytes = from.serializeDocument()
    await to.loadDocument(new File([bytes], 'scene.nvd'))
    copyStatus.textContent = `Copied ${(bytes.length / 1e6).toFixed(1)} MB in ${Math.round(performance.now() - t)} ms`
  } catch (err) {
    copyStatus.textContent = `Copy failed: ${err.message}`
  } finally {
    sync()
    topToBottom.disabled = bottomToTop.disabled = false
  }
}
topToBottom.onclick = () => copyScene(nv1, nv2, syncBottom)
bottomToTop.onclick = () => copyScene(nv2, nv1, syncTop)

sliceType.onchange = () => {
  nv1.sliceType = parseInt(sliceType.value, 10)
}
for (const name of nv1.colormaps) colormapSelect.add(new Option(name))
colormapSelect.onchange = () => {
  if (nv1.volumes.length) nv1.setVolume(0, { colormap: colormapSelect.value })
}

for (const shader of nv2.meshShaders) shaderSelect.add(new Option(shader))
shaderSelect.onchange = () => {
  for (let i = 0; i < nv2.meshes.length; i++)
    nv2.setMesh(i, { shaderType: shaderSelect.value })
}
azimuth.oninput = () => {
  nv2.azimuth = parseInt(azimuth.value, 10)
}
// Dragging the 3D view rotates it too; keep the slider in step.
nv2.addEventListener('azimuthElevationChange', (e) => {
  azimuth.value = String(Math.round(e.detail.azimuth))
})
syncTop()
syncBottom()

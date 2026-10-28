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

async function copyScene(from, to) {
  const t = performance.now()
  const bytes = from.serializeDocument()
  await to.loadDocument(new File([bytes], 'scene.nvd'))
  copyStatus.textContent = `Copied ${(bytes.length / 1e6).toFixed(1)} MB in ${Math.round(performance.now() - t)} ms`
}
topToBottom.onclick = () => copyScene(nv1, nv2)
bottomToTop.onclick = () => copyScene(nv2, nv1)

sliceType.onchange = () => {
  nv1.sliceType = parseInt(sliceType.value, 10)
}
for (const name of nv1.colormaps) colormapSelect.add(new Option(name))
colormapSelect.value = nv1.volumes[0].colormap
colormapSelect.onchange = () => {
  if (nv1.volumes.length) nv1.setVolume(0, { colormap: colormapSelect.value })
}

for (const shader of nv2.meshShaders) shaderSelect.add(new Option(shader))
shaderSelect.value = 'phong'
shaderSelect.onchange = () => {
  for (let i = 0; i < nv2.meshes.length; i++)
    nv2.setMesh(i, { shaderType: shaderSelect.value })
}
azimuth.oninput = () => {
  nv2.azimuth = parseInt(azimuth.value, 10)
}

import { ubuntu } from '../src/assets/fonts'
import { cortex } from '../src/assets/matcaps'
import NiiVue from '../src/index.ts'

const gl1 = document.getElementById('gl1')

const edgeScale = document.getElementById('edgeScale')
const fileSelect = document.getElementById('fileSelect')
const legendCheck = document.getElementById('legendCheck')
const nodeScale = document.getElementById('nodeScale')
const shaderSelect = document.getElementById('shaderSelect')
const sliceType = document.getElementById('sliceType')
const webgpuCheck = document.getElementById('webgpuCheck')

sliceType.onchange = () => {
  nv1.sliceType = parseInt(sliceType.value, 10)
}
legendCheck.onclick = async function () {
  const meshes = nv1.model.getMeshes()
  if (meshes.length > 0) {
    nv1.setMesh(meshes.length - 1, { isLegendVisible: this.checked })
  }
}
fileSelect.onchange = async () => {
  await nv1.loadMeshes([
    {
      url: `/meshes/${fileSelect.value}.jcon`,
      isLegendVisible: legendCheck.checked,
    },
  ])
}
shaderSelect.onchange = () => {
  const meshes = nv1.model.getMeshes()
  if (meshes.length < 1) return
  nv1.setMesh(meshes.length - 1, { shaderType: shaderSelect.value })
}
nodeScale.oninput = async () => {
  const meshes = nv1.model.getMeshes()
  if (meshes.length < 1) return
  await nv1.setConnectomeOptions(0, { nodeScale: parseFloat(nodeScale.value) })
}
edgeScale.oninput = async () => {
  const meshes = nv1.model.getMeshes()
  if (meshes.length < 1) return
  await nv1.setConnectomeOptions(0, { edgeScale: parseFloat(edgeScale.value) })
}

webgpuCheck.onchange = async function () {
  await nv1.reinitializeView({ backend: this.checked ? 'webgpu' : 'webgl2' })
}
const nv1 = new NiiVue({
  backgroundColor: [0.15, 0.15, 0.25, 1],
  font: ubuntu,
  matcaps: { cortex },
})
await nv1.attachToCanvas(gl1)
for (const shader of nv1.meshShaders) {
  const option = document.createElement('option')
  option.value = shader
  option.textContent = shader.charAt(0).toUpperCase() + shader.slice(1)
  shaderSelect.appendChild(option)
}
nv1.sliceType = 4
nv1.clipPlaneColor = [0, 0, 0, 0]
nv1.setClipPlanes([
  [0.15, 180, 0],
  [-0.1, 0, 0],
])
await nv1.loadVolumes([{ url: '/volumes/mni152.nii.gz' }])
await fileSelect.onchange()

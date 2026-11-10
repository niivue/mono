import { ubuntu } from '../src/assets/fonts'
import { cortex } from '../src/assets/matcaps'
import NiiVue from '../src/index.ts'

const gl1 = document.getElementById('gl1')

const decimation = document.getElementById('decimation')
const fileSelect = document.getElementById('fileSelect')
const radius = document.getElementById('radius')
const shaderSelect = document.getElementById('shaderSelect')
const sides = document.getElementById('sides')
const sliceType = document.getElementById('sliceType')
const webgpuCheck = document.getElementById('webgpuCheck')

sliceType.onchange = () => {
  nv1.sliceType = parseInt(sliceType.value, 10)
}

fileSelect.onchange = async () => {
  await nv1.loadMeshes([{ url: `/meshes/${fileSelect.value}` }])
}
shaderSelect.onchange = () => {
  const meshes = nv1.model.getMeshes()
  if (meshes.length < 1) return
  nv1.setMesh(meshes.length - 1, { shaderType: shaderSelect.value })
}
radius.oninput = async () => {
  const meshes = nv1.model.getMeshes()
  if (meshes.length < 1) return
  await nv1.setTractOptions(0, { fiberRadius: parseFloat(radius.value) })
}

sides.oninput = async () => {
  const meshes = nv1.model.getMeshes()
  if (meshes.length < 1) return
  await nv1.setTractOptions(0, { fiberSides: parseInt(sides.value, 10) })
}

decimation.oninput = async () => {
  const meshes = nv1.model.getMeshes()
  if (meshes.length < 1) return
  await nv1.setTractOptions(0, { decimation: parseInt(decimation.value, 10) })
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
nv1.sliceType = 4 // render
fileSelect.onchange()

import NiiVue from '../src/index.ts'

sliceType.onchange = () => {
  nv1.sliceType = parseInt(sliceType.value, 10)
}

function updateThresholds() {
  const mnNeg = slideMinNeg.value * -0.1
  const mxNeg = mnNeg + slideRangeNeg.value * -0.1
  const mn = slideMin.value * 0.1
  const mx = mn + slideRange.value * 0.1
  const cmapType = alphaMode.selectedIndex
  // With colormapNegative set, a zero negative range (both -Thresh and -Range at
  // 0) makes negative values fully transparent. Leaving calMinNeg/calMaxNeg unset
  // is NOT equivalent: they default to NaN, which falls back to the positive
  // [calMin, calMax] range and mirrors positive thresholds onto negative values.
  const settings = {
    colormap: colormapSelect.value,
    colormapNegative: 'winter',
    calMinNeg: mnNeg,
    calMaxNeg: mxNeg,
    calMin: mn,
    calMax: mx,
    colormapType: cmapType,
  }
  nv1.setMeshLayerProperty(0, 1, settings)
}
slideMin.oninput = () => {
  updateThresholds()
}
slideRange.oninput = () => {
  updateThresholds()
}
slideMinNeg.oninput = () => {
  updateThresholds()
}
slideRangeNeg.oninput = () => {
  updateThresholds()
}
alphaMode.onchange = () => {
  updateThresholds()
}
colormapSelect.onchange = () => {
  updateThresholds()
}

webgpuCheck.onchange = async function () {
  await nv1.reinitializeView({ backend: this.checked ? 'webgpu' : 'webgl2' })
}

shaderSelect.onchange = () => {
  const meshes = nv1.model.getMeshes()
  if (meshes.length < 1) return
  nv1.setMesh(meshes.length - 1, { shaderType: shaderSelect.value })
}

crosshairCheck.onchange = function () {
  nv1.crosshairWidth = this.checked ? 1 : 0
  nv1.is3DCrosshairVisible = this.checked
}

saveBitmapBtn.onclick = async () => {
  await nv1.saveBitmap('mesh.layers.png')
}

orientCubeCheck.onchange = function () {
  nv1.isOrientCubeVisible = this.checked
}

colorBtn.addEventListener('input', (event) => {
  const hex = event.target.value
  nv1.backgroundColor = [
    parseInt(hex.slice(1, 3), 16) / 255,
    parseInt(hex.slice(3, 5), 16) / 255,
    parseInt(hex.slice(5, 7), 16) / 255,
    1.0,
  ]
})

const nv1 = new NiiVue({
  backgroundColor: [0, 0, 0, 1],
  crosshairWidth: 0,
  is3DCrosshairVisible: false,
  isOrientCubeVisible: false,
})
await nv1.attachToCanvas(gl1)
for (const shader of nv1.meshShaders) {
  const option = document.createElement('option')
  option.value = shader
  option.textContent = shader.charAt(0).toUpperCase() + shader.slice(1)
  shaderSelect.appendChild(option)
}
shaderSelect.value = 'matte'
for (const cmap of nv1.colormaps) {
  const option = document.createElement('option')
  option.value = cmap
  option.textContent = cmap.charAt(0).toUpperCase() + cmap.slice(1)
  if (cmap.toLowerCase() === 'warm') {
    option.selected = true
  }
  colormapSelect.appendChild(option)
}

await nv1.loadMeshes([
  {
    url: '/meshes/BrainMesh_ICBM152.lh.mz3',
    shaderType: 'matte',
    layers: [
      {
        url: '/meshes/BrainMesh_ICBM152.lh.curv',
        colormap: 'gray',
        calMin: 0.3,
        calMax: 0.5,
        opacity: 1,
        isColorbarVisible: false,
      },
      {
        url: '/meshes/BrainMesh_ICBM152.lh.motor.mz3',
        calMin: 1.5,
        calMax: 5,
        calMinNeg: -1.5,
        calMaxNeg: -2,
        colormap: 'warm',
        colormapNegative: 'winter',
        opacity: 0.7,
      },
    ],
  },
])

nv1.sliceType = 4
updateThresholds()

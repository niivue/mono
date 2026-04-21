import { ubuntu } from '../src/assets/fonts'
import { cortex, shiny } from '../src/assets/matcaps'
import NiiVue from '../src/index.ts'

let isAnimating = false
let azimuth = 0
const elevation = 15
let lastTime = performance.now()
let frameCount = 0

saveBtn.onclick = () => {
  nv1.saveDocument('myScene.nvd')
}
saveMeshBtn.onclick = () => {
  // nv1.saveMesh(0, 'myMesh.iwm.cbor')
  nv1.saveMesh(0, 'myMesh.mz3')
}

saveVolBtn.onclick = () => {
  //nv1.saveVolume({ filename: 'myImage.iwi.cbor'})
  nv1.saveVolume({ filename: 'myImage.nii.gz' })
}

clipSelect.onchange = function () {
  const index = parseInt(this.value, 10) // selected option value as integer
  let planes = [[2.0, 180, 20]]
  switch (index) {
    case 1:
      planes = [[0.1, 180, 20]]
      break
    case 2:
      planes = [
        [0.1, 180, 20],
        [0.1, 0, -20],
      ]
      break
    case 3:
      planes = [
        [0.0, 90, 0], //right center
        [0.0, 0, -20], //posterior oblique
        [0.1, 0, -90], //inferior
      ]
      break
    case 4:
      planes = [
        [0.3, 270, 0], //left
        [0.3, 90, 0], //right
        [0.0, 180, 0], //anterior
        [0.1, 0, 0], //posterior
      ]
      break
    case 5:
      planes = [
        [0.4, 270, 0], //left
        [0.4, 90, 0], //right
        [0.4, 180, 0], //anterior
        [0.2, 0, 0], //posterior
        [0.1, 0, -90], //inferior
      ]
      break
    case 6:
      planes = [
        [0.4, 270, 0], //left
        [-0.1, 90, 0], //right
        [0.4, 180, 0], //anterior
        [0.2, 0, 0], //posterior
        [0.1, 0, -90], //inferior
        [0.3, 0, 90], //superior
      ]
      break
  }
  nv1.setClipPlanes(planes)
}
function animate(currentTime) {
  if (!isAnimating) return
  frameCount++
  const elapsed = currentTime - lastTime
  if (elapsed >= 1000) {
    const fps = Math.round((frameCount * 1000) / elapsed)
    fpsCounter.textContent = `FPS: ${fps}`
    frameCount = 0
    lastTime = currentTime
  }
  azimuth = (azimuth + 1) % 360
  nv1.azimuth = azimuth
  nv1.elevation = elevation
  requestAnimationFrame(animate)
}

animateCheck.onclick = () => {
  const wasAnimating = isAnimating
  isAnimating = animateCheck.checked
  if (isAnimating && !wasAnimating) {
    lastTime = performance.now()
    frameCount = 0
    requestAnimationFrame(animate)
  } else if (!isAnimating) {
    fpsCounter.textContent = 'FPS: --'
  }
}

radioCheck.onclick = function () {
  nv1.isRadiological = this.checked
}

xrayCheck.onclick = function () {
  nv1.meshXRay = +this.checked * 0.1
}

checkCutaway.onclick = function () {
  nv1.isClipPlaneCutaway = this.checked
}

colorbarCheck.onclick = function () {
  nv1.isColorbarVisible = this.checked
}

orientCheck.onclick = function () {
  nv1.isOrientCubeVisible = this.checked
  nv1.isOrientationTextVisible = this.checked
}

const parseNames = (input) => {
  if (!input || input === 'none') return []
  return input
    .split('+')
    .map((n) => n.trim())
    .filter(Boolean)
}

meshSelect.onchange = async () => {
  if (meshSelect.value === 'none') {
    await nv1.loadMeshes([])
    return
  }
  const names = parseNames(meshSelect.value)
  const meshList = names.map((n) => ({
    url: `/meshes/${n}.mz3`,
    opacity: Number(meshOpacitySlider.value) * 0.01,
    color: [1, 0.8, 1, 0.9],
    shaderType: shaderSelect.value,
  }))
  await nv1.loadMeshes(meshList)
}

volumeSelect.onchange = async () => {
  nv1.removeAllVolumes()
  if (volumeSelect.value === 'none') {
    return
  }
  const names = parseNames(volumeSelect.value)
  for (let i = 0; i < names.length; i++) {
    const name = names[i]
    const path = `/volumes/${name}.nii.gz`
    const clr = colormapSelect.value

    // Initialize the base options
    const opts = { colormap: clr }

    if (i === 1) {
      opts.colormap = 'warm'
      opts.calMin = 3
      opts.calMax = 6
    }

    await nv1.addVolume({ url: path, ...opts })
  }
}

colormapSelect.onchange = async () => {
  nv1.setVolume(0, { colormap: colormapSelect.value })
}

matcapSelect.onchange = async () => {
  await nv1.loadMatcap(matcapSelect.value)
}

gradSlider.oninput = () => {
  nv1.volumeIllumination = Number(gradSlider.value) / 100
  matcapSelect.disabled = Number(gradSlider.value) < 1
}

colorBtn.addEventListener('input', (event) => {
  const input = event.target
  const hex = input.value
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255
  nv1.backgroundColor = [r, g, b, 1.0]
})

dprSelect.onchange = async () => {
  let v = dprSelect.value.trim()
  if (v.toLowerCase() === 'auto') v = '-1'
  nv1.devicePixelRatio = parseFloat(v)
}

shaderSelect.onchange = () => {
  const meshes = nv1.model.getMeshes()
  if (meshes.length < 1) return
  nv1.setMesh(meshes.length - 1, { shaderType: shaderSelect.value })
}

meshOpacitySlider.oninput = () => {
  const meshes = nv1.model.getMeshes()
  if (meshes.length < 1) return
  nv1.setMesh(meshes.length - 1, {
    opacity: Number(meshOpacitySlider.value) * 0.01,
  })
}

sliceType.onchange = () => {
  nv1.sliceType = parseInt(sliceType.value, 10)
}

colorSelect.onchange = function () {
  const index = this.selectedIndex
  const clr = nv1.clipPlaneColor
  switch (index) {
    case 0:
      clr[3] = 0.0
      break
    case 1:
      clr[3] = 0.4
      break
    case 2:
      clr[3] = -0.2
      break
  }
  nv1.clipPlaneColor = clr
}

webgpuCheck.onchange = async function () {
  await nv1.reinitializeView({ backend: this.checked ? 'webgpu' : 'webgl2' })
}

antiAliasCheck.onchange = async () => {
  await nv1.reinitializeView({ isAntiAlias: antiAliasCheck.checked })
}

const api = webgpuCheck.checked ? 'webgpu' : 'webgl2'
const nv1 = new NiiVue({
  backend: api,
  backgroundColor: [0.4, 0.4, 0.45, 1],
  font: ubuntu,
  matcaps: { Cortex: cortex, Shiny: shiny },
})
await nv1.attachToCanvas(gl1)

for (const shader of nv1.meshShaders) {
  const option = document.createElement('option')
  option.value = shader
  option.textContent = shader.charAt(0).toUpperCase() + shader.slice(1)
  shaderSelect.appendChild(option)
}
for (const cmap of nv1.colormaps) {
  const option = document.createElement('option')
  option.value = cmap
  option.textContent = cmap.charAt(0).toUpperCase() + cmap.slice(1)
  if (cmap.toLowerCase() === 'gray') {
    option.selected = true
  }
  colormapSelect.appendChild(option)
}

nv1.volumeIsAlphaClipDark = true
gradSlider.oninput()
meshSelect.onchange()
clipSelect.onchange()
await volumeSelect.onchange()
checkCutaway.onclick()
colorSelect.onchange()
colorbarCheck.onclick()

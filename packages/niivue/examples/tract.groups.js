import NiiVue from '../src/index.ts'

sliceType.onchange = () => {
  nv1.sliceType = parseInt(sliceType.value, 10)
}

decimationSlide.oninput = async function () {
  await nv1.setTractOptions(0, { decimation: parseInt(this.value, 10) })
}

webgpuCheck.onclick = function () {
  nv1.reinitializeView({ backend: this.checked ? 'webgpu' : 'webgl2' })
}

function setThresholdVisible(show) {
  const display = show ? 'inline-block' : 'none'
  thresholdLabel.style.display = display
  thresholdSlide.style.display = display
}
// Mesh 0 is the tractography; meshes 1+ come from meshSelect and get shaderSelect
meshSelect.onchange = async () => {
  while (nv1.meshes.length > 1) await nv1.removeMesh(nv1.meshes.length - 1)
  if (meshSelect.value === 'none') return
  for (const name of meshSelect.value.split('+')) {
    await nv1.addMesh({
      url: `/meshes/${name}.mz3`,
      shaderType: shaderSelect.value,
      opacity: meshOpacitySlide.value * 0.1,
    })
  }
}

shaderSelect.onchange = () => {
  for (let i = 1; i < nv1.meshes.length; i++) {
    nv1.setMesh(i, { shaderType: shaderSelect.value })
  }
}

volumeOpacitySlide.oninput = async function () {
  await nv1.setVolume(0, { opacity: this.value * 0.1 })
}

// Skips mesh 0 so the streamlines stay opaque
meshOpacitySlide.oninput = async function () {
  for (let i = 1; i < nv1.meshes.length; i++) {
    await nv1.setMesh(i, { opacity: this.value * 0.1 })
  }
}

crosshairCheck.onclick = function () {
  nv1.is3DCrosshairVisible = this.checked
  nv1.crosshairWidth = this.checked ? 2 : 0
}
xrayCheck.onclick = function () {
  nv1.meshXRay = +this.checked * 0.005
}
thresholdSlide.oninput = async function () {
  await nv1.setTractOptions(0, { calMin: parseFloat(this.value) * 0.5 })
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

checkCutaway.onclick = function () {
  nv1.isClipPlaneCutaway = this.checked
}

colorBtn.oninput = function () {
  const hex = this.value
  const r = parseInt(hex.slice(1, 3), 16) / 255
  const g = parseInt(hex.slice(3, 5), 16) / 255
  const b = parseInt(hex.slice(5, 7), 16) / 255
  nv1.backgroundColor = [r, g, b, 1.0]
}

colorSelect.onchange = function () {
  const clr = nv1.clipPlaneColor
  clr[3] = [0.0, 0.4, -0.2][this.selectedIndex]
  nv1.clipPlaneColor = clr
}

fiberSelect.onchange = async function () {
  const mode = this.value
  setThresholdVisible(mode === 'zscore')

  if (mode === 'show0') {
    // First group only (green)
    const groupColors = { [groupNames[0]]: [0, 255, 0, 255] }
    await nv1.setTractOptions(0, { groupColors, colorBy: 'fixed' })
  } else if (mode === 'show1') {
    // Second group only (red)
    const groupColors = { [groupNames[1]]: [255, 0, 0, 255] }
    await nv1.setTractOptions(0, { groupColors, colorBy: 'fixed' })
  } else if (mode === 'show2') {
    // Third group only (blue)
    const groupColors = { [groupNames[2]]: [25, 25, 255, 255] }
    await nv1.setTractOptions(0, { groupColors, colorBy: 'fixed' })
  } else if (mode === 'show012') {
    // First three groups simultaneously (green, red, blue)
    const groupColors = {
      [groupNames[0]]: [0, 255, 0, 255],
      [groupNames[1]]: [255, 0, 0, 255],
      [groupNames[2]]: [25, 25, 255, 255],
    }
    await nv1.setTractOptions(0, { groupColors, colorBy: 'fixed' })
  } else if (mode === 'zscore') {
    // Per-group z-score scalar coloring (all streamlines visible)
    await nv1.setTractOptions(0, { groupColors: null, colorBy: 'dps:z_score' })
  } else {
    // Direction or fixed color (all streamlines visible)
    await nv1.setTractOptions(0, { groupColors: null, colorBy: mode })
  }
}

const nv1 = new NiiVue({ backgroundColor: [1, 1, 1, 1] })
await nv1.attachToCanvas(gl1)
for (const shader of nv1.meshShaders) {
  const option = document.createElement('option')
  option.value = shader
  option.textContent = shader.charAt(0).toUpperCase() + shader.slice(1)
  shaderSelect.appendChild(option)
}
shaderSelect.value = 'phong'
nv1.sliceType = 4
clipSelect.onchange()
nv1.volumeIllumination = 0.5
colorSelect.onchange()
await nv1.loadVolumes([{ url: '/volumes/mni152.nii.gz' }])
await nv1.loadMeshes([
  { url: '/meshes/yeh2022.trx', rgba255: [0, 142, 200, 255] },
])

// Get group names from the loaded tract
const groupNames = nv1.getTractGroups(0)

// Synthesize per-streamline z-score data from group membership
// (emulates the old dpg.html demo which created synthetic per-group data)
const mesh = nv1.meshes[0]
const nStreamlines = mesh.trx.offsets.length - 1
const zScores = new Float32Array(nStreamlines) // default 0
const groupZValues = [1.64, 3.32, 5.01] // z-scores for first three groups
for (let g = 0; g < Math.min(3, groupNames.length); g++) {
  const members = mesh.trx.groups[groupNames[g]]
  for (let i = 0; i < members.length; i++) {
    if (members[i] < nStreamlines) {
      zScores[members[i]] = groupZValues[g]
    }
  }
}
mesh.trx.dps.z_score = zScores
mesh.trx.dpsMeta.z_score = {
  global_min: 0,
  global_max: Math.max(...groupZValues),
}

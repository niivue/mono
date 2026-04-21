import NiiVue from "../src/index.ts"

// A palette of distinct colors for group selection (RGBA 0-255)
const groupPalette = [
  [230, 25, 75, 255], // red
  [60, 180, 75, 255], // green
  [0, 130, 200, 255], // blue
  [255, 225, 25, 255], // yellow
  [245, 130, 48, 255], // orange
  [145, 30, 180, 255], // purple
  [70, 240, 240, 255], // cyan
  [240, 50, 230, 255], // magenta
  [210, 245, 60, 255], // lime
  [250, 190, 212, 255], // pink
]

sliceType.onchange = () => {
  nv1.sliceType = parseInt(sliceType.value, 10)
}

decimationSlide.oninput = async function () {
  await nv1.setTractOptions(0, { decimation: parseInt(this.value, 10) })
}

webgpuCheck.onclick = function () {
  nv1.reinitializeView({ backend: this.checked ? "webgpu" : "webgl2" })
}

async function applyColor() {
  const mode = colorMode.value
  const group = groupSelect.value

  if (group) {
    // Single group selected: show only that group with palette color
    const groupColors = { [group]: groupPalette[0] }
    await nv1.setTractOptions(0, { groupColors, colorBy: mode })
  } else {
    // "All" selected: show all streamlines with the chosen color mode
    await nv1.setTractOptions(0, { groupColors: null, colorBy: mode })
  }
}

colorMode.onchange = applyColor

groupSelect.onchange = applyColor

const nv1 = new NiiVue({ backgroundColor: [1, 1, 1, 1] })
await nv1.attachToCanvas(gl1)
nv1.sliceType = 4
nv1.setClipPlanes([
  [0.1, 180, 20],
  [0.1, 0, -20],
])
await nv1.loadVolumes([{ url: "/volumes/mni152.nii.gz" }])
await nv1.loadMeshes([
  { url: "/meshes/yeh2022.trx", rgba255: [0, 142, 200, 255] },
])

// Populate group selector from the loaded tract data
const groups = nv1.getTractGroups(0)
for (const name of groups) {
  const opt = document.createElement("option")
  opt.value = name
  opt.textContent = name
  groupSelect.appendChild(opt)
}

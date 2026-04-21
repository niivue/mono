import NiiVue from "../src/index.ts"

sliceType.onchange = () => {
  nv1.sliceType = parseInt(sliceType.value, 10)
}

function updateThresholds() {
  const mnNeg = slideMinNeg.value * -0.1
  const mxNeg = mnNeg + slideRangeNeg.value * -0.1
  const mn = slideMin.value * 0.1
  const mx = mn + slideRange.value * 0.1
  const cmapType = alphaMode.selectedIndex
  nv1.setMeshLayerProperty(0, 1, {
    cal_minNeg: mnNeg,
    cal_maxNeg: mxNeg,
    calMin: mn,
    calMax: mx,
    colormapType: cmapType,
  })
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

webgpuCheck.onchange = async function () {
  await nv1.reinitializeView({ backend: this.checked ? "webgpu" : "webgl2" })
}

const nv1 = new NiiVue({ backgroundColor: [0.2, 0.2, 0.3, 1] })
await nv1.attachToCanvas(gl1)

await nv1.loadMeshes([
  {
    url: "/meshes/BrainMesh_ICBM152.lh.mz3",
    layers: [
      {
        url: "/meshes/BrainMesh_ICBM152.lh.curv",
        colormap: "gray",
        calMin: 0.3,
        calMax: 0.5,
        opacity: 1,
        isColorbarVisible: false,
      },
      {
        url: "/meshes/BrainMesh_ICBM152.lh.motor.mz3",
        calMin: 1.5,
        calMax: 5,
        cal_minNeg: -1.5,
        cal_maxNeg: -2,
        colormap: "warm",
        colormapNegative: "winter",
        opacity: 0.7,
      },
    ],
  },
])

nv1.sliceType = 4

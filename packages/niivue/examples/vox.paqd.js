import NiiVue from "../src/index.ts"

paqdSelect.onchange = function () {
  const _index = this.selectedIndex
  let paqdUniforms = [0.2, 0.7, 0.9, 0.4]
  switch (this.value) {
    case "rim":
      paqdUniforms = [0.2, 0.7, 0.9, 0.4]
      break
    case "opaque":
      paqdUniforms = [0.01, 0.5, 0.5, 1.0]
      break
    case "translucent":
      paqdUniforms = [0.01, 0.5, 0.25, 0.4]
      break
  }
  nv1.volumePaqdUniforms = paqdUniforms
  nv1.updateGLVolume()
}
clipBtn.onclick = () => {
  if (nv1.getClipPlaneDepthAziElev()[0] >= 1.0) {
    nv1.setClipPlane([0.0, 180, 30])
  } else {
    nv1.setClipPlane([2, 180, 30])
  }
}
webgpuCheck.onclick = function () {
  nv1.reinitializeView({ backend: this.checked ? "webgpu" : "webgl2" })
}
aboutBtn.onclick = () => {
  window.alert(
    "Probabilistic atlas of the cerebellum PMID: 19457380 DOI: 10.1016/j.neuroimage.2009.01.045",
  )
}

function handleLocationChange(data) {
  document.getElementById("location").innerHTML = `&nbsp;&nbsp;${data.string}`
}
const nv1 = new NiiVue({
  backgroundColor: [0.1, 0.1, 0.2, 1],
  is3DCrosshairVisible: true,
})
nv1.addEventListener("locationChange", (e) => handleLocationChange(e.detail))
await nv1.attachToCanvas(gl1)
nv1.showRender = 1
await nv1.loadVolumes([
  { url: "/volumes/MNI152NLin6AsymC.nii.gz" },
  { url: "/volumes/atl-Anatom.nii.gz" },
  { url: "/volumes/spmMotor.nii.gz", colormap: "warm", calMin: 4, calMax: 8 },
])
await nv1.setColormapLabelFromUrl(
  1,
  "https://niivue.github.io/niivue-demo-images/Cerebellum/atl-Anatom.json",
)
nv1.volumeIllumination = 0.4
nv1.isColorbarVisible = true
nv1.setVolume(0, { isColorbarVisible: false })
nv1.setVolume(1, { isColorbarVisible: false })
paqdSelect.onchange()

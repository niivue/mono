import NiiVue from "../src/index.ts"

sliceType.onchange = () => {
  nv1.sliceType = parseInt(sliceType.value, 10)
  nv2.sliceType = parseInt(sliceType.value, 10)
}
webgpuCheck.onchange = async function () {
  await nv1.reinitializeView({ backend: this.checked ? "webgpu" : "webgl2" })
  await nv2.reinitializeView({ backend: this.checked ? "webgpu" : "webgl2" })
}
broadcastSelect.onchange = () => {
  const v = parseInt(broadcastSelect.value, 10)
  if ((v & 1) > 0) nv1.broadcastTo([nv2])
  else nv1.broadcastTo()
  if ((v & 2) > 0) nv2.broadcastTo([nv1])
  else nv2.broadcastTo()
}
const nv1 = new NiiVue({ backgroundColor: [1, 1, 1, 1] })
await nv1.attachToCanvas(gl1)
await nv1.loadVolumes([{ url: "/volumes/mni152.nii.gz" }])
await nv1.loadMeshes([
  {
    url: "/meshes/BrainMesh_ICBM152.lh.mz3",
    color: [0.3, 0.8, 0.7, 1],
    shaderType: "outline",
  },
])

const nv2 = new NiiVue({ backgroundColor: [1, 1, 1, 1] })
await nv2.attachToCanvas(gl2)
await nv2.loadVolumes([{ url: "/volumes/mni152.nii.gz" }])
await nv2.loadMeshes([
  { url: "/meshes/BrainMesh_ICBM152.lh.mz3", color: [0.7, 0.5, 1, 1] },
])
// Apply initial broadcast from default select value
broadcastSelect.onchange()
nv1.setClipPlanes([[0.1, 0, 20]])

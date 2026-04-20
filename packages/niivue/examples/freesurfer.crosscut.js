import NiiVue from "../src/index.ts";

sliceType.onchange = () => {
  nv1.sliceType = parseInt(sliceType.value, 10);
};
webgpuCheck.onchange = async function () {
  await nv1.reinitializeView({ backend: this.checked ? "webgpu" : "webgl2" });
};
const nv1 = new NiiVue({ backgroundColor: [0, 0, 0.1, 1] });
await nv1.attachToCanvas(gl1);
await nv1.loadVolumes([{ url: "/volumes/fs/brainmask.mgz" }]);
await nv1.loadMeshes([
  {
    url: "/meshes/fs/rh.pial",
    color: [0.1, 1.0, 0.1, 1],
    shaderType: "crosscut",
  },
]);
nv1.setClipPlane([0.0, 180, 20]);
nv1.clipPlaneColor = [1, 0, 0, -0.2];

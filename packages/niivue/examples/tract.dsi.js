import NiiVue from "../src/index.ts";

sliceType.onchange = () => {
  nv1.sliceType = parseInt(sliceType.value, 10);
};

radiusSlide.oninput = async function () {
  await nv1.setTractOptions(0, { fiberRadius: this.value * 0.1 });
};

decimationSlide.oninput = async function () {
  await nv1.setTractOptions(0, { decimation: parseInt(this.value, 10) });
};

fiberColor.onchange = async function () {
  await nv1.setTractOptions(0, { colorBy: this.value });
};

xrayCheck.onclick = function () {
  nv1.meshXRay = +this.checked * 0.05;
};

webgpuCheck.onclick = function () {
  nv1.reinitializeView({ backend: this.checked ? "webgpu" : "webgl2" });
};

const nv1 = new NiiVue({ backgroundColor: [0, 0, 0, 1] });
await nv1.attachToCanvas(gl1);
nv1.clipPlaneColor = [0, 0, 0, 0];
nv1.setClipPlanes([
  [0.2, 180, 80],
  [-0.15, 0, -80],
]);
await nv1.loadVolumes([{ url: "/volumes/mni152.nii.gz" }]);

nv1.sliceType = 4;

// Load DSI-Studio TinyTrack format (.tt.gz)
await nv1.loadMeshes([
  {
    url: "/meshes/TR_S_R.tt.gz",
    rgba255: [0, 255, 255, 255],
    tractOptions: { fiberRadius: 0.5 },
  },
]);

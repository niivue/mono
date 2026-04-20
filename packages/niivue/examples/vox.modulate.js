import NiiVue from "../src/index.ts";

const nv1 = new NiiVue({
  backgroundColor: [0.0, 0.0, 0.2, 1],
  is3DCrosshairVisible: true,
  crosshairWidth: 0.5,
  isSnapToVoxelCenters: true,
});
nv1.addEventListener("locationChange", (e) => {
  document.getElementById("location").innerHTML =
    `&nbsp;&nbsp;${e.detail.string}`;
});
await nv1.attachTo("gl1");
// V1 lines benefit from nearest neighbor interpolation
nv1.volumeIsNearestInterpolation = true;
await nv1.loadVolumes([
  { url: "/volumes/FA.nii.gz", opacity: 1 },
  { url: "/volumes/V1.nii.gz", opacity: 1 },
]);
// Set initial crosshair position in voxel coordinates
nv1.crosshairPos = nv1.vox2frac([41, 46, 28]);

function minMax() {
  const mn = 0.01 * slide.value;
  const mx = 0.01 * slideX.value;
  nv1.volumes[0].calMin = Math.min(mn, mx);
  nv1.volumes[0].calMax = Math.max(mn, mx);
  nv1.updateGLVolume();
}
slide.oninput = minMax;
slideX.oninput = minMax;

check.onchange = function () {
  nv1.volumeIsAlphaClipDark = this.checked;
  nv1.updateGLVolume();
};
webgpuCheck.onclick = function () {
  nv1.reinitializeView({ backend: this.checked ? "webgpu" : "webgl2" });
};
mode.onchange = async () => {
  const idx = mode.selectedIndex;
  if (idx === 0) {
    // FA only
    await nv1.setVolume(0, { opacity: 1.0 });
    await nv1.setVolume(1, { opacity: 0.0 });
  } else if (idx <= 2) {
    // V1 (with or without modulation)
    await nv1.setVolume(0, { opacity: 0.0 });
    await nv1.setVolume(1, { opacity: 1.0 });
  } else {
    // V1 + FA (with isV1SliceShader modes, to be implemented)
    await nv1.setVolume(0, { opacity: 1.0 });
    await nv1.setVolume(1, { opacity: 1.0 });
  }
  // Apply or clear modulation
  if (idx === 2 || idx === 4) {
    await nv1.setModulationImage(nv1.volumes[1].id, nv1.volumes[0].id);
  } else {
    await nv1.setModulationImage(nv1.volumes[1].id, "");
  }
  nv1.volumeIsV1SliceShader = idx > 2;
};
mode.onchange();
check.onchange();

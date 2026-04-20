import NiiVue from "../src/index.ts";

graphCheck.onclick = function () {
  nv1.isGraphVisible = this.checked;
};
normalCheck.onclick = function () {
  nv1.graphNormalizeValues = this.checked;
};
fixedRangeCheck.onclick = function () {
  nv1.graphIsRangeCalMinMax = this.checked;
};
autoCalCheck.onchange = function () {
  // When toggled on, immediately recalibrate to the current frame
  if (this.checked) {
    const vol = nv1.volumes[0];
    if (vol) nv1.recalculateCalMinMax(0, vol.frame4D ?? 0);
  }
};
colorBtn.addEventListener("input", (event) => {
  const input = event.target;
  const hex = input.value;
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  nv1.backgroundColor = [r, g, b, 1.0];
});
colorbarCheck.onclick = function () {
  nv1.isColorbarVisible = this.checked;
};
dprSelect.onchange = async () => {
  let v = dprSelect.value.trim();
  if (v.toLowerCase() === "auto") v = "-1";
  nv1.devicePixelRatio = parseFloat(v);
};
webgpuCheck.onclick = function () {
  nv1.reinitializeView({ backend: this.checked ? "webgpu" : "webgl2" });
};
sliceType.onchange = () => {
  nv1.sliceType = parseInt(sliceType.value, 10);
};
prevFrame.onclick = () => {
  let currentVol = nv1.getFrame4D(nv1.volumes[0].id);
  currentVol--;
  nv1.setFrame4D(nv1.volumes[0].id, currentVol);
};
nextFrame.onclick = () => {
  let currentVol = nv1.getFrame4D(nv1.volumes[0].id);
  currentVol++;
  nv1.setFrame4D(nv1.volumes[0].id, currentVol);
};
aboutBtn.onclick = async () => {
  const vol = nv1.volumes[0];
  if (vol.nTotalFrame4D > vol.nFrame4D) {
    aboutBtn.textContent = "Loading...";
    await nv1.loadDeferred4DVolumes(vol.id);
    aboutBtn.textContent = `Loaded all ${vol.nFrame4D} frames`;
  } else {
    window.alert(`All ${vol.nFrame4D} frames are loaded.`);
  }
};
function handleLocationChange(data) {
  document.getElementById("location").innerHTML = `&nbsp;&nbsp;${data.string}`;
}
function handleFrameChange(_volume, frame) {
  if (autoCalCheck.checked) {
    nv1.recalculateCalMinMax(0, frame);
  }
}
const nv1 = new NiiVue({
  backgroundColor: [0.1, 0.1, 0.1, 1],
  isGraphVisible: true,
});
nv1.addEventListener("locationChange", (e) => handleLocationChange(e.detail));
nv1.addEventListener("frameChange", (e) =>
  handleFrameChange(e.detail.volume, e.detail.frame),
);
await nv1.attachToCanvas(gl1);
nv1.showRender = 1;
var volumeList = [{ url: "/volumes/mpld_asl.nii.gz", limitFrames4D: 5 }];
await nv1.loadVolumes(volumeList);
console.log(
  "nFrame4D:",
  nv1.volumes[0].nFrame4D,
  "nTotalFrame4D:",
  nv1.volumes[0].nTotalFrame4D,
);

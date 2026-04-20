import NiiVue from "../src/index.ts";

sliceType.onchange = () => {
  nv1.sliceType = parseInt(sliceType.value, 10);
};

decimationSlide.oninput = async function () {
  await nv1.setTractOptions(0, { decimation: parseInt(this.value, 10) });
};

webgpuCheck.onclick = function () {
  nv1.reinitializeView({ backend: this.checked ? "webgpu" : "webgl2" });
};

function setThresholdVisible(show) {
  const display = show ? "inline-block" : "none";
  thresholdLabel.style.display = display;
  thresholdSlide.style.display = display;
}
xrayCheck.onclick = function () {
  nv1.meshXRay = +this.checked * 0.005;
};
thresholdSlide.oninput = async function () {
  await nv1.setTractOptions(0, { calMin: parseFloat(this.value) * 0.5 });
};

fiberSelect.onchange = async function () {
  const mode = this.value;
  setThresholdVisible(mode === "zscore");

  if (mode === "show0") {
    // First group only (green)
    const groupColors = { [groupNames[0]]: [0, 255, 0, 255] };
    await nv1.setTractOptions(0, { groupColors, colorBy: "fixed" });
  } else if (mode === "show1") {
    // Second group only (red)
    const groupColors = { [groupNames[1]]: [255, 0, 0, 255] };
    await nv1.setTractOptions(0, { groupColors, colorBy: "fixed" });
  } else if (mode === "show2") {
    // Third group only (blue)
    const groupColors = { [groupNames[2]]: [25, 25, 255, 255] };
    await nv1.setTractOptions(0, { groupColors, colorBy: "fixed" });
  } else if (mode === "show012") {
    // First three groups simultaneously (green, red, blue)
    const groupColors = {
      [groupNames[0]]: [0, 255, 0, 255],
      [groupNames[1]]: [255, 0, 0, 255],
      [groupNames[2]]: [25, 25, 255, 255],
    };
    await nv1.setTractOptions(0, { groupColors, colorBy: "fixed" });
  } else if (mode === "zscore") {
    // Per-group z-score scalar coloring (all streamlines visible)
    await nv1.setTractOptions(0, { groupColors: null, colorBy: "dps:z_score" });
  } else {
    // Direction or fixed color (all streamlines visible)
    await nv1.setTractOptions(0, { groupColors: null, colorBy: mode });
  }
};

const nv1 = new NiiVue({ backgroundColor: [1, 1, 1, 1] });
await nv1.attachToCanvas(gl1);
nv1.sliceType = 4;
nv1.setClipPlanes([
  [0.1, 180, 20],
  [0.1, 0, -20],
]);
nv1.volumeIllumination = 0.5;
await nv1.loadVolumes([{ url: "/volumes/mni152.nii.gz" }]);
await nv1.loadMeshes([
  { url: "/meshes/yeh2022.trx", rgba255: [0, 142, 200, 255] },
]);

// Get group names from the loaded tract
const groupNames = nv1.getTractGroups(0);

// Synthesize per-streamline z-score data from group membership
// (emulates the old dpg.html demo which created synthetic per-group data)
const mesh = nv1.meshes[0];
const nStreamlines = mesh.trx.offsets.length - 1;
const zScores = new Float32Array(nStreamlines); // default 0
const groupZValues = [1.64, 3.32, 5.01]; // z-scores for first three groups
for (let g = 0; g < Math.min(3, groupNames.length); g++) {
  const members = mesh.trx.groups[groupNames[g]];
  for (let i = 0; i < members.length; i++) {
    if (members[i] < nStreamlines) {
      zScores[members[i]] = groupZValues[g];
    }
  }
}
mesh.trx.dps.z_score = zScores;
mesh.trx.dpsMeta.z_score = {
  global_min: 0,
  global_max: Math.max(...groupZValues),
};

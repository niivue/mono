import NiiVue from "../src/index.ts";

sliceType.onchange = () => {
  nv1.sliceType = parseInt(sliceType.value, 10);
};

radiusSlide.oninput = async function () {
  const r = this.value * 0.1;
  await nv1.setTractOptions(0, { fiberRadius: r });
  await nv1.setTractOptions(1, { fiberRadius: r });
  await nv1.setTractOptions(2, { fiberRadius: r });
};

fiberColor.onchange = async function () {
  await nv1.setTractOptions(0, { colorBy: this.value });
  await nv1.setTractOptions(1, { colorBy: this.value });
  await nv1.setTractOptions(2, { colorBy: this.value });
};

// Shader dropdown controls the brain surface mesh (index 3)
shaderDrop.onchange = async function () {
  await nv1.setMesh(3, { shaderType: this.value });
};

// Opacity slider controls the brain surface mesh
opacitySlide.oninput = async function () {
  await nv1.setMesh(3, { opacity: this.value * 0.1 });
};

xraySlide.oninput = function () {
  nv1.meshXRay = this.value * 0.01;
};

colorBtn.addEventListener("input", (event) => {
  const input = event.target;
  const hex = input.value;
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  nv1.backgroundColor = [r, g, b, 1.0];
});

webgpuCheck.onclick = function () {
  nv1.reinitializeView({ backend: this.checked ? "webgpu" : "webgl2" });
};

const nv1 = new NiiVue({ backgroundColor: [0, 0, 0, 1] });
await nv1.attachToCanvas(gl1);
nv1.sliceType = 4;
nv1.clipPlaneColor = [0, 0, 0, 0];
nv1.setClipPlanes([
  [0.1, 180, 90],
  [0.0, 0, -90],
]);
await nv1.loadVolumes([{ url: "/volumes/mni152.nii.gz" }]);

// Load three tract meshes (TRK, TCK, VTK) + brain surface
await nv1.loadMeshes([
  {
    url: "/meshes/tract.IFOF_R.trk",
    rgba255: [0, 255, 0, 255],
    tractOptions: { fiberRadius: 0.5 },
  },
  {
    url: "/meshes/tract.SLF1_R.tck",
    rgba255: [0, 0, 255, 255],
    tractOptions: { fiberRadius: 0.5 },
  },
  {
    url: "/meshes/tract.FAT_R.vtk",
    rgba255: [180, 180, 0, 255],
    tractOptions: { fiberRadius: 0.5 },
  },
  { url: "/meshes/BrainMesh_ICBM152.lh.mz3", rgba255: [242, 174, 177, 255] },
]);

// Populate shader dropdown from available shaders
const shaders = nv1.meshShaders;
for (const name of shaders) {
  const opt = document.createElement("option");
  opt.value = name;
  opt.textContent = name.charAt(0).toUpperCase() + name.slice(1);
  if (name === "outline") opt.selected = true;
  shaderDrop.appendChild(opt);
}

// Apply initial shader selection
shaderDrop.dispatchEvent(new Event("change"));

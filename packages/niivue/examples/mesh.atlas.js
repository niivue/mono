import NiiVue from "../src/index.ts";

sliceType.onchange = () => {
  nv1.sliceType = parseInt(sliceType.value, 10);
};

shaderSelect.onchange = () => {
  const meshes = nv1.model.getMeshes();
  if (meshes.length < 1) return;
  nv1.setMesh(meshes.length - 1, { shaderType: shaderSelect.value });
};

colorBtn.addEventListener("input", (event) => {
  const input = event.target;
  const hex = input.value;
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  nv1.backgroundColor = [r, g, b, 1.0];
});

legendCheck.onchange = async function () {
  await nv1.setMesh(0, { isLegendVisible: this.checked });
};

webgpuCheck.onchange = async function () {
  await nv1.reinitializeView({ backend: this.checked ? "webgpu" : "webgl2" });
};

const nv1 = new NiiVue({ backgroundColor: [0, 0, 0, 1] });
await nv1.attachToCanvas(gl1);
for (const shader of nv1.meshShaders) {
  const option = document.createElement("option");
  option.value = shader;
  option.textContent = shader.charAt(0).toUpperCase() + shader.slice(1);
  shaderSelect.appendChild(option);
}
await nv1.loadMeshes([
  {
    url: "/meshes/atl-Anatom_space-MNI.mz3",
  },
]);
sliceType.onchange();
legendCheck.onchange();

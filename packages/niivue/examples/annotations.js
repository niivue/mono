import NiiVue from "../src/index.ts";
import {
  MULTIPLANAR_TYPE,
  SHOW_RENDER,
  SLICE_TYPE,
} from "../src/NVConstants.ts";

const LABEL_COLORS = {
  1: { fill: [1, 0, 0, 0.3], stroke: [1, 0, 0, 1] },
  2: { fill: [0, 1, 0, 0.3], stroke: [0, 1, 0, 1] },
  3: { fill: [0, 0.4, 1, 0.3], stroke: [0, 0.4, 1, 1] },
  4: { fill: [1, 1, 0, 0.3], stroke: [1, 1, 0, 1] },
};

function updateStyle() {
  const label = parseInt(labelSelect.value, 10);
  const colors = LABEL_COLORS[label] || LABEL_COLORS[1];
  const fillAlpha = parseInt(fillOpacity.value, 10) / 100;
  const sw = parseFloat(strokeWidth.value);
  nv1.annotationStyle = {
    fillColor: [colors.fill[0], colors.fill[1], colors.fill[2], fillAlpha],
    strokeColor: colors.stroke,
    strokeWidth: sw,
  };
}

enableCheck.onchange = function () {
  nv1.annotationIsEnabled = this.checked;
};

toolSelect.onchange = function () {
  nv1.annotationTool = this.value;
  const isFreehand = this.value === "freehand";
  brushRadius.style.display = isFreehand ? "" : "none";
  brushLabel.style.display = isFreehand ? "" : "none";
  document.querySelector('label[for="brushRadius"]').style.display = isFreehand
    ? ""
    : "none";
};

eraserCheck.onchange = function () {
  nv1.annotationIsErasing = this.checked;
};

labelSelect.onchange = function () {
  nv1.annotationActiveLabel = parseInt(this.value, 10);
  updateStyle();
};

brushRadius.oninput = function () {
  const r = parseFloat(this.value);
  nv1.annotationBrushRadius = r;
  brushLabel.textContent = r <= 1 ? "Polygon" : r.toFixed(1);
};

fillOpacity.oninput = () => {
  updateStyle();
};

strokeWidth.oninput = () => {
  updateStyle();
};

undoBtn.onclick = () => nv1.annotationUndo();
redoBtn.onclick = () => nv1.annotationRedo();
clearBtn.onclick = () => nv1.clearAnnotations();

show3dCheck.onchange = function () {
  nv1.annotationIsVisibleIn3D = this.checked;
};

annOpacity.oninput = function () {
  const alpha = parseInt(this.value, 10) / 100;
  const style = nv1.annotationStyle;
  const fc = style.fillColor;
  nv1.annotationStyle = {
    ...style,
    fillColor: [fc[0], fc[1], fc[2], alpha],
  };
};

volOpacity.oninput = function () {
  const opacity = parseInt(this.value, 10) / 100;
  nv1.setVolume(0, { opacity });
};

saveBtn.onclick = () => nv1.saveDocument("annotations.nvd");

loadBtn.onclick = () => loadFile.click();
loadFile.onchange = async function () {
  if (this.files.length > 0) {
    await nv1.loadDocument(this.files[0]);
    enableCheck.checked = nv1.annotationIsEnabled;
  }
};

const backend = webgpuCheck.checked ? "webgpu" : "webgl2";
webgpuCheck.onchange = function () {
  nv1.reinitializeView({ backend: this.checked ? "webgpu" : "webgl2" });
};

const nv1 = new NiiVue({
  backend,
  isColorbarVisible: true,
  annotationBrushRadius: 2.0,
  crosshairWidth: 0,
  sliceType: SLICE_TYPE.MULTIPLANAR,
  multiplanarLayout: MULTIPLANAR_TYPE.GRID,
  showRender: SHOW_RENDER.ALWAYS,
});

nv1.addEventListener("locationChange", (e) => {
  document.getElementById("location").textContent = e.detail.string;
});

nv1.addEventListener("annotationChanged", (e) => {
  document.getElementById("location").textContent =
    `Annotation: ${e.detail.action} | ${nv1.annotations.length} annotation(s)`;
});

async function main() {
  await nv1.attachToCanvas(document.getElementById("gl1"));
  await nv1.loadVolumes([
    {
      url: "https://niivue.github.io/niivue-demo-images/CT_pitch.nii.gz",
    },
  ]);
}

main();

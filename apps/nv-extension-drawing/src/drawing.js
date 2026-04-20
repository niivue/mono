/**
 * Example: using @niivue/nv-drawing for drawing interpolation via the extension context.
 *
 * Workflow:
 *   1. Load a volume and enable drawing
 *   2. Draw on a few slices (e.g. every 5-10 axial slices apart)
 *   3. Click "Find Boundaries" to see the first/last drawn slices
 *   4. Click "Interpolate" to fill the gaps between drawn slices
 */
import NiiVue from "@niivue/niivue";
import {
  findDrawingBoundarySlices,
  interpolateMaskSlices,
} from "@niivue/nv-drawing";

// --- UI refs ---
const status = document.getElementById("status");
const sliceTypeSelect = document.getElementById("sliceType");
const useWebGPUCb = document.getElementById("useWebGPU");
const enableDrawBtn = document.getElementById("enableDrawBtn");
const penColorSelect = document.getElementById("penColor");
const penSizeInput = document.getElementById("penSize");
const undoBtn = document.getElementById("undoBtn");
const interpAxisSelect = document.getElementById("interpAxis");
const intensityGuidedCb = document.getElementById("intensityGuided");
const findBoundaryBtn = document.getElementById("findBoundaryBtn");
const interpolateBtn = document.getElementById("interpolateBtn");
const alphaSlider = document.getElementById("alphaSlider");
const sigmaSlider = document.getElementById("sigmaSlider");
const threshSlider = document.getElementById("threshSlider");
const smoothCb = document.getElementById("smoothCb");
const intensityParams = document.getElementById("intensityParams");

// Show/hide intensity params when checkbox toggles
intensityGuidedCb.onchange = () => {
  intensityParams.style.display = intensityGuidedCb.checked ? "flex" : "none";
};
alphaSlider.oninput = () => {
  document.getElementById("alphaVal").textContent = (
    alphaSlider.value / 100
  ).toFixed(2);
};
sigmaSlider.oninput = () => {
  document.getElementById("sigmaVal").textContent = (
    sigmaSlider.value / 100
  ).toFixed(2);
};
threshSlider.oninput = () => {
  document.getElementById("threshVal").textContent = (
    threshSlider.value / 100
  ).toFixed(2);
};

// --- Initialize NiiVue + extension context ---
const nv = new NiiVue();
const ctx = nv.createExtensionContext();

ctx.on("locationChange", (e) => {
  document.getElementById("location").innerHTML =
    `&nbsp;&nbsp;${e.detail.string}`;
});

await nv.attachToCanvas(document.getElementById("gl1"));
await nv.loadVolumes([{ url: "/volumes/mni152.nii.gz" }]);

// Detect actual backend and sync checkbox
useWebGPUCb.checked = nv.backend === "webgpu";

// --- WebGPU / WebGL2 toggle ---
useWebGPUCb.onchange = async () => {
  const backend = useWebGPUCb.checked ? "webgpu" : "webgl2";
  status.textContent = `Switching to ${backend}\u2026`;
  const ok = await nv.reinitializeView({ backend });
  useWebGPUCb.checked = nv.backend === "webgpu";
  status.textContent = ok
    ? `Backend: ${nv.backend}`
    : `Failed to switch to ${backend}`;
};

// --- Drawing controls ---
let drawingEnabled = false;

enableDrawBtn.onclick = () => {
  if (!drawingEnabled) {
    ctx.createEmptyDrawing();
    drawingEnabled = true;
    enableDrawBtn.textContent = "Disable";
    status.textContent = "Drawing enabled - draw on slices, then interpolate.";
  } else {
    nv.drawIsEnabled = false;
    drawingEnabled = false;
    enableDrawBtn.textContent = "Enable";
    status.textContent = "Drawing disabled.";
  }
};

penColorSelect.onchange = () => {
  nv.drawPenValue = parseInt(penColorSelect.value, 10);
};

penSizeInput.oninput = () => {
  nv.drawPenSize = parseInt(penSizeInput.value, 10);
};

undoBtn.onclick = () => ctx.drawUndo();

sliceTypeSelect.onchange = () => {
  nv.sliceType = parseInt(sliceTypeSelect.value, 10);
};

// --- Find boundary slices ---
findBoundaryBtn.onclick = async () => {
  const dr = ctx.drawing;
  if (!dr) {
    status.textContent =
      "No drawing - enable drawing first and draw on some slices.";
    return;
  }

  const axis = parseInt(interpAxisSelect.value, 10);
  const axisName = ["Axial", "Coronal", "Sagittal"][axis];
  status.textContent = `Finding ${axisName} boundaries...`;

  const t0 = performance.now();
  const result = await findDrawingBoundarySlices(axis, dr.bitmap, dr.dims);
  const elapsed = (performance.now() - t0).toFixed(0);

  if (result) {
    status.textContent = `${axisName} boundaries: first=${result.first}, last=${result.last} (${elapsed} ms)`;
  } else {
    status.textContent = `No drawing data found along ${axisName} axis (${elapsed} ms)`;
  }
};

// --- Shared interpolation logic ---
function getInterpolationParams() {
  const axis = parseInt(interpAxisSelect.value, 10);
  const useIntensity = intensityGuidedCb.checked;
  const bg = ctx.backgroundVolume;

  let imageData = null;
  let maxVal = 1;
  if (useIntensity && bg) {
    // Use RAS-ordered intensity data — no rasMap needed
    imageData = bg.imgRAS;
    maxVal = bg.globalMax || 1;
  }

  const options = {
    sliceType: axis,
    useIntensityGuided: useIntensity,
    intensityWeight: alphaSlider.value / 100,
    intensitySigma: sigmaSlider.value / 100,
    binaryThreshold: threshSlider.value / 100,
    applySmoothingToSlices: smoothCb.checked,
  };

  return { axis, imageData, maxVal, options };
}

// --- Interpolate (async, via worker) ---
interpolateBtn.onclick = async () => {
  const dr = ctx.drawing;
  if (!dr) {
    status.textContent =
      "No drawing - enable drawing first and draw on some slices.";
    return;
  }

  const { axis, imageData, maxVal, options } = getInterpolationParams();
  const axisName = ["Axial", "Coronal", "Sagittal"][axis];
  status.textContent = `Interpolating ${axisName} slices...`;

  const before = dr.bitmap.reduce((n, v) => n + (v > 0 ? 1 : 0), 0);

  const t0 = performance.now();
  // No rasMap needed — imageData is already in RAS order from ctx.backgroundVolume.imgRAS
  const newBitmap = await interpolateMaskSlices(
    dr.bitmap,
    dr.dims,
    imageData,
    maxVal,
    undefined,
    undefined,
    options,
  );
  const elapsed = (performance.now() - t0).toFixed(0);

  const after = newBitmap.reduce((n, v) => n + (v > 0 ? 1 : 0), 0);

  // Use context's update method for safe write-back
  dr.update(newBitmap);

  status.textContent = `${axisName} interpolation: ${before}→${after} voxels (${elapsed} ms, worker)`;
};

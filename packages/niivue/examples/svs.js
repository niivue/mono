import NiiVue from '../src/index.ts'

// Standalone NIfTI-MRS spectroscopy viewer. Emulates:
//   spec2graph.py svs_se_30.nii -a --ppm-range 1.9 3.3
// The complex FID is transformed (FFT + transient averaging + ppm windowing)
// on demand inside NiiVue; the HTML controls drive setSignal() display state.
// The participant's own T2w image provides anatomical context, and a single
// connectome node marks the voxel where the spectrum was sampled.

// Sampling location in the T2w world space (mm), shared by the crosshair and the
// voxel marker so single-slice views land on the spectroscopy voxel.
const MRS_LOC = [-17.3993, 0.0, 46.894901]
const T2_URL = '/signals/svs_T2w.nii.gz'

const nv1 = new NiiVue({
  backgroundColor: [0.1, 0.1, 0.1, 1],
  isGraphVisible: true,
})
window.nv1 = nv1
await nv1.attachToCanvas(gl1)
nv1.sliceType = 0 // Axial (default view; the View menu offers Render etc.)
// A single parasagittal clip plane through the left hemisphere exposes a cut face
// at the spectroscopy voxel, so the marker is visible inside the 3D render.
nv1.clipPlaneColor = [0, 0, 0, 0]
nv1.setClipPlanes([[0.12, 270, 0]])

// The sibling svs_se_30.json sidecar (SpectrometerFrequency, ResonantNucleus)
// is fetched automatically for the ppm axis. Annotations are anchored in ppm (x)
// with y = -Infinity to pin them to the bottom of the plot; they translate as the
// ppm window is panned/zoomed and hide once their ppm leaves the visible range.
try {
  await nv1.loadSignals([
    {
      url: '/signals/svs_se_30.nii.gz',
      annotations: [
        { text: 'NAA', x: 2.0, y: -Infinity },
        { text: 'Cr', x: 3.0, y: -Infinity },
        { text: 'Cho', x: 3.2, y: -Infinity },
      ],
    },
  ])
} catch (err) {
  console.error('loadSignals failed', err)
  document.getElementById('location').textContent =
    `  Could not load spectrum: ${err?.message ?? err}`
}

// A one-node connectome marking the spectroscopy voxel (T2w world mm). Built
// inline as a sparse JCON and loaded as a File so no extra asset is needed.
const nodeJcon = {
  nodes: [
    {
      name: 'svs',
      x: MRS_LOC[0],
      y: MRS_LOC[1],
      z: MRS_LOC[2],
      colorValue: 1,
      sizeValue: 3,
    },
  ],
  edges: [],
}
const nodeFile = new File([JSON.stringify(nodeJcon)], 'svs.jcon', {
  type: 'application/json',
})

let nodeShown = false
// Show/hide the voxel marker. The connectome is passed as a File because
// loadMeshes dispatches the reader by filename extension ('.jcon'). shaderType
// 'outline' draws it with the outline shader (cf. mesh.basic.html);
// isLegendVisible surfaces the 'svs' label in the legend (cf. connectome.html).
async function setNode(show) {
  if (show === nodeShown) return
  if (show) {
    await nv1.loadMeshes([
      {
        url: nodeFile,
        shaderType: 'outline',
        isLegendVisible: true,
        connectomeOptions: { nodeScale: 4, nodeMinColor: 0, nodeMaxColor: 1 },
      },
    ])
  } else {
    await nv1.removeAllMeshes()
  }
  nodeShown = show
}

// Apply a scene composition. The signal stays loaded throughout; MRS visibility
// is the graph toggle, MRI is the volume, and the voxel is the node marker. When
// the volume and node are both absent the scene is signal-only and the spectrum
// fills the whole canvas.
async function applySceneNow(mode) {
  const wantMRI = mode !== 'mrs'
  const wantMRS = mode !== 'mri'
  const wantVoxel = mode === 'all'
  // The View menu only affects spatial scenes; signal-only ignores sliceType.
  viewSelect.disabled = !wantMRI
  try {
    if (!wantVoxel) await setNode(false)
    if (wantMRI) {
      if (nv1.volumes.length === 0) {
        await nv1.loadVolumes([{ url: T2_URL }])
        nv1.setCrosshairPos(MRS_LOC) // center single-slice views on the voxel
      }
    } else if (nv1.volumes.length > 0) {
      await nv1.removeAllVolumes()
    }
    if (wantVoxel) await setNode(true)
    nv1.isGraphVisible = wantMRS
  } catch (err) {
    console.error('applyScene failed', err)
    document.getElementById('location').textContent =
      `  Could not load scene: ${err?.message ?? err}`
  }
}

// Serialize scene changes through a single promise chain so they can never
// interleave their volume/mesh mutations, and coalesce to the latest request:
// when several modes are queued rapidly, only the final one runs its (heavy)
// load/remove operations; the intermediate modes are skipped.
let sceneChain = Promise.resolve()
let pendingMode = sceneSelect.value
function applyScene(mode) {
  pendingMode = mode
  sceneChain = sceneChain.then(() => {
    if (mode !== pendingMode) return // superseded by a newer request
    return applySceneNow(mode)
  })
  return sceneChain
}
await applyScene(sceneSelect.value)

// Two ways the ppm sliders can relate to the in-graph pan/zoom buttons:
//
//   Default (reactive unchecked): the sliders set the EXPLICIT analysis range
//   (display.ppmRange). Changing them auto-resets any transient zoom so the new
//   range is shown in full (graphAutoResetView, the default). The on-graph zoom
//   is a transient overlay and does not move the sliders.
//
//   Reactive (checked): graphAutoResetView is turned off and the sliders instead
//   drive the live view WINDOW via setGraphRange(); the demo subscribes to the
//   graphRangeChange event so zooming/panning on the graph moves the sliders too
//   (two-way sync). Zooming out returns to the full spectrum.
const isReactive = () => reactiveCheck.checked

// Processing transforms (apodization, phase, component, averaging) are core
// spectroscopy display flags (signal/processing.ts) and never touch the x-range.
function applyProcessing() {
  apodVal.textContent = apod.value
  p0Val.textContent = p0.value
  p1Val.textContent = parseFloat(p1.value).toFixed(1)
  const display = {
    average: avgCheck.checked,
    mode: modeSelect.value,
    apodizeHz: parseFloat(apod.value),
    phase0: parseFloat(p0.value),
    phase1Ms: parseFloat(p1.value),
  }
  // In default mode the sliders own the explicit ppm range; in reactive mode the
  // window owns it (ppmRange stays null) so processing tweaks don't disturb it.
  if (!isReactive()) {
    const lo = parseFloat(ppmLow.value)
    const hi = parseFloat(ppmHigh.value)
    display.ppmRange = lo < hi ? [lo, hi] : null
  }
  nv1.setSignal(0, { display })
}

function applyPpmRange() {
  const lo = parseFloat(ppmLow.value)
  const hi = parseFloat(ppmHigh.value)
  ppmLowVal.textContent = lo.toFixed(1)
  ppmHighVal.textContent = hi.toFixed(1)
  if (isReactive()) nv1.setGraphRange(lo < hi ? [lo, hi] : null)
  else applyProcessing()
}

// Reflect in-graph zoom/pan back onto the sliders (reactive mode only). Setting
// .value programmatically does not fire 'input', so there is no feedback loop.
nv1.addEventListener('graphRangeChange', (e) => {
  if (!isReactive()) return
  const lo = Math.min(e.detail.min, e.detail.max)
  const hi = Math.max(e.detail.min, e.detail.max)
  ppmLow.value = lo.toFixed(1)
  ppmHigh.value = hi.toFixed(1)
  ppmLowVal.textContent = parseFloat(ppmLow.value).toFixed(1)
  ppmHighVal.textContent = parseFloat(ppmHigh.value).toFixed(1)
})

reactiveCheck.onchange = () => {
  nv1.graphAutoResetView = !isReactive()
  if (isReactive()) {
    // Hand the range over to the view window: clear the explicit ppmRange (full
    // spectrum becomes the domain) and seed the window from the current sliders.
    nv1.setSignal(0, { display: { ppmRange: null } })
    const lo = parseFloat(ppmLow.value)
    const hi = parseFloat(ppmHigh.value)
    nv1.setGraphRange(lo < hi ? [lo, hi] : null)
  } else {
    // Back to explicit-range mode: drop the window and bake the sliders into ppmRange.
    nv1.graphResetView()
    applyProcessing()
  }
}

ppmLow.oninput = applyPpmRange
ppmHigh.oninput = applyPpmRange
avgCheck.onchange = applyProcessing
modeSelect.onchange = applyProcessing
apod.oninput = applyProcessing
p0.oninput = applyProcessing
p1.oninput = applyProcessing
fullRangeBtn.onclick = () => {
  if (isReactive()) nv1.setGraphRange(null)
  else nv1.setSignal(0, { display: { ppmRange: null } })
  // Jump the sliders to the full data extent (e.g. ~1.3-8.0 ppm) so they reflect
  // what is shown. getGraphRange() is the synchronous read of the visible range.
  const r = nv1.getGraphRange()
  if (r) {
    ppmLow.value = r.full[0].toFixed(1)
    ppmHigh.value = r.full[1].toFixed(1)
    ppmLowVal.textContent = parseFloat(ppmLow.value).toFixed(1)
    ppmHighVal.textContent = parseFloat(ppmHigh.value).toFixed(1)
  }
}
sceneSelect.onchange = () => applyScene(sceneSelect.value)
viewSelect.onchange = () => {
  nv1.sliceType = parseInt(viewSelect.value, 10)
}
colorBtn.addEventListener('input', (event) => {
  const hex = event.target.value
  nv1.backgroundColor = [
    parseInt(hex.slice(1, 3), 16) / 255,
    parseInt(hex.slice(3, 5), 16) / 255,
    parseInt(hex.slice(5, 7), 16) / 255,
    1.0,
  ]
})
webgpuCheck.onclick = function () {
  nv1.reinitializeView({ backend: this.checked ? 'webgpu' : 'webgl2' })
}
nv1.addEventListener('signalLocationChange', (e) => {
  // textContent (not innerHTML): labels come from TSV headers / JSON sidecars.
  document.getElementById('location').textContent = `  ${e.detail.string}`
})

// Apply the initial slider state (explicit ppm range + processing defaults).
applyProcessing()

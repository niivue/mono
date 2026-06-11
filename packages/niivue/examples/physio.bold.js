import NiiVue from '../src/index.ts'

// A task-fMRI run (TR 2 s) with its BIDS physio recordings. The cardiac (200 Hz)
// and respiratory (50 Hz) traces are loaded as signals attached to the BOLD
// volume (attachToId), so the graph shows the crosshair BOLD time-course (one
// point per TR) alongside both physio traces on a shared Time (s) axis - each at
// its native sampling rate, no resampling. Physio logged before/after the scan
// is clamped out (window = imaging period). A marker tracks the current frame;
// move the crosshair to update the BOLD trace, or click the graph to scrub
// frames. (See physio.html for the standalone cardiac/respiratory viewer.)

const BOLD = '/signals/bold.nii.gz'
const STEM = '/signals/'

const nv1 = new NiiVue({
  backgroundColor: [0.1, 0.1, 0.1, 1],
  isGraphVisible: true,
})
window.nv1 = nv1
await nv1.attachToCanvas(gl1)
nv1.sliceType = 0 // axial (single view; A+C+S+R also available in the menu)
await nv1.loadVolumes([{ url: BOLD }])
const volId = nv1.volumes[0].id
// This sample was scaled to uint8 over the 2-98% range, so some voxels (incl.
// the origin) saturate and read flat across the run. Open on an unclamped deep
// white-matter voxel ~20 mm left of the origin so the BOLD trace actually moves.
nv1.setCrosshairPos([-20, 0, 10])
await nv1.loadSignals([
  {
    url: `${STEM}respiratory.tsv.gz`,
    attachToId: volId,
    display: { selectedColumns: [0] }, // column 0 is the recording (not trigger)
  },
  {
    url: `${STEM}cardiac.tsv.gz`,
    attachToId: volId,
    display: { selectedColumns: [0] },
  },
])
// Signals load in order: [respiratory, cardiac]. Toggle a physio trace by
// showing column 0 or no column (selectedColumns []); toggle the fMRI/BOLD
// trace via the association graph's volume-timecourse flag; hide the whole
// graph when nothing is selected.
const RESP_IDX = 0
const CARD_IDX = 1
function showPhysio(idx, on) {
  nv1.setSignal(idx, { display: { selectedColumns: on ? [0] : [] } })
}
function syncTraces() {
  nv1.graphShowVolumeTimecourse = fmriCheck.checked
  showPhysio(RESP_IDX, respCheck.checked)
  showPhysio(CARD_IDX, cardCheck.checked)
  // No plot when every trace is unchecked.
  nv1.isGraphVisible =
    fmriCheck.checked || respCheck.checked || cardCheck.checked
}
fmriCheck.onchange = syncTraces
respCheck.onchange = syncTraces
cardCheck.onchange = syncTraces

// Line style: relative width multiplier + opacity. Translucent thin lines let
// the dense, overlapping physio traces be read where they intersect.
function applyLineStyle() {
  nv1.graphLineWidth = parseFloat(lineSize.value)
  nv1.graphLineAlpha = parseFloat(lineOpacity.value)
}
lineSize.onchange = applyLineStyle
lineOpacity.onchange = applyLineStyle
applyLineStyle() // apply the initial dropdown selections

function updateFrameLabel() {
  frameLabel.textContent = `frame ${nv1.getFrame4D(volId)}`
}
updateFrameLabel()

async function stepFrame(delta) {
  try {
    await nv1.setFrame4D(volId, nv1.getFrame4D(volId) + delta)
  } catch (e) {
    console.error('setFrame4D failed', e)
  }
  updateFrameLabel()
}
prevFrame.onclick = () => stepFrame(-1)
nextFrame.onclick = () => stepFrame(1)
sliceType.onchange = () => {
  nv1.sliceType = parseInt(sliceType.value, 10)
}
headerBtn.onclick = () => {
  const hdr = nv1.volumes[0]?.hdr
  if (!hdr) return
  alert(
    typeof hdr.toFormattedString === 'function'
      ? hdr.toFormattedString()
      : JSON.stringify(hdr, null, 2),
  )
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
  const want = this.checked
  // reinitializeView resolves false when the requested backend is unavailable
  // (e.g. a webgl2-only build); revert the checkbox so it matches the renderer.
  Promise.resolve(
    nv1.reinitializeView({ backend: want ? 'webgpu' : 'webgl2' }),
  ).then((ok) => {
    if (ok === false) webgpuCheck.checked = !want
  })
}
nv1.addEventListener('signalLocationChange', (e) => {
  document.getElementById('location').textContent = `  ${e.detail.string}`
})

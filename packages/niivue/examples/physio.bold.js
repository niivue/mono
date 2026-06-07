import NiiVue from '../src/index.ts'

// fMRI 4D time-series with its associated BIDS physio recordings. The physio
// files are loaded as signals attached to the volume (attachToId), so the graph
// shows the crosshair BOLD time-course (one point per TR) together with the
// respiration (50 Hz) and cardiac (200 Hz) traces on a shared Time (s) axis -
// each at its native sampling rate, no resampling. Physio logged before/after
// the scan is clamped out (window = imaging period). A marker tracks the
// current frame; move the crosshair to update the BOLD trace.

const BOLD = '/signals/fmri.nii.gz'
const STEM = '/signals/'

const nv1 = new NiiVue({
  backgroundColor: [0.1, 0.1, 0.1, 1],
  isGraphVisible: true,
})
await nv1.attachToCanvas(gl1)
nv1.sliceType = 0 // axial (single view; A+C+S+R also available in the menu)
await nv1.loadVolumes([{ url: BOLD }])
const volId = nv1.volumes[0].id
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

function updateFrameLabel() {
  frameLabel.textContent = `frame ${nv1.getFrame4D(volId)}`
}
updateFrameLabel()

prevFrame.onclick = () => {
  nv1.setFrame4D(volId, nv1.getFrame4D(volId) - 1)
  updateFrameLabel()
}
nextFrame.onclick = () => {
  nv1.setFrame4D(volId, nv1.getFrame4D(volId) + 1)
  updateFrameLabel()
}
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
  nv1.reinitializeView({ backend: this.checked ? 'webgpu' : 'webgl2' })
}
nv1.addEventListener('signalLocationChange', (e) => {
  document.getElementById('location').textContent = `  ${e.detail.string}`
})

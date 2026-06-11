import NiiVue from '../src/index.ts'

// Standalone BIDS physio viewer. Emulates viewtsv on the cardiac/respiratory
// recordings. Each .tsv.gz auto-fetches its .json sidecar for the sampling
// rate and StartTime, so both traces share a common Time (s) axis even though
// they were sampled at different rates (cardiac 200 Hz, respiratory 50 Hz).

const STEM = '/signals/'
const FILES = {
  cardiac: `${STEM}cardiac.tsv.gz`,
  respiratory: `${STEM}respiratory.tsv.gz`,
}

const nv1 = new NiiVue({
  backgroundColor: [0.1, 0.1, 0.1, 1],
  isGraphVisible: true,
})
await nv1.attachToCanvas(gl1)

async function show(view) {
  nv1.removeAllSignals()
  const which = view === 'both' ? ['respiratory', 'cardiac'] : [view]
  await nv1.loadSignals(
    which.map((k) => ({
      url: FILES[k],
      // Columns: [recording, "trigger" (scanner volume trigger), "<k>_trigger"
      // (the measure's event trigger)]. selectedColumns [0] plots just the
      // recording line; the <k>_trigger events are drawn as a top tick rug and
      // the plain volume "trigger" is ignored (both handled by the reader).
      display: { selectedColumns: [0], showLegend: legendCheck.checked },
    })),
  )
}

viewSelect.onchange = () => show(viewSelect.value)
legendCheck.onchange = () => {
  for (let i = 0; i < nv1.signals.length; i++) {
    nv1.setSignal(i, { display: { showLegend: legendCheck.checked } })
  }
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

await show('both')

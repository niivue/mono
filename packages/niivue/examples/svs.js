import NiiVue from '../src/index.ts'

// Standalone NIfTI-MRS spectroscopy viewer. Emulates:
//   spec2graph.py svs_se_30.nii -a --ppm-range 1.9 3.3
// The complex FID is transformed (FFT + transient averaging + ppm windowing)
// on demand inside NiiVue; the HTML controls drive setSignal() display state.

const nv1 = new NiiVue({
  backgroundColor: [0.1, 0.1, 0.1, 1],
  isGraphVisible: true,
})
await nv1.attachToCanvas(gl1)
// The sibling svs_se_30.json sidecar (SpectrometerFrequency, ResonantNucleus)
// is fetched automatically for the ppm axis.
await nv1.loadSignals([{ url: '/signals/svs_se_30.nii.gz' }])

function update() {
  const lo = parseFloat(ppmLow.value)
  const hi = parseFloat(ppmHigh.value)
  ppmLowVal.textContent = lo.toFixed(1)
  ppmHighVal.textContent = hi.toFixed(1)
  nv1.setSignal(0, {
    display: {
      average: avgCheck.checked,
      mode: modeSelect.value,
      ppmRange: lo < hi ? [lo, hi] : null,
    },
  })
}

ppmLow.oninput = update
ppmHigh.oninput = update
avgCheck.onchange = update
modeSelect.onchange = update
fullRangeBtn.onclick = () => {
  nv1.setSignal(0, { display: { ppmRange: null } })
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

update()

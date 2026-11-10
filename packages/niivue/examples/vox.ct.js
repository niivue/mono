import NiiVue, { SHOW_RENDER } from '../src/index.ts'

const gl1 = document.getElementById('gl1')

const centerSlide = document.getElementById('centerSlide')
const centerText = document.getElementById('centerText')
const colormapSelect = document.getElementById('colormapSelect')
const darkCheck = document.getElementById('darkCheck')
const orientCheck = document.getElementById('orientCheck')
const sliceType = document.getElementById('sliceType')
const volumeSelect = document.getElementById('volumeSelect')
const webgpuCheck = document.getElementById('webgpuCheck')
const widthSlide = document.getElementById('widthSlide')
const widthText = document.getElementById('widthText')

orientCheck.onclick = async function () {
  nv1.isOrientCubeVisible = this.checked
  nv1.isOrientationTextVisible = this.checked
}
// The bundled scan. Its URL lives in script, not in the HTML, because the
// GitHub Pages base-path rewrite only processes script.
volumeSelect.add(new Option('torso', '/volumes/torso.nii.gz'))
// CT scans hosted outside this repository, listed after the bundled torso.
const CT_BASE =
  'https://raw.githubusercontent.com/niivue/niivue-demo-images/main/'
// Latest wins: a window change re-colors the whole volume on the GPU (a few
// ms here, more for a large scan or a slow GPU). Changes that arrive while
// one is in flight merge into a single follow-up instead of queueing up.
let pending = null
let isBusy = false
async function updateVolume(props) {
  pending = { ...pending, ...props }
  if (isBusy) return
  isBusy = true
  try {
    while (pending) {
      const next = pending
      pending = null
      await nv1.setVolume(0, next)
    }
  } finally {
    isBusy = false
  }
}
function showWindow(calMin, calMax) {
  // A range input clamps, so the readout shows what the slider really holds.
  centerSlide.value = Math.round((calMin + calMax) / 2)
  widthSlide.value = Math.round(calMax - calMin)
  centerText.value = centerSlide.value
  widthText.value = widthSlide.value
}
centerSlide.oninput = widthSlide.oninput = () => {
  const center = Number(centerSlide.value)
  const width = Number(widthSlide.value)
  showWindow(center - width / 2, center + width / 2)
  updateVolume({ calMin: center - width / 2, calMax: center + width / 2 })
}
const isGray = (c) => c.toLowerCase() === 'gray'
// The window the scan loaded with; gray falls back to it.
let loadedRange = [0, 1]
// A CT colormap carries the Hounsfield window it was designed for (ct_bones
// is 180..600), and setVolume applies it. Gray has none, so restore the scan's.
async function applyColormap() {
  const colormap = colormapSelect.value
  const [calMin, calMax] = loadedRange
  await updateVolume(
    isGray(colormap) ? { colormap, calMin, calMax } : { colormap },
  )
  showWindow(nv1.volumes[0].calMin, nv1.volumes[0].calMax)
}
volumeSelect.onchange = async function () {
  try {
    await nv1.loadVolumes({ url: this.value })
  } catch (err) {
    // A failed load (offline, 404) keeps the previous scan on screen.
    console.error(`Could not load ${this.value}:`, err)
    return
  }
  loadedRange = [nv1.volumes[0].calMin, nv1.volumes[0].calMax]
  applyColormap()
}
webgpuCheck.onclick = function () {
  nv1.reinitializeView({ backend: this.checked ? 'webgpu' : 'webgl2' })
}
sliceType.onchange = () => {
  nv1.sliceType = parseInt(sliceType.value, 10)
}
colormapSelect.onchange = applyColormap
function handleLocationChange(data) {
  document.getElementById('location').innerHTML = `&nbsp;&nbsp;${data.string}`
}
darkCheck.onclick = function () {
  nv1.volumeIsAlphaClipDark = this.checked
}
const nv1 = new NiiVue({
  backgroundColor: [0.2, 0.2, 0.2, 1],
  isColorbarVisible: true,
  showRender: SHOW_RENDER.ALWAYS,
})
window.nv1 = nv1
nv1.addEventListener('locationChange', (e) => handleLocationChange(e.detail))
await nv1.attachToCanvas(gl1)
// CT windows are tuned for Hounsfield units, so only they and gray apply.
const ctMaps = nv1.colormaps.filter((c) => /^ct_/i.test(c))
for (const cmap of [...nv1.colormaps.filter(isGray), ...ctMaps]) {
  const option = document.createElement('option')
  option.value = cmap
  option.textContent = cmap.charAt(0).toUpperCase() + cmap.slice(1)
  if (cmap.toLowerCase() === 'gray') {
    option.selected = true
  }
  colormapSelect.appendChild(option)
}
// The bundled torso still loads if the remote list is unreachable.
try {
  const manifest = await (await fetch(`${CT_BASE}manifest.json`)).json()
  for (const name of manifest.filter((n) => n.startsWith('CT_'))) {
    volumeSelect.add(new Option(name.replace('.nii.gz', ''), CT_BASE + name))
  }
} catch (err) {
  console.error('Could not list remote CT scans:', err)
}
sliceType.onchange()
orientCheck.onclick()
volumeSelect.onchange()

import NiiVue, { lookupColorMap } from '../src/index.ts'

// Three task maps over one anatomical template, each with its own colormap and
// its own visibility, but sharing ONE threshold and ONE opacity.
//
// That is the point of the demo. The maps are all FDR-corrected z at the same
// q, so a per-map threshold would let you compare them at settings that are not
// comparable. One Thresh/Range pair keeps every map on the same statistical
// footing, and the three colormaps -- not three thresholds -- are what tells
// them apart. They carry no negative values (global min is 0), so unlike
// vox.stats.html there is no second, mirrored pair of sliders for them.
//
// Volume URLs live in script, not in HTML attributes: the GitHub Pages build
// rewrites absolute /volumes/ paths in page script only.
const ANAT = '/volumes/mni152.nii.gz'
const STATS = [
  { label: 'Broca', file: 'z_FDR_0.01_broca.nii.gz', colormap: 'blue2magenta' },
  { label: 'V1', file: 'z_FDR_0.01_v1.nii.gz', colormap: 'redyell' },
  { label: 'Hand', file: 'z_FDR_0.01_hand.nii.gz', colormap: 'green2cyan' },
]
// Overlays follow the anatomical at index 0.
const statIndex = (i) => i + 1

const nv1 = new NiiVue({
  isColorbarVisible: true,
  backgroundColor: [0.1, 0.1, 0.1, 1],
})
nv1.addEventListener('locationChange', (e) => {
  document.getElementById('location').textContent = e.detail.string
})
await nv1.attachToCanvas(gl1)
nv1.showRender = 1

await nv1.loadVolumes([
  { url: ANAT, isColorbarVisible: false, calMin: 30, calMax: 80 },
  ...STATS.map((s) => ({ url: `/volumes/${s.file}`, colormap: s.colormap })),
])

// A checkbox per map, labelled with a swatch of its own colormap so the legend
// is the control. Built from STATS so adding a fourth map needs no markup.
const checks = STATS.map((s) => {
  const label = document.createElement('label')
  const box = document.createElement('input')
  box.type = 'checkbox'
  box.checked = true
  const swatch = document.createElement('span')
  swatch.className = 'swatch'
  const lut = lookupColorMap(s.colormap)
  const last = lut.R.length - 1
  swatch.style.background = `linear-gradient(90deg, rgb(${lut.R[0]},${lut.G[0]},${lut.B[0]}), rgb(${lut.R[last]},${lut.G[last]},${lut.B[last]}))`
  label.append(box, swatch, ` ${s.label}`)
  label.title = `show the ${s.label} map (${s.colormap})`
  document.getElementById('mapChecks').append(label)
  box.onchange = applyOpacity
  return box
})

// Visibility and the opacity slider are the same control underneath: a volume
// with zero opacity is skipped by the renderers, so an unchecked map costs
// nothing and takes its colorbar with it.
function applyOpacity() {
  const opacity = Number(slideOpacity.value) / 100
  opacityOut.textContent = `${slideOpacity.value}%`
  for (const [i, box] of checks.entries()) {
    nv1.setVolume(statIndex(i), {
      opacity: box.checked ? opacity : 0,
      isColorbarVisible: box.checked,
    })
  }
}

function updateThresholds() {
  const min = slideMin.value * 0.1
  const max = min + slideRange.value * 0.1
  minOut.textContent = min.toFixed(1)
  maxOut.textContent = max.toFixed(1)
  for (let i = 0; i < STATS.length; i++) {
    nv1.setVolume(statIndex(i), {
      calMin: min,
      calMax: max,
      colormapType: alphaMode.selectedIndex,
    })
  }
}

slideMin.oninput = updateThresholds
slideRange.oninput = updateThresholds
alphaMode.onchange = updateThresholds
slideOpacity.oninput = applyOpacity

outlineSlide.oninput = function () {
  nv1.volumeOutlineWidth = 0.25 * this.value
}
sliceType.onchange = () => {
  nv1.sliceType = parseInt(sliceType.value, 10)
}
checkCutaway.onclick = function () {
  nv1.isClipPlaneCutaway = this.checked
}
colorSelect.onchange = function () {
  const clr = nv1.clipPlaneColor
  clr[3] = [0.0, 0.3, -0.2][this.selectedIndex]
  nv1.clipPlaneColor = clr
}
clipSelect.onchange = function () {
  const planes = [
    [[2.0, 180, 20]],
    [[0.1, 180, 20]],
    [
      [0.1, 180, 20],
      [0.1, 0, -20],
    ],
    [
      [0.0, 90, 0], // right center
      [0.0, 0, -20], // posterior oblique
      [0.1, 0, -90], // inferior
    ],
    [
      [0.3, 270, 0], // left
      [0.3, 90, 0], // right
      [0.0, 180, 0], // anterior
      [0.1, 0, 0], // posterior
    ],
    [
      [0.4, 270, 0],
      [0.4, 90, 0],
      [0.4, 180, 0],
      [0.2, 0, 0],
      [0.1, 0, -90],
    ],
    [
      [0.4, 270, 0],
      [-0.1, 90, 0],
      [0.4, 180, 0],
      [0.2, 0, 0],
      [0.1, 0, -90],
      [0.3, 0, 90],
    ],
  ][parseInt(this.value, 10)]
  nv1.setClipPlanes(planes)
}
colorBtn.addEventListener('input', (event) => {
  const hex = event.target.value
  const chan = (i) => parseInt(hex.slice(1 + i * 2, 3 + i * 2), 16) / 255
  nv1.backgroundColor = [chan(0), chan(1), chan(2), 1.0]
})
webgpuCheck.onclick = function () {
  nv1.reinitializeView({ backend: this.checked ? 'webgpu' : 'webgl2' })
}
aboutBtn.onclick = () => {
  window.alert(
    'Three FDR-corrected task maps share one threshold and one opacity, so they stay comparable; each has its own colormap and visibility.',
  )
}

updateThresholds()
applyOpacity()
clipSelect.onchange()
checkCutaway.onclick()
colorSelect.onchange()

// Allen mouse CCFv3 2017, 25 um: average template + annotation, with
// ontology names and colours. Source (version ccf_2017):
//   https://download.alleninstitute.org/informatics-archive/current-release/mouse_ccf/
// That host sends no CORS header, so the volumes are re-hosted at CCF_BASE.
// `?base=<url>/` overrides it (e.g. a local CORS server for development);
// `?backend=webgpu` starts on WebGPU.
import NiiVue from '../src/index.ts'
import {
  ALLEN_STRUCTURE_GRAPH_URL,
  allenStructures,
  ccfColormap,
  readCcfNrrd,
} from '../src/volume/ccf.ts'

// Pinned commit of the re-hosted files (unmodified; see ccf/README.md there).
const CCF_BASE =
  'https://huggingface.co/datasets/neurodeskorg/webapps/resolve/78702232aae0a4687dea6f91b7e3d50c15df68a0/ccf/'

const params = new URLSearchParams(window.location.search)
const base = params.get('base') ?? CCF_BASE
const aboutBtn = document.getElementById('aboutBtn')
const gl1 = document.getElementById('gl1')
const legendCheck = document.getElementById('legendCheck')
const location = document.getElementById('location')
const opacitySlider = document.getElementById('opacitySlider')
const saveBtn = document.getElementById('saveBtn')
const sliceType = document.getElementById('sliceType')
const webgpuCheck = document.getElementById('webgpuCheck')

const backend = params.get('backend') === 'webgpu' ? 'webgpu' : 'webgl2'
webgpuCheck.checked = backend === 'webgpu'
const nv1 = new NiiVue({
  backend,
  backgroundColor: [0, 0, 0, 1],
  isLegendVisible: false,
})
nv1.addEventListener('locationChange', (e) => {
  location.textContent = e.detail.string
})
await nv1.attachToCanvas(gl1)

const fetchBytes = async (url) => {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`)
  return r.arrayBuffer()
}

try {
  const [templateBytes, annotationBytes, graph] = await Promise.all([
    fetchBytes(`${base}average_template_25.nrrd`),
    fetchBytes(`${base}annotation_25.nrrd`),
    fetch(ALLEN_STRUCTURE_GRAPH_URL).then((r) => r.json()),
  ])
  const template = (await readCcfNrrd(templateBytes, 'average_template_25'))
    .volume
  const { volume: annotation, ids } = await readCcfNrrd(
    annotationBytes,
    'annotation_25',
  )
  const { colormap, missing } = ccfColormap(ids, allenStructures(graph))
  if (missing.length) console.warn('IDs not in the ontology:', missing)
  nv1.addColormap('allen-ccf', colormap)
  annotation.colormap = 'allen-ccf'
  annotation.opacity = opacitySlider.value / 100
  await nv1.loadVolumes([template, annotation])
  location.textContent = `${ids.length - 1} structures loaded; click to read a label`
  // For scripted checks: the viewer and the Allen ID of each compact index.
  window.nv1 = nv1
  window.ccfIds = ids
} catch (err) {
  location.textContent = `Could not load the CCF volumes from ${base}: ${err.message}`
  throw err
}

sliceType.onchange = function () {
  nv1.sliceType = parseInt(this.value, 10)
}
opacitySlider.oninput = function () {
  nv1.setVolume(1, { opacity: this.value / 100 })
}
legendCheck.onchange = function () {
  nv1.isLegendVisible = this.checked
}
webgpuCheck.onchange = function () {
  nv1.reinitializeView({ backend: this.checked ? 'webgpu' : 'webgl2' })
}
// The document embeds the compact annotation, its scale and the `allen-ccf`
// colormap, whose labels carry the Allen IDs.
saveBtn.onclick = () => nv1.saveDocument('allen-ccf.nvd')
aboutBtn.onclick = () => {
  window.alert(
    'Allen Mouse Brain Common Coordinate Framework v3 (2017), 25 um. Wang et al. 2020, Cell, PMID: 32386544. Hover shows acronym, name and Allen structure ID.',
  )
}
nv1.sliceType = parseInt(sliceType.value, 10)

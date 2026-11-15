import NiiVue, {
  fetchAllenAtlasInfo,
  loadAllenAtlasVolumes,
  OVERLAY_COLOR_BLEND,
  SLICE_TYPE,
} from '../src/index.ts'
import manifest from './allen.imsc.json'

const broadcastSelect = document.getElementById('broadcastSelect')
const datasetSelect = document.getElementById('dataset')
const gl1 = document.getElementById('gl1')
const gl2 = document.getElementById('gl2')
const sliceType = document.getElementById('sliceType')
const webgpuCheck = document.getElementById('webgpuCheck')
const channelControls = document.getElementById('channelControls')
const cellCredit = document.getElementById('cellCredit')

sliceType.onchange = () => {
  nv1.sliceType = parseInt(sliceType.value, 10)
  nv2.sliceType = parseInt(sliceType.value, 10)
}
webgpuCheck.onchange = async function () {
  await nv1.reinitializeView({ backend: this.checked ? 'webgpu' : 'webgl2' })
  await nv2.reinitializeView({ backend: this.checked ? 'webgpu' : 'webgl2' })
}
broadcastSelect.onchange = () => {
  const v = parseInt(broadcastSelect.value, 10)
  if ((v & 1) > 0) nv1.broadcastTo([nv2])
  else nv1.broadcastTo()
  if ((v & 2) > 0) nv2.broadcastTo([nv1])
  else nv2.broadcastTo()
}

// Microscopy preset: the Allen IMSC interphase stage atlas (pixel sizes in
// um), with the channels, colours and windows allen.imsc.html uses. Both
// panes load the same data; broadcastTo links the camera (and crosshair and
// clip planes), never colormaps, windows or opacity, so each pane's channel
// edits stay its own.
const STAGE = manifest.stages[0]
const CELL_GENES = ['DNA', 'LMNB1', 'TUBA1B', 'TOMM20']
const color = (gene) =>
  gene === 'DNA'
    ? manifest.dnaColor
    : manifest.genes.find((g) => g.gene === gene).color

/** A colormap of one tint whose opacity ramps with intensity. */
function tint(nv, hex) {
  const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
  const name = `sync${hex.slice(1)}`
  nv.addColormap(name, {
    R: [rgb[0], rgb[0]],
    G: [rgb[1], rgb[1]],
    B: [rgb[2], rgb[2]],
    A: [0, 255],
    I: [0, 255],
  })
  return name
}

async function loadBrain(nv, mesh) {
  nv.volumeIsChannelStack = false
  await nv.loadVolumes([{ url: '/volumes/mni152.nii.gz' }])
  await nv.loadMeshes([{ url: '/meshes/BrainMesh_ICBM152.lh.mz3', ...mesh }])
}

async function loadCells(nv, volumes) {
  await nv.removeAllMeshes()
  nv.volumeIsChannelStack = true
  nv.volumeOverlayColorBlend = OVERLAY_COLOR_BLEND.MAX
  await nv.loadVolumes(volumes)
  for (const [i, gene] of CELL_GENES.entries()) {
    const [width, level] = STAGE.windows[gene]
    await nv.setVolume(i, {
      colormap: tint(nv, color(gene)),
      calMin: 255 * (level - width / 2),
      calMax: 255 * (level + width / 2),
      opacity: 1,
    })
  }
}

/** One pane's channel controls, editing only that pane's viewer. */
function paneControls(nv, prefix) {
  const channel = document.getElementById(`${prefix}Channel`)
  const visible = document.getElementById(`${prefix}Visible`)
  const windowInput = document.getElementById(`${prefix}Window`)
  channel.replaceChildren(...CELL_GENES.map((g, i) => new Option(g, String(i))))
  const sync = () => {
    const v = nv.volumes[Number(channel.value)]
    if (!v) return
    visible.checked = v.opacity > 0
    windowInput.value = String(Math.round(v.calMax))
  }
  channel.onchange = sync
  visible.onchange = () =>
    nv.setVolume(Number(channel.value), { opacity: visible.checked ? 1 : 0 })
  windowInput.oninput = () => {
    const i = Number(channel.value)
    const calMax = Math.max(nv.volumes[i].calMin + 1, Number(windowInput.value))
    nv.setVolume(i, { calMax })
  }
  return sync
}

const nv1 = new NiiVue({ backgroundColor: [1, 1, 1, 1] })
await nv1.attachToCanvas(gl1)
const nv2 = new NiiVue({ backgroundColor: [1, 1, 1, 1] })
await nv2.attachToCanvas(gl2)
const syncTop = paneControls(nv1, 'top')
const syncBottom = paneControls(nv2, 'bottom')

// Scene changes run one at a time, to completion, and a change superseded
// before it starts is skipped (as in allen.imsc.js): a slow Brain load can
// then never land on the panes after a newer Cells load.
let datasetToken = 0
let commits = Promise.resolve()
function commit(step) {
  const done = commits.then(step)
  commits = done.catch(() => {})
  return done
}

/** The four cell channels, read before the scene change that shows them. */
async function cellVolumes() {
  const url = manifest.stageAtlasBase + STAGE.atlas
  const { channelNames } = await fetchAllenAtlasInfo(url)
  return loadAllenAtlasVolumes(url, {
    // Raw channels are named '<GENE>_<cell line>_raw' (DNA: 'DNA_raw').
    channels: CELL_GENES.map((g) =>
      channelNames.findIndex(
        (n) => n.startsWith(`${g}_`) && n.endsWith('_raw'),
      ),
    ),
  })
}

datasetSelect.onchange = async () => {
  const token = ++datasetToken
  const cells = datasetSelect.value === 'cells'
  const volumes = cells ? await cellVolumes() : null
  await commit(async () => {
    if (token !== datasetToken) return
    channelControls.hidden = !cells
    if (cells) {
      cellCredit.textContent = manifest.source
      for (const nv of [nv1, nv2]) {
        nv.backgroundColor = [0, 0, 0, 1]
        await loadCells(nv, volumes)
      }
      sliceType.value = String(SLICE_TYPE.RENDER)
      sliceType.onchange()
      syncTop()
      syncBottom()
      return
    }
    for (const nv of [nv1, nv2]) nv.backgroundColor = [1, 1, 1, 1]
    await loadBrain(nv1, { color: [0.3, 0.8, 0.7, 1], shaderType: 'outline' })
    await loadBrain(nv2, { color: [0.7, 0.5, 1, 1] })
    nv1.setClipPlanes([[0.1, 0, 20]])
  })
}
// Apply the initial broadcast and data from the default select values.
broadcastSelect.onchange()
await datasetSelect.onchange()

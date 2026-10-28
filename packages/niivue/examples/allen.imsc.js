import NiiVue, {
  fetchAllenAtlasInfo,
  loadAllenAtlasVolumes,
  OVERLAY_COLOR_BLEND,
  SHOW_RENDER,
  SLICE_TYPE,
} from '../src/index.ts'
import manifest from './allen.imsc.json'

// The two viewers of the Allen Integrated Mitotic Stem Cell essay
// (imsc.allencell.org), rebuilt on NiiVue.
//
// 3D cell viewer: per mitotic stage, one atlas holding DNA plus 15 tagged
// structures, each from a different cell, aligned into one 256x256x58 volume.
// These are the copies in niivue/niivue-demo-images-lfs (Allen/IMSC), because
// imsc.allencell.org sends no CORS header.
//
// Cell gallery: the essay's z-stack viewer shows the same 75 cells (15 genes
// by 5 stages) as pre-rendered RGB slices. Here each cell loads its Cell
// Feature Explorer atlas from Allen's own bucket (CORS open, full resolution),
// with membrane, structure and DNA as separate channels and their
// segmentations. allen.imsc.json lists the cells; see its notes for the two
// whose Allen records disagree with the essay.
//
// The data are under the Allen Institute's terms of use: noncommercial, with
// citation.

const modeInputs = [...document.querySelectorAll('input[name="mode"]')]
const kindSelect = document.getElementById('kind')
const fuseCheck = document.getElementById('fuse')
const stagePanel = document.getElementById('stagePanel')
const cellPanel = document.getElementById('cellPanel')
const stagesRow = document.getElementById('stages')
const structuresRow = document.getElementById('structures')
const cellChannelsRow = document.getElementById('cellChannels')
const grid = document.getElementById('grid')
const noteLine = document.getElementById('note')
const statusLine = document.getElementById('status')
// id="location" shadows window.location, so this one element is looked up.
const footer = document.getElementById('location')

const nv1 = new NiiVue({
  backend: webgpuCheck.checked ? 'webgpu' : 'webgl2',
  backgroundColor: [0, 0, 0, 1],
  sliceType: SLICE_TYPE.MULTIPLANAR,
  showRender: SHOW_RENDER.ALWAYS,
  isColorbarVisible: false,
})
webgpuCheck.onchange = async function () {
  await nv1.reinitializeView({ backend: this.checked ? 'webgpu' : 'webgl2' })
}
window.nv1 = nv1
nv1.addEventListener('locationChange', (e) => {
  footer.textContent = e.detail.string
})
await nv1.attachToCanvas(gl1)

// textContent (not innerHTML): messages include data-derived names.
function say(message) {
  statusLine.textContent = message
}

/**
 * A black-to-colour ramp per hex colour, registered once. Alpha ramps too:
 * opaque black would hide the 3D render.
 */
const tints = new Map()
function tint(hex) {
  let name = tints.get(hex)
  if (!name) {
    const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
    name = nv1.addColormap(`imsc${hex.slice(1)}`, {
      R: [0, rgb[0]],
      G: [0, rgb[1]],
      B: [0, rgb[2]],
      A: [0, 255],
    })
    tints.set(hex, name)
  }
  return name
}

// Fused (the default): each channel keeps its brightest colour, on black, as
// Allen's viewers draw them. Unfused: the first channel is an opaque base.
function applyFusion() {
  nv1.volumeIsChannelStack = fuseCheck.checked
  nv1.volumeOverlayColorBlend = fuseCheck.checked
    ? OVERLAY_COLOR_BLEND.MAX
    : OVERLAY_COLOR_BLEND.ADDITIVE
}
applyFusion()
fuseCheck.onchange = () => {
  applyFusion()
  showLoaded()
}

/** The value below which `fraction` of a volume's voxels fall. */
function percentile(img, fraction) {
  const step = Math.max(1, Math.floor(img.length / 200000))
  const sample = []
  for (let i = 0; i < img.length; i += step) {
    sample.push(img[i])
  }
  sample.sort((a, b) => a - b)
  return sample[
    Math.min(sample.length - 1, Math.floor(fraction * sample.length))
  ]
}

/**
 * Window and colour each loaded channel. Raw stage composites sit on a
 * per-channel background floor, so they are windowed floor to peak. Raw cell
 * channels use Allen's own Cell Feature Explorer window, the 50th to 98th
 * percentile. Segmentations are masks, shown over their full range.
 */
let loaded = []
function showLoaded() {
  nv1.volumes.forEach((volume, index) => {
    const layer = loaded[index]
    if (!layer) return
    let calMin = volume.globalMin
    let calMax = volume.globalMax
    if (layer.window === 'percentile' && volume.img) {
      calMin = percentile(volume.img, 0.5)
      calMax = Math.max(calMin + 1, percentile(volume.img, 0.98))
    } else if (layer.window === 'mask') {
      calMin = 0
    }
    nv1.setVolume(index, {
      colormap: tint(layer.color),
      calMin,
      calMax,
      opacity: index === 0 || fuseCheck.checked ? 1 : 0.5,
    })
  })
}

// A newer request makes an in-flight load stale instead of racing it.
let loadToken = 0
async function load(sidecarUrl, layers, description) {
  const token = ++loadToken
  if (layers.length === 0) {
    say('Select at least one channel')
    return
  }
  say(`Loading ${description}...`)
  try {
    const volumes = await loadAllenAtlasVolumes(sidecarUrl, {
      channels: layers.map((layer) => layer.channel),
    })
    if (token !== loadToken) return
    loaded = layers
    await nv1.loadVolumes(volumes)
    if (token !== loadToken) return
    showLoaded()
    say(`Showing ${description}: ${layers.map((l) => l.label).join(', ')}`)
  } catch (err) {
    if (token !== loadToken) return
    say(`Could not load ${description}: ${err?.message ?? err}`)
    console.error(err)
  }
}

// --- 3D cell viewer ----------------------------------------------------------

const stageInfo = new Map()
let stageKey = manifest.stages[0].key

function stageUrl(stage) {
  return manifest.stageAtlasBase + stage.atlas
}

function pressed(row, active) {
  for (const button of row.querySelectorAll('button')) {
    button.setAttribute('aria-pressed', String(button === active))
  }
}

for (const stage of manifest.stages) {
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = stage.label
  button.onclick = () => {
    stageKey = stage.key
    pressed(stagesRow, button)
    loadStage()
  }
  stagesRow.append(button)
}
pressed(stagesRow, stagesRow.querySelector('button'))

// DNA and three structures to start; all 16 at once is slow and unreadable.
const structures = [
  { gene: 'DNA', label: 'DNA', color: manifest.dnaColor, on: true },
  ...manifest.genes.map((g) => ({
    gene: g.gene,
    label: `${g.structure} (${g.gene})`,
    color: g.color,
    on: ['LMNB1', 'TUBA1B', 'TOMM20'].includes(g.gene),
  })),
]
for (const s of structures) {
  const label = document.createElement('label')
  const box = document.createElement('input')
  box.type = 'checkbox'
  box.checked = s.on
  box.onchange = () => {
    s.on = box.checked
    loadStage()
  }
  const swatch = document.createElement('span')
  swatch.className = 'swatch'
  swatch.style.background = s.color
  label.append(box, ' ', swatch, ` ${s.label}`)
  structuresRow.append(label)
}

async function loadStage() {
  const stage = manifest.stages.find((s) => s.key === stageKey)
  const url = stageUrl(stage)
  let info = stageInfo.get(url)
  if (!info) {
    try {
      info = await fetchAllenAtlasInfo(url)
    } catch (err) {
      say(`Could not read ${stage.atlas}: ${err?.message ?? err}`)
      return
    }
    stageInfo.set(url, info)
  }
  // Channels are named DNA_raw, then <GENE>_<cellId>_raw, and _seg likewise.
  const suffix = `_${kindSelect.value}`
  const layers = structures
    .filter((s) => s.on)
    .map((s) => ({
      label: s.label,
      color: s.color,
      window: kindSelect.value === 'seg' ? 'mask' : 'range',
      channel: info.channelNames.findIndex((name) =>
        s.gene === 'DNA'
          ? name === `DNA${suffix}`
          : name.startsWith(`${s.gene}_`) && name.endsWith(suffix),
      ),
    }))
    .filter((layer) => layer.channel >= 0)
  noteLine.textContent =
    'Each structure comes from a different cell, aligned to a common shape.'
  await load(url, layers, `${stage.label} (stage composite)`)
}

// --- Cell gallery --------------------------------------------------------------

let cellChoice = { stage: manifest.stages[0].key, gene: manifest.genes[0].gene }

// Segmented, the membrane is its contour (CON_Memb): a filled membrane mask
// would hide everything inside the cell.
const cellChannels = manifest.cellChannels.map((c) => ({ ...c, on: true }))
for (const c of cellChannels) {
  const label = document.createElement('label')
  const box = document.createElement('input')
  box.type = 'checkbox'
  box.checked = true
  box.onchange = () => {
    c.on = box.checked
    loadCell()
  }
  const swatch = document.createElement('span')
  swatch.className = 'swatch'
  swatch.style.background = c.color
  label.append(box, ' ', swatch, ` ${c.name}`)
  cellChannelsRow.append(label)
}

{
  const head = grid.createTHead().insertRow()
  head.append(document.createElement('th'))
  for (const stage of manifest.stages) {
    const th = document.createElement('th')
    th.textContent = stage.label
    head.append(th)
  }
  const body = grid.createTBody()
  for (const g of manifest.genes) {
    const row = body.insertRow()
    const th = document.createElement('th')
    const swatch = document.createElement('span')
    swatch.className = 'swatch'
    swatch.style.background = g.color
    th.append(swatch, ` ${g.structure} (${g.gene})`)
    row.append(th)
    for (const stage of manifest.stages) {
      const cell = manifest.cells[stage.key][g.gene]
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = String(cell.cellId)
      button.title = `${g.gene}, ${stage.label}, cell ${cell.cellId}`
      if (cell.note) button.textContent += ' *'
      button.onclick = () => {
        cellChoice = { stage: stage.key, gene: g.gene }
        pressed(grid, button)
        loadCell()
      }
      row.insertCell().append(button)
    }
  }
  pressed(grid, grid.querySelector('tbody button'))
}

function loadCell() {
  const stage = manifest.stages.find((s) => s.key === cellChoice.stage)
  const gene = manifest.genes.find((g) => g.gene === cellChoice.gene)
  const cell = manifest.cells[stage.key][gene.gene]
  noteLine.textContent =
    [cell.note, gene.note].filter(Boolean).join(' ') ||
    `Cell ${cell.cellId}, from Allen's Cell Feature Explorer.`
  const kind = kindSelect.value
  const layers = cellChannels
    .filter((c) => c.on)
    .map((c) => ({
      label: c.name,
      color: c.color,
      window: kind === 'seg' ? 'mask' : 'percentile',
      channel: c[kind],
    }))
  return load(
    manifest.cellAtlasBase + cell.atlas,
    layers,
    `${gene.gene}, ${stage.label}, cell ${cell.cellId}`,
  )
}

// --- Mode switching ------------------------------------------------------------

function mode() {
  return modeInputs.find((input) => input.checked).value
}

function loadCurrent() {
  return mode() === 'stage' ? loadStage() : loadCell()
}

for (const input of modeInputs) {
  input.onchange = () => {
    stagePanel.hidden = mode() !== 'stage'
    cellPanel.hidden = mode() !== 'cell'
    loadCurrent()
  }
}
kindSelect.onchange = loadCurrent

await loadCurrent()

import NiiVue, {
  fetchAllenAtlasInfo,
  loadAllenAtlasVolumes,
  OVERLAY_COLOR_BLEND,
  SHOW_RENDER,
  SLICE_TYPE,
  VOLUME_RENDER_MODE,
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
const kindButtons = [...document.querySelectorAll('#dataKind button')]
const turntableButton = document.getElementById('turntable')
const resetButton = document.getElementById('reset')
const lede = document.getElementById('lede')
const fuseCheck = document.getElementById('fuse')
const clipCheck = document.getElementById('clipCheck')
const clipOverlaysCheck = document.getElementById('clipOverlaysCheck')
const zoomInput = document.getElementById('zoom')
const renderModeSelect = document.getElementById('renderMode')
const fluorControls = document.getElementById('fluorControls')
const densityInput = document.getElementById('density')
const brightnessInput = document.getElementById('brightness')
const stagePanel = document.getElementById('stagePanel')
const cellPanel = document.getElementById('cellPanel')
const stagesColumn = document.getElementById('stages')
const stageUp = document.getElementById('stageUp')
const stageDown = document.getElementById('stageDown')
const structuresBody = document.querySelector('#structures tbody')
const allStructures = document.getElementById('allStructures')
const cellChannelsRow = document.getElementById('cellChannels')
const grid = document.getElementById('grid')
const noteLine = document.getElementById('note')
const statusLine = document.getElementById('status')
// id="location" shadows window.location, so this one element is looked up.
const footer = document.getElementById('location')

const nv1 = new NiiVue({
  backend: webgpuCheck.checked ? 'webgpu' : 'webgl2',
  backgroundColor: [0, 0, 0, 1],
  sliceType: SLICE_TYPE.RENDER,
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

// Raw, Max project or Segmented, as in Allen's toolbar. Max project is the raw
// data drawn as a maximum intensity projection.
let dataKind = 'raw'
function channelKind() {
  return dataKind === 'seg' ? 'seg' : 'raw'
}

// 3D render mode. Fluorescence draws as Allen's 3D viewer does: a sample is as
// opaque as its fused colour is bright, times density, and brightness is a
// colour gain (Allen uses 1.6). Its densities are 0.06 raw and 0.4 segmented;
// NiiVue's step scale differs, so the matching values are 0.5 and 3.
// Fluorescence is offered only when this build of NiiVue has it.
const hasFluorescence = VOLUME_RENDER_MODE.FLUORESCENCE !== undefined
const renderModes = [
  ...(hasFluorescence
    ? [['Fluorescence', VOLUME_RENDER_MODE.FLUORESCENCE]]
    : []),
  ['Composite', VOLUME_RENDER_MODE.COMPOSITE],
  ['Maximum', VOLUME_RENDER_MODE.MAXIMUM],
]
for (const [label, value] of renderModes) {
  renderModeSelect.add(new Option(label, String(value)))
}
function applyRender() {
  const projecting = dataKind === 'mip'
  const fluorescence =
    !projecting &&
    hasFluorescence &&
    Number(renderModeSelect.value) === VOLUME_RENDER_MODE.FLUORESCENCE
  renderModeSelect.disabled = projecting
  fluorControls.hidden = !fluorescence
  nv1.volumeRenderMode = projecting
    ? VOLUME_RENDER_MODE.MAXIMUM
    : Number(renderModeSelect.value)
  if (fluorescence) {
    nv1.volumeDensity = Number(densityInput.value)
    nv1.volumeBrightness = Number(brightnessInput.value)
  }
}
renderModeSelect.onchange = applyRender
densityInput.oninput = applyRender
brightnessInput.oninput = applyRender
applyRender()

// 3D clip plane and zoom, as in allen.atlas.html. Every channel is an overlay,
// so without clipPlaneOverlay the clip plane appears to do nothing: the
// overlays show through a clipped base. Clip overlays cuts the whole stack.
clipCheck.onchange = () => {
  nv1.setClipPlane(clipCheck.checked ? [0.1, 270, 0] : [2, 0, 0])
}
clipOverlaysCheck.onchange = () => {
  nv1.clipPlaneOverlay = clipOverlaysCheck.checked
}

// While a clip plane is active the wheel moves the plane, not the camera, so
// the slider is the way to zoom a clipped render. Wheel zoom emits 'change',
// which keeps the slider in step (setting .value fires no 'input', no loop).
zoomInput.oninput = () => {
  nv1.scaleMultiplier = Number(zoomInput.value)
}
nv1.addEventListener('change', (e) => {
  if (e.detail?.property !== 'scaleMultiplier') return
  const value = Number(e.detail.value)
  if (Number.isFinite(value) && Number(zoomInput.value) !== value) {
    zoomInput.value = String(value)
  }
})

// Turntable and Reset, through animateTo. The camera starts looking down on
// the cell, as Allen's viewer does. Pressing on or scrolling the canvas stops
// a transition, which also turns the turntable off.
const home = { azimuth: 0, elevation: 90, scaleMultiplier: 1 }
nv1.azimuth = home.azimuth
nv1.elevation = home.elevation
let spinning = false
function setSpinning(on) {
  spinning = on
  turntableButton.setAttribute('aria-pressed', String(on))
}
async function spin() {
  while (spinning) {
    const result = await nv1.animateTo(
      { azimuth: nv1.azimuth + 360 },
      { angles: 'literal', easing: 'linear', duration: 12000 },
    )
    // 'stalled' is a hidden tab: keep going, it resumes when shown.
    if (result.reason !== 'finished' && result.reason !== 'stalled') {
      setSpinning(false)
    }
  }
}
turntableButton.onclick = () => {
  setSpinning(!spinning)
  if (spinning) spin()
  else nv1.stopAnimation()
}
resetButton.onclick = () => {
  setSpinning(false)
  clipCheck.checked = false
  clipCheck.onchange()
  nv1.animateTo(home, { duration: 600 })
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
 * Window and colour each loaded channel. A layer's window is one of:
 * - [window, level]: Allen's own setting for a raw stage structure, as
 *   fractions of the 0..255 range (the IMSC 3D viewer's table);
 * - 'percentile': raw cell channels, from the median (the background) to the
 *   channel's `ceiling` percentile, so that small bright structures such as
 *   spindle fibres keep their detail;
 * - 'mask': segmentations, over their full range.
 */
let loaded = []
function showLoaded() {
  nv1.volumes.forEach((volume, index) => {
    const layer = loaded[index]
    if (!layer) return
    let calMin = volume.globalMin
    let calMax = volume.globalMax
    if (Array.isArray(layer.window)) {
      const [width, level] = layer.window
      calMin = 255 * (level - width / 2)
      calMax = 255 * (level + width / 2)
    } else if (layer.window === 'percentile' && volume.img) {
      calMin = percentile(volume.img, 0.5)
      calMax = Math.max(calMin + 1, percentile(volume.img, layer.ceiling))
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

function pressed(container, active) {
  for (const button of container.querySelectorAll('button')) {
    button.setAttribute('aria-pressed', String(button === active))
  }
}

const stageButtons = manifest.stages.map((stage) => {
  const button = document.createElement('button')
  button.type = 'button'
  button.textContent = stage.label
  button.onclick = () => selectStage(stage.key)
  stagesColumn.append(button)
  return button
})
function selectStage(key) {
  stageKey = key
  const index = manifest.stages.findIndex((s) => s.key === key)
  pressed(stagesColumn, stageButtons[index])
  stageUp.disabled = index === 0
  stageDown.disabled = index === manifest.stages.length - 1
  loadStage()
}
function stepStage(delta) {
  const index = manifest.stages.findIndex((s) => s.key === stageKey)
  const next = manifest.stages[index + delta]
  if (next) selectStage(next.key)
}
stageUp.onclick = () => stepStage(-1)
stageDown.onclick = () => stepStage(1)
pressed(stagesColumn, stageButtons[0])
stageUp.disabled = true

// DNA and three structures to start; all 16 at once is slow and unreadable.
const structures = [
  { gene: 'DNA', structure: 'DNA', color: manifest.dnaColor, on: true },
  ...manifest.genes.map((g) => ({
    gene: g.gene,
    structure: g.structure,
    color: g.color,
    on: ['LMNB1', 'TUBA1B', 'TOMM20'].includes(g.gene),
  })),
]
const structureBoxes = structures.map((s) => {
  const row = structuresBody.insertRow()
  const label = document.createElement('label')
  const box = document.createElement('input')
  box.type = 'checkbox'
  box.checked = s.on
  box.onchange = () => {
    s.on = box.checked
    syncAllStructures()
    loadStage()
  }
  const swatch = document.createElement('span')
  swatch.className = 'swatch'
  swatch.style.background = s.color
  label.append(box, ' ', swatch, ` ${s.gene}`)
  row.insertCell().append(label)
  row.insertCell().textContent = s.structure
  return box
})
// The header box is All / None; part of the set shows as indeterminate.
function syncAllStructures() {
  const on = structures.filter((s) => s.on).length
  allStructures.checked = on === structures.length
  allStructures.indeterminate = on > 0 && on < structures.length
}
allStructures.onchange = () => {
  structures.forEach((s, i) => {
    s.on = allStructures.checked
    structureBoxes[i].checked = s.on
  })
  syncAllStructures()
  loadStage()
}
syncAllStructures()

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
  const suffix = `_${channelKind()}`
  const layers = structures
    .filter((s) => s.on)
    .map((s) => ({
      label: s.gene,
      color: s.color,
      window: channelKind() === 'seg' ? 'mask' : stage.windows[s.gene],
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
  const kind = channelKind()
  const layers = cellChannels
    .filter((c) => c.on)
    .map((c) => ({
      label: c.name,
      color: c.color,
      window: kind === 'seg' ? 'mask' : 'percentile',
      ceiling: c.ceiling,
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

// The stage composites are shown as one large render, as on Allen's page; a
// single cell also gets the slice views, like the essay's z-stack viewer.
function applyMode() {
  const stageMode = mode() === 'stage'
  stagePanel.hidden = !stageMode
  cellPanel.hidden = stageMode
  nv1.sliceType = stageMode ? SLICE_TYPE.RENDER : SLICE_TYPE.MULTIPLANAR
  nv1.is3DCrosshairVisible = !stageMode
  lede.textContent = stageMode
    ? `Study relationships among ${structures.length} cell structures superimposed in space and time using this 3D viewer.`
    : `Explore ${manifest.genes.length * manifest.stages.length} single cells, one per tagged gene and stage, at full resolution.`
}
for (const input of modeInputs) {
  input.onchange = () => {
    applyMode()
    loadCurrent()
  }
}
applyMode()

for (const button of kindButtons) {
  button.onclick = () => {
    const previous = channelKind()
    dataKind = button.dataset.kind
    pressed(button.parentElement, button)
    // Masks are hard-edged and sparse, so they need a higher density.
    densityInput.value = dataKind === 'seg' ? '3' : '0.5'
    applyRender()
    // Max project draws the raw channels already loaded.
    if (channelKind() !== previous) loadCurrent()
  }
}

await loadCurrent()

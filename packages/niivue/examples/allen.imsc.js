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
const rampControls = document.getElementById('rampControls')
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
 * A colormap per hex colour. Composite uses a baked ramp that draws like
 * Allen's 3D viewer: colour = tint * t^2 * brightness, opacity = density *
 * luminance(tint) * t^2, so a sample is as opaque as it is bright. Maximum and
 * Max project use a plain linear ramp. Alpha always ramps from 0: opaque black
 * would hide the 3D render. Each colour keeps one name per ramp; a new density
 * or brightness re-registers that name, which NiiVue's colormap caches follow.
 */
const tints = new Map()
function tint(hex) {
  const baked = isBaked()
  const density = Number(densityInput.value)
  const brightness = Number(brightnessInput.value)
  const name = `imsc${baked ? 'b' : ''}${hex.slice(1)}`
  const setting = baked ? `${density}_${brightness}` : ''
  if (tints.get(name) === setting) return name
  const rgb = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
  let cmap = { R: [0, rgb[0]], G: [0, rgb[1]], B: [0, rgb[2]], A: [0, 255] }
  if (baked) {
    // Rec. 709 luminance of the tint, 0..1.
    const luma = (0.2125 * rgb[0] + 0.7154 * rgb[1] + 0.0721 * rgb[2]) / 255
    cmap = { R: [], G: [], B: [], A: [], I: [] }
    for (let i = 0; i < 256; i++) {
      const t2 = (i / 255) ** 2
      cmap.R.push(Math.min(rgb[0] * t2 * brightness, 255))
      cmap.G.push(Math.min(rgb[1] * t2 * brightness, 255))
      cmap.B.push(Math.min(rgb[2] * t2 * brightness, 255))
      cmap.A.push(Math.min(density * luma * t2, 1) * 255)
      cmap.I.push(i)
    }
  }
  tints.set(name, setting)
  return nv1.addColormap(name, cmap)
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
  refresh()
}

// Raw, Max project or Segmented, as in Allen's toolbar. Max project is the raw
// data drawn as a maximum intensity projection.
let dataKind = 'raw'
function channelKind() {
  return dataKind === 'seg' ? 'seg' : 'raw'
}

// 3D render mode. Composite draws each channel through the baked ramp in
// tint(); density and brightness reshape that ramp (Allen's viewer uses
// brightness 1.6). Allen's densities are 0.06 raw and 0.4 segmented; NiiVue's
// step scale differs, so the matching values are 0.5 and 3.
const renderModes = [
  ['Composite', VOLUME_RENDER_MODE.COMPOSITE],
  ['Maximum', VOLUME_RENDER_MODE.MAXIMUM],
]
for (const [label, value] of renderModes) {
  renderModeSelect.add(new Option(label, String(value)))
}
function isBaked() {
  return (
    dataKind !== 'mip' &&
    Number(renderModeSelect.value) === VOLUME_RENDER_MODE.COMPOSITE
  )
}
function applyRender() {
  const projecting = dataKind === 'mip'
  renderModeSelect.disabled = projecting
  rampControls.hidden = !isBaked()
  nv1.volumeRenderMode = projecting
    ? VOLUME_RENDER_MODE.MAXIMUM
    : Number(renderModeSelect.value)
}
renderModeSelect.onchange = () => {
  applyRender()
  refresh()
}
densityInput.oninput = () => refresh()
brightnessInput.oninput = () => refresh()
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
async function showLoaded() {
  for (const [index, volume] of nv1.volumes.entries()) {
    const layer = loaded[index]
    if (!layer) continue
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
    await nv1.setVolume(index, {
      colormap: tint(layer.color),
      calMin,
      calMax,
      opacity: index === 0 || fuseCheck.checked ? 1 : 0.5,
    })
  }
}

// Every change to the viewer's volumes runs here, one at a time and to
// completion, so a load never swaps volumes under a setVolume still running.
let commits = Promise.resolve()
function commit(step) {
  const done = commits.then(step)
  commits = done.catch(() => {})
  return done
}

// Re-window the loaded layers after a control changes. A drag queues one
// pass at a time; that pass reads the controls when it runs.
let refreshQueued = false
function refresh() {
  if (refreshQueued) return
  refreshQueued = true
  commit(() => {
    refreshQueued = false
    return showLoaded()
  }).catch((err) => console.error(err))
}

// A newer request makes an in-flight load stale instead of racing it. A
// request takes its token before its first await (a stage reads its channel
// list first), and each commit checks the token just before it replaces the
// volumes, so a slow, superseded load can neither overwrite newer data nor
// leave it under the wrong selection.
let loadToken = 0
async function load(token, sidecarUrl, layers, description) {
  if (token !== loadToken) return
  try {
    if (layers.length === 0) {
      // Clear the viewer too, so it never shows data that is not selected.
      const cleared = await commit(async () => {
        if (token !== loadToken) return false
        await nv1.removeAllVolumes()
        loaded = []
        return true
      })
      if (cleared && token === loadToken) say('Select at least one channel')
      return
    }
    say(`Loading ${description}...`)
    const volumes = await loadAllenAtlasVolumes(sidecarUrl, {
      channels: layers.map((layer) => layer.channel),
    })
    const shown = await commit(async () => {
      if (token !== loadToken) return false
      // loadVolumes keeps the old volumes until the new ones are ready, so
      // `loaded` follows the swap, not the request.
      await nv1.loadVolumes(volumes)
      loaded = layers
      // The viewer now holds these layers, so window them even if a newer
      // request has come in meanwhile; only the status waits for that one.
      await showLoaded()
      return true
    })
    if (!shown || token !== loadToken) return
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

function swatch(color) {
  const span = document.createElement('span')
  span.className = 'swatch'
  span.style.background = color
  return span
}

/** A checkbox, colour swatch and text, as one label. */
function swatchLabel(text, color, checked, onchange) {
  const label = document.createElement('label')
  const box = document.createElement('input')
  box.type = 'checkbox'
  box.checked = checked
  box.onchange = () => onchange(box.checked)
  label.append(box, ' ', swatch(color), ` ${text}`)
  return { label, box }
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
function markStage(key) {
  stageKey = key
  const index = manifest.stages.findIndex((s) => s.key === key)
  pressed(stagesColumn, stageButtons[index])
  stageUp.disabled = index === 0
  stageDown.disabled = index === manifest.stages.length - 1
}
function selectStage(key) {
  markStage(key)
  loadStage()
}
function stepStage(delta) {
  const index = manifest.stages.findIndex((s) => s.key === stageKey)
  const next = manifest.stages[index + delta]
  if (next) selectStage(next.key)
}
stageUp.onclick = () => stepStage(-1)
stageDown.onclick = () => stepStage(1)
markStage(stageKey)

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
  const { label, box } = swatchLabel(s.gene, s.color, s.on, (on) => {
    s.on = on
    syncAllStructures()
    loadStage()
  })
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
  const token = ++loadToken
  const stage = manifest.stages.find((s) => s.key === stageKey)
  const url = stageUrl(stage)
  let info = stageInfo.get(url)
  if (!info) {
    try {
      info = await fetchAllenAtlasInfo(url)
    } catch (err) {
      if (token === loadToken) {
        say(`Could not read ${stage.atlas}: ${err?.message ?? err}`)
      }
      return
    }
    stageInfo.set(url, info)
    if (token !== loadToken) return
  }
  // Channels are named DNA_raw, then <GENE>_<cellId>_raw, and _seg likewise.
  const kind = channelKind()
  const suffix = `_${kind}`
  const layers = structures
    .filter((s) => s.on)
    .map((s) => ({
      label: s.gene,
      color: s.color,
      window: kind === 'seg' ? 'mask' : stage.windows[s.gene],
      channel: info.channelNames.findIndex((name) =>
        s.gene === 'DNA'
          ? name === `DNA${suffix}`
          : name.startsWith(`${s.gene}_`) && name.endsWith(suffix),
      ),
    }))
    .filter((layer) => layer.channel >= 0)
  noteLine.textContent =
    'Each structure comes from a different cell, aligned to a common shape.'
  await load(token, url, layers, `${stage.label} (stage composite)`)
}

// --- Cell gallery --------------------------------------------------------------

let cellChoice = { stage: manifest.stages[0].key, gene: manifest.genes[0].gene }

// Segmented, the membrane is its contour (CON_Memb): a filled membrane mask
// would hide everything inside the cell.
const cellChannels = manifest.cellChannels.map((c) => ({ ...c, on: true }))
for (const c of cellChannels) {
  const { label } = swatchLabel(c.name, c.color, true, (on) => {
    c.on = on
    loadCell()
  })
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
    th.append(swatch(g.color), ` ${g.structure} (${g.gene})`)
    row.append(th)
    for (const stage of manifest.stages) {
      const cell = manifest.cells[stage.key][g.gene]
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = String(cell.cellId)
      button.title = `${g.gene}, ${stage.label}, cell ${cell.cellId}`
      button.setAttribute(
        'aria-label',
        `${button.title}${cell.note ? ', see note' : ''}`,
      )
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
  const token = ++loadToken
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
    token,
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
    else refresh()
  }
}

await loadCurrent()

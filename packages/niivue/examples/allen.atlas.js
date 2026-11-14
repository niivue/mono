import NiiVue, {
  allenAtlasSpacing,
  CHANNEL_COLORMAPS,
  CHANNEL_GRAY_COLORMAP,
  DRAG_MODE,
  fetchAllenAtlasInfo,
  loadAllenAtlasVolumes,
  OVERLAY_COLOR_BLEND,
  SHOW_RENDER,
  SLICE_TYPE,
} from '../src/index.ts'
import manifest from './allen.imsc.json'

// Allen "volume-viewer" datasets ship one JSON sidecar plus N PNG atlases, each
// packing three independent channels into its R/G/B planes. See
// notes/allen-atlas-format.md.
//
// The bundled datasets are the Integrated Mitotic Stem Cell stages copied to
// niivue/niivue-demo-images-lfs (Allen/IMSC, under the Allen Institute's
// noncommercial terms; see the LICENSE there). Allen's own host,
// imsc.allencell.org, sends no Access-Control-Allow-Origin header, so a page
// cannot fetch from it directly. When the volumetric server is running
// (bunx nx dev iiif-volumetric-server, after fetch-allen) its /allen mirror is
// listed first.

const gl1 = document.getElementById('gl1')
const webgpuCheck = document.getElementById('webgpuCheck')
const datasetSelect = document.getElementById('dataset')
const filesInput = document.getElementById('files')
const secondaryDrag = document.getElementById('secondaryDrag')
const blendSelect = document.getElementById('blend')
const channelList = document.getElementById('channelList')
const clipCheck = document.getElementById('clipCheck')
// id="location" shadows window.location, so this one element is looked up.
const footer = document.getElementById('location')

const nv1 = new NiiVue({
  backend: webgpuCheck.checked ? 'webgpu' : 'webgl2',
  backgroundColor: [0, 0, 0, 1],
  sliceType: SLICE_TYPE.MULTIPLANAR,
  // The clip control acts on the 3D render, so keep its tile in the
  // multiplanar layout instead of the slices-only AUTO default.
  showRender: SHOW_RENDER.ALWAYS,
  isColorbarVisible: false,
  // Right drag pans and the wheel zooms the 2D slices; yoked, a zoom on any
  // tile zooms them all (on the 3D render the wheel moves an active clip plane
  // instead, so zoom a clipped render from a slice).
  secondaryDragMode: DRAG_MODE.pan,
  isYoked3DTo2DZoom: true,
  // Every channel of a stack is an overlay, so the clip plane must cut them
  // too, or they show through the clipped base and it appears to do nothing.
  clipPlaneOverlay: true,
  // Every channel counts alike, on black, as fluorescence viewers such as
  // Vol-E show them.
  volumeIsChannelStack: true,
})
window.nv1 = nv1
webgpuCheck.onchange = async function () {
  await nv1.reinitializeView({ backend: this.checked ? 'webgpu' : 'webgl2' })
}
secondaryDrag.onchange = () => {
  nv1.secondaryDragMode = Number(secondaryDrag.value)
}
// max keeps each pixel's brightest channel; additive sums them, so overlaps
// brighten.
function applyBlend() {
  nv1.volumeOverlayColorBlend =
    blendSelect.value === 'max'
      ? OVERLAY_COLOR_BLEND.MAX
      : OVERLAY_COLOR_BLEND.ADDITIVE
}
applyBlend()
blendSelect.onchange = applyBlend
await nv1.attachToCanvas(gl1)

// The footer shows what is loaded until a click reports a voxel, and again
// whenever the dataset or channels change. textContent: names come from data.
function say(message) {
  footer.textContent = message
}
function fail(message, err) {
  say(`${message}: ${err?.message ?? err}`)
  console.error(message, err)
}
nv1.addEventListener('locationChange', (e) => {
  footer.textContent = e.detail.string
})

// --- Dataset menu: bundled stages, a custom URL or local files ---------------

const LOCAL_MIRROR =
  'http://localhost:8080/allen/COMP_crop_Interphase_atlas.json'
const group = (label, options) => {
  const g = Object.assign(document.createElement('optgroup'), { label })
  g.append(...options)
  return g
}
const stageOptions = manifest.stages.map(
  (stage) =>
    new Option(
      `${stage.label} (IMSC)`,
      `${manifest.stageAtlasBase}${stage.atlas}`,
    ),
)
const customOption = new Option()
datasetSelect.replaceChildren(
  group('IMSC mitotic stages', stageOptions),
  group('Custom', [
    new Option('Custom URL...', 'custom-url'),
    new Option('Custom files...', 'custom-files'),
  ]),
)

// Start on the volumetric server's /allen mirror when one is running (local,
// so it loads faster). An https: page cannot fetch http://localhost at all
// (mixed content logs an error first), so probe only from an http: page.
async function hasLocalMirror() {
  if (window.location.protocol !== 'http:') return false
  try {
    const res = await fetch(LOCAL_MIRROR, {
      method: 'HEAD',
      signal: AbortSignal.timeout(1500),
    })
    return res.ok
  } catch {
    return false
  }
}
if (await hasLocalMirror()) {
  datasetSelect.prepend(
    group('Local mirror', [new Option('Interphase (local)', LOCAL_MIRROR)]),
  )
}

/**
 * Source of the shown dataset: a URL, or local files served out of a Map by a
 * stand-in fetch. `loadAllenAtlasVolumes` resolves the sidecar's image names
 * against the sidecar URL, so local files only need a base the Map can key on.
 */
let source = null
let shownValue = ''

function fileSource(files) {
  const byName = new Map(files.map((file) => [file.name, file]))
  const sidecarName = [...byName.keys()].find((n) => n.endsWith('.json'))
  if (!sidecarName) {
    throw new Error('no .json sidecar among the selected files')
  }
  const fetchImpl = async (input) => {
    const name = String(input).split('/').pop()
    const file = byName.get(name)
    if (!file) {
      return new Response(null, { status: 404, statusText: `missing ${name}` })
    }
    return new Response(file, { status: 200 })
  }
  return { sidecarUrl: `file:///${sidecarName}`, options: { fetchImpl } }
}

// A custom pick is listed as itself, so the menu always names what is shown.
function showCustom(value, label) {
  previousCustom = { value: customOption.value, text: customOption.text }
  customOption.value = value
  customOption.text = `${label} (custom)`
  datasetSelect.querySelector('optgroup:last-of-type').prepend(customOption)
  datasetSelect.value = value
}

// A failed open puts the menu back on what is still shown, custom entry included.
let previousCustom = { value: '', text: '' }
function restoreMenu() {
  if (customOption.value !== shownValue) {
    Object.assign(customOption, previousCustom)
    if (!previousCustom.value) customOption.remove()
  }
  datasetSelect.value = shownValue
}

datasetSelect.onchange = () => {
  const value = datasetSelect.value
  if (value === 'custom-files') {
    datasetSelect.value = shownValue
    filesInput.click()
    return
  }
  if (value === 'custom-url') {
    datasetSelect.value = shownValue
    const url = window.prompt('Allen atlas sidecar (.json) URL')?.trim()
    if (!url) return
    showCustom(url, url.split('/').pop())
    open({ sidecarUrl: url, options: {} })
    return
  }
  open(value === 'local' ? localSource : { sidecarUrl: value, options: {} })
}
// The last local files opened, so their menu entry can reopen them.
let localSource = null

filesInput.onchange = () => {
  const files = [...filesInput.files]
  filesInput.value = ''
  if (files.length === 0) return
  try {
    localSource = fileSource(files)
    showCustom('local', localSource.sidecarUrl.slice(8))
    open(localSource)
  } catch (err) {
    fail('Could not use those files', err)
  }
}

// --- Channel panel ------------------------------------------------------------

let info = null
// Opens and loads can overlap (a slow URL, quick ticks); only the latest of
// each wins. Separate counts, so a tick on the old dataset's channels while a
// new one opens does not cancel the open.
let opening = 0
let generation = 0
// The channels on screen, in volume order: what the window inputs address.
let shownChannels = []
// Scene swaps run one at a time, each skipped once a newer request exists:
// loadVolumes prepares before it swaps, so a check after it is too late.
let swaps = Promise.resolve()
function swapScene(mine, step) {
  const done = swaps.then(() => (mine === generation ? step() : false))
  swaps = done.catch(() => {})
  return done
}

function selectedChannels() {
  return [...channelList.querySelectorAll('input[type=checkbox]:checked')].map(
    (box) => Number(box.value),
  )
}

/** IMSC names a raw channel <GENE>_<cellId>_raw (DNA_raw for DNA): the gene. */
function geneName(name) {
  return name.replace(/(_\d+)?_raw$/, '')
}

function showChannels() {
  channelList.replaceChildren()
  // IMSC pairs each raw channel with a binary segmentation of the same
  // structure (_seg); list only the raw ones, by their gene name.
  const hasRaw = info.channelNames.some((name) => name.endsWith('_raw'))
  info.channelNames.forEach((name, index) => {
    if (hasRaw && !name.endsWith('_raw')) return
    const label = document.createElement('label')
    const box = Object.assign(document.createElement('input'), {
      type: 'checkbox',
      value: String(index),
      // Loading 32 volumes at once is slow and unreadable; start with DNA,
      // the first structure and the nuclear envelope (lamin B1).
      checked: index < 2 || name.startsWith('LMNB1_'),
    })
    box.onchange = loadSelected
    const swatch = document.createElement('span')
    swatch.className = 'swatch'
    swatch.dataset.channel = String(index)
    // The window maximum, in the stored 0..255 units, once loaded.
    const max = Object.assign(document.createElement('input'), {
      type: 'number',
      min: '0',
      max: '255',
      step: '1',
      disabled: true,
      title: 'Window maximum: lower is brighter',
    })
    max.dataset.channel = String(index)
    max.oninput = () => {
      const at = shownChannels.indexOf(index)
      const calMax = Number(max.value)
      if (at >= 0 && Number.isFinite(calMax))
        nv1.setVolume(at, {
          calMax: Math.max(calMax, nv1.volumes[at].calMin + 1),
        })
    }
    label.append(box, swatch, hasRaw ? geneName(name) : name, max)
    channelList.append(label)
  })
}

async function open(next) {
  const mine = ++opening
  const picked = datasetSelect.value
  say('Reading the sidecar...')
  try {
    const nextInfo = await fetchAllenAtlasInfo(next.sidecarUrl, next.options)
    if (mine !== opening) return
    shownValue = picked
    source = next
    info = nextInfo
    shownChannels = []
    showChannels()
    await loadSelected()
  } catch (err) {
    if (mine !== opening) return
    restoreMenu()
    fail('Could not read the sidecar', err)
  }
}

/** The value below which `fraction` of a volume's voxels fall (sampled). */
function percentile(img, fraction) {
  const step = Math.max(1, Math.floor(img.length / 200000))
  const sample = []
  for (let i = 0; i < img.length; i += step) sample.push(img[i])
  sample.sort((a, b) => a - b)
  return sample[
    Math.min(sample.length - 1, Math.floor(fraction * sample.length))
  ]
}

/**
 * Window each channel from its background to its 99.9th percentile. These
 * channels sit on a large background offset (the IMSC data floors at 69 to
 * 173, not 0) that fills most of the volume, and the cell's structures are a
 * small bright fraction, so a floor-to-peak window leaves them dim.
 */
function applyWindows(channels) {
  nv1.volumes.forEach((volume, at) => {
    const calMin = percentile(volume.img, 0.5)
    const calMax = Math.max(calMin + 1, percentile(volume.img, 0.999))
    nv1.setVolume(at, { calMin, calMax, opacity: 1 })
    const max = channelList.querySelector(
      `input[data-channel="${channels[at]}"]`,
    )
    if (max) max.value = String(calMax)
  })
}

// Colours are assigned across the selected set, so the swatch follows them.
const CHANNEL_RGB = new Map(
  [...CHANNEL_COLORMAPS, CHANNEL_GRAY_COLORMAP].map((c) => [c.name, c.rgb]),
)
function paintSwatches(channels) {
  for (const swatch of channelList.querySelectorAll('.swatch')) {
    const at = channels.indexOf(Number(swatch.dataset.channel))
    const rgb = CHANNEL_RGB.get(nv1.volumes[at]?.colormap)
    swatch.style.background = at >= 0 && rgb ? `rgb(${rgb.join(',')})` : ''
  }
}

function describe(channels) {
  const spacing = allenAtlasSpacing(info)
    .map((s) => s.toFixed(2))
    .join(' x ')
  const names = channels.map((c) => geneName(info.channelNames[c])).join(', ')
  return (
    `${info.tileWidth}x${info.tileHeight}x${info.tiles} voxels, ${spacing} ${info.spacingUnit}; ` +
    (names ? `showing ${names}` : 'no channel selected')
  )
}

// Every tick reloads the selection: channel colours are assigned across the
// selected set, so they stay distinct. The PNGs come from the HTTP cache.
async function loadSelected() {
  const mine = ++generation
  const channels = selectedChannels()
  const loading = source
  say(channels.length ? `Loading ${channels.length} channels...` : describe([]))
  try {
    const volumes = channels.length
      ? await loadAllenAtlasVolumes(source.sidecarUrl, {
          ...source.options,
          channels,
        })
      : []
    const swapped = await swapScene(mine, async () => {
      await nv1.loadVolumes(volumes)
      // A dataset opened meanwhile has its own rows: these channels are not theirs.
      shownChannels = loading === source ? channels : []
      for (const max of channelList.querySelectorAll('input[type=number]')) {
        max.disabled = !shownChannels.includes(Number(max.dataset.channel))
      }
      applyWindows(shownChannels)
      paintSwatches(shownChannels)
      return true
    })
    if (swapped && mine === generation) say(describe(channels))
  } catch (err) {
    if (mine === generation) fail('Could not load the channels', err)
  }
}

document.getElementById('aboutBtn').onclick = () => {
  window.alert(
    'Integrated Mitotic Stem Cell data from the Allen Institute for Cell ' +
      'Science (imsc.allencell.org), copied to niivue-demo-images-lfs ' +
      "(Allen/IMSC) under the Allen Institute's noncommercial terms. Each " +
      'mitotic stage holds DNA plus 15 tagged structures, each imaged in a ' +
      'different hiPS cell and aligned into one volume. This demo lists only ' +
      'the raw intensity channels: the ' +
      "dataset's _seg channels are binary segmentations of the same " +
      'structures. Custom datasets list every channel.',
  )
}

// --- 3D clip plane ------------------------------------------------------------
clipCheck.onchange = () => {
  nv1.setClipPlane(clipCheck.checked ? [0.1, 270, 0] : [2, 0, 0])
}
await open({ sidecarUrl: datasetSelect.value, options: {} })

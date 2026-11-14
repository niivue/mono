import NiiVue, {
  CHANNEL_COLORMAPS,
  CHANNEL_GRAY_COLORMAP,
  DRAG_MODE,
  describeTiff,
  OVERLAY_COLOR_BLEND,
  omeTiffVolumesFrom,
  parseTiff,
  SHOW_RENDER,
  SLICE_TYPE,
  tiffChannelCount,
  tiffChannelName,
  tiffIsTiled,
} from '../src/index.ts'
import { backendFromUrl, isAntiAlias } from './displayControls.js'
import { omeXml, phantomChannels, writeTiff } from './ome.tiff.write.js'

// OME-TIFF is the third of the microscopy containers this package reads (see
// notes/ome-tiff-format.md). A .tif holds a flat stack of image planes and
// nothing else; the metadata block in the first directory is what says how
// those planes fold into z, channel and time. This page reads a whole file
// into memory and shows each channel as a volume: slices, a 3D render and a
// clip plane. (Large 2D slides stream tile by tile in demo-ext-tile instead.)
// The decoders and metadata flavours (OME-XML, ImageJ, plain stacks; none,
// PackBits, Deflate) are covered by src/volume/tiff*.test.ts.

const gl1 = document.getElementById('gl1')
const webgpuCheck = document.getElementById('webgpuCheck')
const imageSelect = document.getElementById('image')
const fileInput = document.getElementById('file')
const secondaryDrag = document.getElementById('secondaryDrag')
const clipCheck = document.getElementById('clipCheck')
const nearestCheck = document.getElementById('nearestCheck')
const blendSelect = document.getElementById('blend')
const channelList = document.getElementById('channelList')
const statusLine = document.getElementById('status')

/**
 * Real OME-TIFFs written by other software, so the reader is exercised against
 * files this repository did not produce, plus a phantom written here. Every
 * host below sends CORS headers, which a browser needs for a cross-origin
 * fetch; most microscopy archives do not, so an arbitrary URL may still be
 * blocked (Open file always works).
 */
const PHANTOM = 'phantom'
const SAMPLES = [
  {
    label: 'hiPSC cell, 3 channels, 238 x 284 x 70 (14 MB)',
    url: 'https://allencell.s3.amazonaws.com/aics/variance_project_dataset/crop_raw/012b784e_raw.ome.tif',
    credit:
      'Allen Institute for Cell Science, variance project dataset (research and non-commercial use, with citation)',
    note:
      'BigTIFF, 16-bit, 210 planes folding into three channels of a 70-slice stack. ' +
      'It names no channel colours and states no voxel size, so the colours are ' +
      'the fallback palette and the voxels are 1 um.',
  },
  {
    label: 'Spheroid, Hoechst channel, 1024 x 1024 (2.2 MB)',
    url: 'https://ftp.ebi.ac.uk/biostudies/fire/S-BIAD/254/S-BIAD2254/Files/spher-colo52/PB000142_spher-colo52_HT29_L1/Well-B04-z0-HOECHST.ome.tiff',
    credit:
      'Cell Painting in 3D spheroids, BioImage Archive S-BIAD2254 (CC BY 4.0)',
    note: 'Bio-Formats output: big-endian, 16-bit, micrometre units and a channel colour.',
  },
  {
    label: 'Synthetic phantom, 3 channels (generated here)',
    url: PHANTOM,
    credit: 'Synthetic phantom written by this page (OME-XML, Deflate)',
    note: 'Deliberately anisotropic voxels: a wrong z-spacing shows as a squashed or stretched sagittal view.',
  },
]

const nv1 = new NiiVue({
  backend: backendFromUrl(),
  isAntiAlias,
  backgroundColor: [0, 0, 0, 1],
  sliceType: SLICE_TYPE.MULTIPLANAR,
  // The clip control acts on the 3D render, so keep its tile in the
  // multiplanar layout instead of the slices-only AUTO default.
  showRender: SHOW_RENDER.ALWAYS,
  isColorbarVisible: false,
  // Right drag pans and the wheel zooms the 2D slices; yoked, a zoom on any
  // tile zooms them all.
  secondaryDragMode: DRAG_MODE.pan,
  isYoked3DTo2DZoom: true,
  // Every channel counts alike, on black, as fluorescence viewers show them.
  volumeIsChannelStack: true,
  // Each channel is an overlay, so the clip plane must cut them too, or they
  // show through the clipped base and it appears to do nothing.
  clipPlaneOverlay: true,
  // A dropped file is read here (channels and all), not as one volume.
  isDragDropEnabled: false,
})
window.nv1 = nv1
webgpuCheck.checked = nv1.backend === 'webgpu'
webgpuCheck.onchange = async function () {
  await nv1.reinitializeView({ backend: this.checked ? 'webgpu' : 'webgl2' })
}
secondaryDrag.onchange = () => {
  nv1.secondaryDragMode = Number(secondaryDrag.value)
}
clipCheck.onchange = () => {
  nv1.setClipPlane(clipCheck.checked ? [0.1, 270, 0] : [2, 0, 0])
}
nearestCheck.onchange = () => {
  nv1.volumeIsNearestInterpolation = nearestCheck.checked
}
document.getElementById('colorBtn').oninput = function () {
  const [r, g, b] = [1, 3, 5].map(
    (i) => parseInt(this.value.slice(i, i + 2), 16) / 255,
  )
  nv1.backgroundColor = [r, g, b, 1]
}
// max keeps each pixel's brightest channel; additive sums them.
function applyBlend() {
  nv1.volumeOverlayColorBlend =
    blendSelect.value === 'max'
      ? OVERLAY_COLOR_BLEND.MAX
      : OVERLAY_COLOR_BLEND.ADDITIVE
}
applyBlend()
blendSelect.onchange = applyBlend

// The status bar shows messages until a click on the image, then the voxel
// under the crosshair; the next message takes it back.
let isShowingLocation = false
gl1.addEventListener('pointerdown', () => {
  isShowingLocation = true
})
nv1.addEventListener('locationChange', (e) => {
  if (isShowingLocation) statusLine.textContent = e.detail.string
})
await nv1.attachToCanvas(gl1)
webgpuCheck.checked = nv1.backend === 'webgpu'

// textContent (not innerHTML): messages include data-derived channel names.
function say(message) {
  isShowingLocation = false
  statusLine.textContent = message
}
function fail(message, err) {
  say(`${message}: ${err?.message ?? err}`)
  console.error(message, err)
}

document.getElementById('aboutBtn').onclick = () => {
  window.alert(
    'OME-TIFF stores a microscopy stack as a flat run of TIFF planes; its ' +
      'metadata says how they fold into z, channel and time, and gives the ' +
      'voxel size and channel names and colours. NiiVue reads OME-XML and ' +
      'ImageJ hyperstack metadata (a plain stack is one channel), 8/16/32-bit ' +
      'and float data, classic TIFF and BigTIFF, strips or tiles, and ' +
      'uncompressed, PackBits, LZW or Deflate planes. Each channel becomes a ' +
      'volume: slices, a 3D render and a clip plane.\n\n' +
      'Pick a sample, open your own .tif (or drop one on the image), or give ' +
      'a URL. The status bar credits each sample; hover a menu entry for its ' +
      'format notes.',
  )
}

// --- The phantom -----------------------------------------------------------------

const SIZE = { sizeX: 192, sizeY: 160, sizeZ: 64 }
const SPACING = [0.25, 0.25, 0.9]

/** A 3-channel OME-TIFF; OME's XYCZT order varies channel fastest. */
async function phantomBuffer() {
  const channels = phantomChannels(SIZE)
  const planes = []
  for (let z = 0; z < SIZE.sizeZ; z++) {
    for (const channel of channels) planes.push(channel.planes[z])
  }
  const bytes = await writeTiff({
    width: SIZE.sizeX,
    height: SIZE.sizeY,
    planes,
    description: omeXml({
      name: 'NiiVue synthetic phantom',
      ...SIZE,
      sizeC: channels.length,
      spacing: SPACING,
      channels,
    }),
    compression: 'deflate',
  })
  return bytes.buffer
}

// --- Image menu: samples, then a custom URL or a local file ------------------------

const customOption = new Option()
const customUrlOption = new Option('Custom URL...', 'custom-url')
for (const sample of SAMPLES) {
  const option = new Option(sample.label, sample.url)
  option.title = sample.note
  imageSelect.append(option)
}
imageSelect.append(customUrlOption, new Option('Open file...', 'open-file'))
let shownValue = SAMPLES[0].url

// A custom pick is listed as itself, so the menu always names what is shown.
function showCustom(value, label) {
  previousCustom = { value: customOption.value, text: customOption.text }
  customOption.value = value
  customOption.text = `${label} (custom)`
  customUrlOption.before(customOption)
  imageSelect.value = value
}

// A failed open puts the menu back on what is still shown, custom entry included.
let previousCustom = { value: '', text: '' }
function restoreMenu() {
  if (customOption.value !== shownValue) {
    Object.assign(customOption, previousCustom)
    if (!previousCustom.value) customOption.remove()
  }
  imageSelect.value = shownValue
}

imageSelect.onchange = () => {
  const value = imageSelect.value
  if (value === 'open-file') {
    imageSelect.value = shownValue
    fileInput.click()
    return
  }
  if (value === 'custom-url') {
    imageSelect.value = shownValue
    const url = window.prompt('OME-TIFF URL (the host must send CORS)')?.trim()
    if (!url) return
    showCustom(url, url.split('/').pop() || url)
    openUrl(url)
    return
  }
  if (value === PHANTOM) openPhantom()
  else if (value === 'local') openFile(localFile)
  else openUrl(value)
}

// The last local file opened, so its menu entry can reopen it.
let localFile = null
async function openFile(file) {
  localFile = file
  showCustom('local', file.name)
  await open(file.name, () => file.arrayBuffer(), '')
}
fileInput.onchange = () => {
  const file = fileInput.files?.[0]
  fileInput.value = ''
  if (file) openFile(file)
}
const main = document.getElementById('canvas-container')
main.addEventListener('dragover', (e) => e.preventDefault())
main.addEventListener('drop', (e) => {
  e.preventDefault()
  const file = e.dataTransfer?.files?.[0]
  if (file) openFile(file)
})

function openUrl(url) {
  const name = url.split('/').pop() || url
  const credit = SAMPLES.find((s) => s.url === url)?.credit ?? ''
  return open(
    name,
    async () => {
      const response = await fetch(url)
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`)
      }
      return response.arrayBuffer()
    },
    credit,
  )
}

function openPhantom() {
  return open('Synthetic phantom', phantomBuffer, SAMPLES.at(-1).credit)
}

// --- Channel panel ---------------------------------------------------------------

/** The parsed TIFF on offer, its credit, and how it was described. */
let source = null
let sourceCredit = ''
let sourceSummary = ''
// Opens and loads can overlap (a slow URL, quick ticks); only the latest of
// each wins. Separate counts, so a tick on the old file's channels while a new
// one opens does not cancel the open.
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

async function open(label, readBuffer, credit) {
  const mine = ++opening
  const picked = imageSelect.value
  say(`Reading ${label}...`)
  try {
    const next = describeTiff(parseTiff(await readBuffer()))
    if (mine !== opening) return
    shownValue = picked
    source = next
    sourceCredit = credit
    sourceSummary = describeSource(source)
    shownChannels = []
    showChannels()
    await loadSelected()
  } catch (err) {
    if (mine !== opening) return
    restoreMenu()
    fail(`Could not read ${label} (a cross-origin host must send CORS)`, err)
  }
}

function describeSource(src) {
  const flavour = src.ome
    ? `OME-XML ${src.ome.pixelType}`
    : src.imagej
      ? 'ImageJ hyperstack'
      : 'plain TIFF'
  return (
    `${flavour}, ${src.tiff.ifds.length} planes` +
    `${src.tiff.isBigTiff ? ', BigTIFF' : ''}` +
    `${tiffIsTiled(src.tiff) ? ', tiled' : ''}`
  )
}

function selectedChannels() {
  return [...channelList.querySelectorAll('input[type=checkbox]:checked')].map(
    (box) => Number(box.value),
  )
}

function showChannels() {
  channelList.replaceChildren()
  for (let c = 0; c < tiffChannelCount(source); c++) {
    const label = document.createElement('label')
    const box = Object.assign(document.createElement('input'), {
      type: 'checkbox',
      value: String(c),
      checked: true,
    })
    box.onchange = loadSelected
    const swatch = document.createElement('span')
    swatch.className = 'swatch'
    swatch.dataset.channel = String(c)
    // The window maximum, in the file's units, once loaded.
    const max = Object.assign(document.createElement('input'), {
      type: 'number',
      disabled: true,
      title: 'Window maximum: lower is brighter',
    })
    max.dataset.channel = String(c)
    max.oninput = () => {
      const at = shownChannels.indexOf(c)
      const calMax = Number(max.value)
      if (at >= 0 && Number.isFinite(calMax) && calMax > nv1.volumes[at].calMin)
        nv1.setVolume(at, { calMax })
    }
    label.append(box, swatch, tiffChannelName(source, c), max)
    channelList.append(label)
  }
}

// Colours come from the file's OME Color, else the fallback palette.
const CHANNEL_RGB = new Map(
  [...CHANNEL_COLORMAPS, CHANNEL_GRAY_COLORMAP].map((c) => [c.name, c.rgb]),
)

/**
 * Window each channel over its robust range, not the global one: a
 * fluorescence channel is mostly background with a few bright structures, so
 * the full range leaves the signal a few counts above black.
 */
function showLoaded(channels) {
  for (const row of channelList.querySelectorAll('label')) {
    const swatch = row.querySelector('.swatch')
    const max = row.querySelector('input[type=number]')
    const at = channels.indexOf(Number(max.dataset.channel))
    const volume = nv1.volumes[at]
    max.disabled = !volume
    const rgb = CHANNEL_RGB.get(volume?.colormap)
    swatch.style.background = volume && rgb ? `rgb(${rgb.join(',')})` : ''
    if (!volume) continue
    const calMin = volume.robustMin ?? volume.globalMin
    const calMax = volume.robustMax ?? volume.globalMax
    nv1.setVolume(at, { calMin, calMax, opacity: 1 })
    max.value = String(Math.round(calMax * 100) / 100)
  }
}

async function loadSelected() {
  const mine = ++generation
  const channels = selectedChannels()
  const loading = source
  say(channels.length ? 'Decoding planes...' : 'No channel selected')
  try {
    const volumes = channels.length
      ? await omeTiffVolumesFrom(source, { channels })
      : []
    const swapped = await swapScene(mine, async () => {
      await nv1.loadVolumes(volumes)
      // A file opened meanwhile has its own rows: these channels are not theirs.
      shownChannels = loading === source ? channels : []
      showLoaded(shownChannels)
      return true
    })
    if (!swapped || mine !== generation || volumes.length === 0) return
    const vol = nv1.volumes[0]
    const voxels = vol.dimsRAS.slice(1, 4)
    // A single-plane file (one z, as most published 2D fields are) has nothing
    // to show in the other two planes, so give the whole canvas to the axial.
    nv1.sliceType = voxels[2] > 1 ? SLICE_TYPE.MULTIPLANAR : SLICE_TYPE.AXIAL
    const spacing = vol.pixDimsRAS
      .slice(1, 4)
      .map((v) => v.toFixed(3))
      .join(' x ')
    say(
      `Showing ${volumes.map((v) => v.name).join(', ')} - ` +
        `${voxels.join(' x ')} voxels, ${spacing} um (${sourceSummary})` +
        `${sourceCredit ? `. ${sourceCredit}` : ''}`,
    )
  } catch (err) {
    if (mine === generation) fail('Could not load the channels', err)
  }
}

await openUrl(SAMPLES[0].url)

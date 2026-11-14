import NiiVue, {
  CHANNEL_COLORMAPS,
  CHANNEL_GRAY_COLORMAP,
  OVERLAY_COLOR_BLEND,
  SLICE_TYPE,
} from '@niivue/niivue'
import {
  defaultOmeZarrLevel,
  fetchOmeZarr,
  omeZarrChannelName,
  omeZarrVolumesFrom,
} from '@niivue/nv-ext-tile/zarr'
import { segmentationColormap } from './segColormap'

// OME-Zarr is the fourth of the microscopy containers this package reads (see
// packages/nv-ext-tile/notes/ome-zarr-format.md). A store is a resolution pyramid over up to five
// named dimensions; this page opens one, offers its channels, levels and
// timepoints, and loads each selected channel as its own volume: named,
// coloured and windowed by the store's omero display block when it has one.
//
// Timepoints load on demand (`lazyTime`): the slider and Play switch every
// channel through `setFrame4D`, which fetches the frame (cached afterwards,
// and the next one prefetched). Play waits for each frame to show before
// scheduling the next, so a slow store plays slower instead of piling up
// requests. A segmentation store added beside the channels shares their time
// group, so it switches frames with them, coloured by its image-label table.
//
// The streaming demo (range.html) is the other OME-Zarr consumer: it reads
// bricks of very large stores on demand. This loader reads whole (budgeted)
// levels, which is the right shape for multi-channel fluorescence data.

const sampleSelect = document.getElementById('sample')
const levelSelect = document.getElementById('level')
const viewSelect = document.getElementById('view')
const timepointPair = document.getElementById('timepointPair')
const timepointInput = document.getElementById('timepoint')
const timepointValue = document.getElementById('timepointValue')
const playButton = document.getElementById('play')
const channelList = document.getElementById('channelList')
const blendSelect = document.getElementById('blend')
const statusLine = document.getElementById('status')
const segUrlInput = document.getElementById('segUrl')
const addSegButton = document.getElementById('addSeg')
const timestamp = document.getElementById('timestamp')

/**
 * Real stores written by other software, each exercising a different corner
 * of the format. Every host below sends CORS headers, which a browser needs
 * for a cross-origin fetch; many archives do not, so an arbitrary URL may
 * still be blocked.
 *
 * Nothing is vendored: the licences below cover redistribution, but a demo
 * that links is simpler to keep honest than one that copies.
 */
// IDR's stores re-chunked to one chunk per channel and timepoint (IDR keeps
// one z-plane per chunk: ~480 requests for the first image), mirrored on
// Hugging Face at a pinned commit; omezarr3d/README.md there has the details.
const IDR =
  'https://huggingface.co/datasets/neurodeskorg/webapps/resolve/26ac8f743a7654a60241945e0cfa968d08e6f7da/omezarr3d/'

const SAMPLES = [
  {
    label: 'IDR: 2-channel nuclei, 271 x 275 x 236 (67 MB)',
    url: `${IDR}idr0062A-6001240.ome.zarr`,
    credit: 'Image Data Resource idr0062 (Blin et al., CC BY 4.0)',
    note: 'NGFF 0.4, czyx uint16, omero labels/colours/windows: LaminB1 and Dapi.',
  },
  {
    label: 'IDR: 6 channels x 18 timepoints, 198 x 223 x 12 (115 MB full)',
    url: `${IDR}idr0101A-13457537.ome.zarr`,
    credit: 'Image Data Resource idr0101 (Chessel et al., CC BY 4.0)',
    note: 'NGFF 0.4, the full tczyx shape: the timepoint slider and Play fetch frames on demand.',
  },
  {
    label: 'IDR: 50-channel imaging mass cytometry, 464 x 494 (92 MB full)',
    url: `${IDR}idr0076A-10501752.ome.zarr`,
    credit: 'Image Data Resource idr0076 (Ali et al., CC BY 4.0)',
    note:
      'A 2D cyx float64 image: each channel loads as a single-slice volume, ' +
      'so pick a few of the fifty rather than all of them.',
  },
  {
    label: 'Human Organ Atlas: whole heart, 7 levels to 5787 x 5943 x 7865',
    url:
      'https://storage.googleapis.com/ucl-hip-ct-35a68e99feaae8932b1d44da0358940b/' +
      'UCL-ZCR-3341/heart/7.013um_overview_bm18.ome.zarr',
    credit: 'Human Organ Atlas HiP-CT heart (CC BY 4.0)',
    note:
      'The streaming demo store. Declares its axes x y z (the loader honours that order), ' +
      'and its finest levels are far past any budget, so the level picker ' +
      'matters here: the default stays under 256 MB.',
  },
]

// WebKit (Safari, and every iOS browser) runs WebGPU about 4x slower with
// anti-aliasing on (#381), so it is off there and on elsewhere (as slides.js).
const isWebKit =
  /AppleWebKit/.test(navigator.userAgent) &&
  !/Chrome|Chromium|Edg\//.test(navigator.userAgent) // iOS Edge (EdgiOS) is WebKit
// Optional `?backend=webgl2` (or webgpu) picks the initial backend; the
// checkbox mirrors it and can still switch at runtime.
const backend =
  new URLSearchParams(window.location.search).get('backend') === 'webgl2'
    ? 'webgl2'
    : 'webgpu'
webgpuCheck.checked = backend === 'webgpu'
webgpuCheck.onchange = async function () {
  await nv1.reinitializeView({ backend: this.checked ? 'webgpu' : 'webgl2' })
}

const nv1 = new NiiVue({
  backend,
  isAntiAlias: !isWebKit,
  backgroundColor: [0, 0, 0, 1],
  sliceType: SLICE_TYPE.MULTIPLANAR,
  isColorbarVisible: false,
})

// Every channel counts alike, on black, as fluorescence viewers show them;
// max keeps each pixel's brightest channel, additive sums them.
nv1.volumeIsChannelStack = true
function applyBlend() {
  nv1.volumeOverlayColorBlend =
    blendSelect.value === 'max'
      ? OVERLAY_COLOR_BLEND.MAX
      : OVERLAY_COLOR_BLEND.ADDITIVE
}
applyBlend()
blendSelect.onchange = applyBlend
document.getElementById('colorBtn').oninput = function () {
  const [r, g, b] = [1, 3, 5].map(
    (i) => parseInt(this.value.slice(i, i + 2), 16) / 255,
  )
  nv1.backgroundColor = [r, g, b, 1]
}
window.nv1 = nv1
// The status bar shows messages and the store's credit until a click on the
// image, then the voxel under the crosshair; the next message takes it back.
let isShowingLocation = false
gl1.addEventListener('pointerdown', () => {
  isShowingLocation = true
})
nv1.addEventListener('locationChange', (e) => {
  if (isShowingLocation) statusLine.textContent = e.detail.string
})
nv1.addEventListener('frameChange', () => showTimestamp())

const TIME_SECONDS = { second: 1, millisecond: 1e-3, minute: 60, hour: 3600 }
/** The shown timepoint over the canvas, in seconds when the t axis has a unit. */
function showTimestamp() {
  const vol = nv1.volumes[0]
  const count = vol?.frameSource?.count ?? 1
  timestamp.hidden = !shownSource || count <= 1
  if (timestamp.hidden) return
  const t = nv1.getFrame4D(vol.id)
  const axis = shownSource.indices.time
  const unit = TIME_SECONDS[shownSource.axes[axis]?.unit]
  const scale = shownSource.info.datasets[0]?.scale?.[axis]
  const seconds = unit && scale ? ` (${(t * scale * unit).toFixed(1)} s)` : ''
  timestamp.textContent = `t ${t} / ${count - 1}${seconds}`
}
await nv1.attachToCanvas(gl1)

// textContent (not innerHTML): messages include data-derived channel names.
function say(message) {
  isShowingLocation = false
  statusLine.textContent = message
}

function fail(message, err) {
  say(`${message}: ${err?.message ?? err}`)
  console.error(message, err)
}

/** The opened store currently on offer. */
let source = null
// The store whose volumes are on screen: the slider drives them only while it
// is also the store offered (opening another store resets the slider for it).
let shownSource = null

/** How many channels start ticked: plenty to see, not fifty volumes. */
const DEFAULT_CHECKED = 4

function megabytes(bytes) {
  return bytes < 2 ** 20
    ? `${Math.max(1, Math.round(bytes / 1024))} kB`
    : `${Math.round(bytes / 2 ** 20)} MB`
}

/** Describe an opened store and offer its channels, levels and timepoints. */
function offer(next, label) {
  stopPlayback()
  source = next
  shownChannels = []
  channelList.replaceChildren()
  for (let c = 0; c < source.channelCount; c++) {
    const label = document.createElement('label')
    const box = Object.assign(document.createElement('input'), {
      type: 'checkbox',
      value: String(c),
      checked: c < DEFAULT_CHECKED,
    })
    box.onchange = scheduleLoad
    const swatch = document.createElement('span')
    swatch.className = 'swatch'
    // The window maximum, in the store's units, once loaded.
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
    label.append(box, swatch, omeZarrChannelName(source, c), max)
    channelList.append(label)
  }

  const preferred = defaultOmeZarrLevel(source)
  levelSelect.replaceChildren()
  for (const [index, level] of source.levels.entries()) {
    const option = document.createElement('option')
    option.value = String(index)
    option.textContent =
      `L${index}: ${level.dims.join(' x ')} (${megabytes(level.channelBytes)}/channel)` +
      (index === preferred ? ' *' : '')
    levelSelect.append(option)
  }
  levelSelect.value = String(preferred)
  levelSelect.disabled = false
  levelSelect.onchange = scheduleLoad

  timepointPair.hidden = source.timepointCount <= 1
  timepointInput.max = String(source.timepointCount - 1)
  // Start at the writer's chosen timepoint (omero rdefs) when it has one.
  const defaultT = source.info.defaults.t
  timepointInput.value = String(
    defaultT !== null && defaultT < source.timepointCount ? defaultT : 0,
  )
  timepointValue.textContent = timepointInput.value

  const axes = source.axes.map((a) => a.name).join(' ')
  say(
    `${label}: NGFF ${source.info.version ?? '?'}, axes ${axes}, ` +
      `${source.channelCount} channel(s), ${source.timepointCount} timepoint(s), ` +
      `${source.levels.length} level(s), ${source.levels[0].dtype}`,
  )
}

// The store menu: the samples, then a custom URL (a text-entry dialog). A
// custom pick is listed as itself, so the menu always names what is shown.
const customOption = new Option()
const customUrlOption = new Option('Custom URL...', 'custom-url')
for (const sample of SAMPLES) {
  const option = new Option(sample.label, sample.url)
  option.title = sample.note
  sampleSelect.append(option)
}
sampleSelect.append(customUrlOption)
let shownUrl = SAMPLES[0].url

// A failed open puts the menu back on what is still shown, custom entry included.
let previousCustom = { value: '', text: '' }
function restoreMenu() {
  if (customOption.value !== shownUrl) {
    Object.assign(customOption, previousCustom)
    if (!previousCustom.value) customOption.remove()
  }
  sampleSelect.value = shownUrl
}

sampleSelect.onchange = async () => {
  let url = sampleSelect.value
  if (url === 'custom-url') {
    sampleSelect.value = shownUrl
    url = window.prompt('OME-Zarr store URL (the host must send CORS)')?.trim()
    if (!url) return
    previousCustom = { value: customOption.value, text: customOption.text }
    customOption.value = url
    customOption.text = `${url.split('/').filter(Boolean).pop() || url} (custom)`
    customUrlOption.before(customOption)
    sampleSelect.value = url
  }
  await openAndLoad(url)
}

// Only load on success: otherwise the stale store would reload and its
// status line would paper over the fetch error the user needs to read.
async function openAndLoad(url) {
  if (await openStore(url)) await loadChannels()
}

/** The credit of the shown store, ending the status line once it loads. */
function creditFor(url) {
  const credit = SAMPLES.find((s) => s.url === url)?.credit
  return credit ? `. ${credit}` : ''
}

// Opens can overlap (a slow store, then another pick); only the latest lands.
let opening = 0
async function openStore(url) {
  const mine = ++opening
  say(`Opening ${url}...`)
  try {
    const name = url.split('/').filter(Boolean).pop() || url
    const next = await fetchOmeZarr(url)
    if (mine !== opening) return false
    shownUrl = url
    offer(next, name)
    return true
  } catch (err) {
    if (mine !== opening) return false
    restoreMenu()
    fail('Could not open that store (a cross-origin host must send CORS)', err)
    return false
  }
}

function selectedChannels() {
  return [...channelList.querySelectorAll('input[type=checkbox]:checked')].map(
    (b) => Number(b.value),
  )
}

// Colours come from the omero colours, else the fallback palette.
const CHANNEL_RGB = new Map(
  [...CHANNEL_COLORMAPS, CHANNEL_GRAY_COLORMAP].map((c) => [c.name, c.rgb]),
)

/**
 * Window each channel and fill in its swatch and max. A channel with an omero
 * window keeps it (the loader set calMin/calMax); one without gets the robust
 * range, since a fluorescence channel is mostly background and the global
 * range would leave the signal a few counts above black.
 */
function applyDisplay(loaded, channels) {
  const calMaxes = nv1.volumes.map((volume, index) => {
    if (loaded?.[index]?.calMin !== undefined) return volume.calMax
    const calMax = volume.robustMax ?? volume.globalMax
    nv1.setVolume(index, {
      calMin: volume.robustMin ?? volume.globalMin,
      calMax,
    })
    return calMax
  })
  for (const row of channelList.querySelectorAll('label')) {
    const max = row.querySelector('input[type=number]')
    const at = channels.indexOf(Number(max.dataset.channel))
    const volume = nv1.volumes[at]
    max.disabled = !volume
    const rgb = CHANNEL_RGB.get(volume?.colormap)
    row.querySelector('.swatch').style.background =
      volume && rgb ? `rgb(${rgb.join(',')})` : ''
    if (volume) max.value = String(Math.round(calMaxes[at] * 100) / 100)
  }
}

/**
 * Put the crosshair on the writer's chosen plane (omero `rdefs.defaultZ`,
 * a full-resolution z index) scaled to the loaded level, centred in x and y.
 */
function showDefaultPlane(level) {
  const defaultZ = source.info.defaults.z
  const full = source.levels[0].dims
  const dims = source.levels[level].dims
  if (defaultZ === null || defaultZ >= full[2] || dims[2] <= 1) {
    return
  }
  const z = Math.min(dims[2] - 1, Math.floor((defaultZ * dims[2]) / full[2]))
  nv1.crosshairPos = nv1.vox2frac([
    Math.floor(dims[0] / 2),
    Math.floor(dims[1] / 2),
    z,
  ])
}

viewSelect.onchange = () => {
  nv1.sliceType = Number(viewSelect.value)
}

// The time group of the volumes on screen: a segmentation joins it.
let timeGroup = {}
// Bumped whenever the channels on screen are replaced, so a segmentation
// still opening for the old ones is dropped instead of attached.
let scene = 0
let segAdds = 0

// A ticked channel or a new level loads after a short pause, so several
// quick ticks make one load.
let loadTimer = 0
function scheduleLoad() {
  clearTimeout(loadTimer)
  loadTimer = setTimeout(loadChannels, 500)
}

// Loads can overlap (a slow store, quick ticks); only the latest is shown.
let loadGeneration = 0
// The channels on screen, in volume order: what the window inputs address.
let shownChannels = []
// Scene swaps run one at a time, each skipped once a newer request exists:
// loadVolumes prepares before it swaps, so a check after it is too late.
let swaps = Promise.resolve()
function swapScene(isCurrent, step) {
  const done = swaps.then(() => (isCurrent() ? step() : false))
  swaps = done.catch(() => {})
  return done
}
async function loadChannels() {
  clearTimeout(loadTimer)
  if (!source) {
    return
  }
  const mine = ++loadGeneration
  const channels = selectedChannels()
  stopPlayback()
  const level = Number(levelSelect.value)
  const timepoint = Number(timepointInput.value) || 0
  say(
    channels.length
      ? `Reading ${channels.length} channel(s) at level ${level}...`
      : 'Select at least one channel',
  )
  // Another store may be opened while this one loads: its result is then stale.
  const loading = source
  try {
    const group = {}
    // No channel ticked swaps in an empty scene, so the unticked image goes.
    const volumes = channels.length
      ? await omeZarrVolumesFrom(loading, {
          channels,
          level,
          timepoint,
          lazyTime: group,
        })
      : []
    const isCurrent = () => source === loading && mine === loadGeneration
    const swapped = await swapScene(isCurrent, async () => {
      shownSource = null
      scene += 1
      await nv1.loadVolumes(volumes)
      shownSource = loading
      // A store opened meanwhile has its own rows: these channels are not theirs.
      shownChannels = source === loading ? channels : []
      timeGroup = group
      addSegButton.disabled = false
      showTimestamp()
      applyDisplay(volumes, shownChannels)
      return true
    })
    if (!swapped || !isCurrent() || volumes.length === 0) return
    const vol = nv1.volumes[0]
    const voxels = vol.dimsRAS.slice(1, 4)
    // A single-slice image (a 2D store) has nothing to show in the other two
    // planes, so give the whole canvas to the axial; a 3D store follows the
    // View selector (the selector reflects the override so it never lies).
    const view = voxels[2] > 1 ? Number(viewSelect.value) : SLICE_TYPE.AXIAL
    nv1.sliceType = view
    viewSelect.value = String(view)
    showDefaultPlane(level)
    say(
      `Showing ${volumes.map((v) => v.name).join(', ')} - ` +
        `${voxels.join(' x ')} voxels, ` +
        `${vol.pixDimsRAS
          .slice(1, 4)
          .map((v) => v.toFixed(3))
          .join(' x ')} um${creditFor(shownUrl)}`,
    )
  } catch (err) {
    if (mine === loadGeneration) fail('Could not load the channels', err)
  }
}
// The e2e test reloads the channels through this.
window.loadChannels = loadChannels

/**
 * Add a segmentation store over the shown channels: the level whose grid
 * matches theirs, at the shown timepoint, in their time group, coloured by
 * its image-label colours when it states them. Playback pauses; if the
 * channels are replaced while it opens it is dropped, and if their frame
 * moves it is read again at the new frame, so it attaches in step.
 */
addSegButton.onclick = async () => {
  const url = segUrlInput.value.trim()
  const raw = nv1.volumes[0]
  if (!url || !raw) return
  addSegButton.disabled = true
  stopPlayback()
  const token = scene
  const group = timeGroup
  // This addition's own id: what the cleanup below acts on, never a guess.
  const segId = `segmentation-${token}-${++segAdds}`
  const superseded = () => scene !== token || !nv1.volumes.includes(raw)
  say(`Opening segmentation ${url}...`)
  try {
    const seg = await fetchOmeZarr(url)
    const dims = raw.dimsRAS.slice(1, 4)
    const match = seg.levels.findIndex((l) =>
      l.dims.every((d, i) => d === dims[i]),
    )
    const colors = segmentationColormap(seg.info, segId)
    if (colors) nv1.addColormap(colors.name, colors.map)
    // Read and prepare (the NIfTI parse on the volume worker) before the
    // checks, so nothing awaits between the last check and the attach.
    let shown
    let volume
    let prepared
    do {
      shown = nv1.getFrame4D(raw.id)
      ;[volume] = await omeZarrVolumesFrom(seg, {
        channels: [0],
        level: match >= 0 ? match : defaultOmeZarrLevel(seg),
        timepoint: Math.min(shown, seg.timepointCount - 1),
        lazyTime: group,
        labels: true,
      })
      prepared = await nv1.prepareVolume({
        ...volume,
        id: segId,
        ...(colors ? { colormap: colors.name } : {}),
        opacity: 0.5,
      })
      if (superseded()) {
        say(`Dropped segmentation ${volume.name}: the channels changed`)
        return
      }
    } while (nv1.getFrame4D(raw.id) !== shown)
    await nv1.addVolume(prepared)
    // addVolume still awaits (its GPU update): undo or catch up, acting only
    // on this segmentation (addVolume adds a copy of `prepared`, under its
    // id) and only while it is still shown; a replacement may have dropped it.
    const shownSeg = () => nv1.volumes.find((v) => v.id === segId)
    if (superseded()) {
      const stale = shownSeg()
      if (stale) await nv1.removeVolume(nv1.volumes.indexOf(stale))
      say(`Dropped segmentation ${volume.name}: the channels changed`)
      return
    }
    const added = shownSeg()
    if (added && nv1.getFrame4D(added.id) !== nv1.getFrame4D(raw.id))
      await nv1.setFrame4D(added.id, nv1.getFrame4D(raw.id))
    say(
      `Added segmentation ${volume.name}` +
        (match >= 0 ? '' : ' (no level matches the channels grid)'),
    )
  } catch (err) {
    fail('Could not add that segmentation', err)
  } finally {
    addSegButton.disabled = false
  }
}

/**
 * Show timepoint `t` on every channel. Resolves once it is drawn, or at once
 * when a newer request replaced it.
 */
async function showTimepoint(t) {
  const vol = nv1.volumes[0]
  if (shownSource === source && vol?.frameSource) {
    await nv1.setFrame4D(vol.id, t)
  }
}

// Before a load the slider picks the timepoint to load; after, it switches.
// A newer request supersedes an older one still loading, so scrubbing is safe.
timepointInput.oninput = () => {
  timepointValue.textContent = timepointInput.value
  showTimepoint(Number(timepointInput.value)).catch((err) => {
    const vol = nv1.volumes[0]
    timepointInput.value = String(vol ? nv1.getFrame4D(vol.id) : 0)
    timepointValue.textContent = timepointInput.value
    fail('Could not load that timepoint', err)
  })
}

/** Minimum time a frame stays on screen during playback. */
const FRAME_MS = 250
let playback = 0

function stopPlayback() {
  playback += 1
  playButton.textContent = 'Play'
}

playButton.onclick = async () => {
  if (playButton.textContent !== 'Play') {
    stopPlayback()
    return
  }
  const run = ++playback
  playButton.textContent = 'Pause'
  while (run === playback) {
    const vol = nv1.volumes[0]
    if (shownSource !== source || !vol?.frameSource) {
      break
    }
    const started = performance.now()
    try {
      await showTimepoint((nv1.getFrame4D(vol.id) + 1) % vol.frameSource.count)
    } catch (err) {
      fail('Playback stopped: a timepoint did not load', err)
      break
    }
    timepointInput.value = String(nv1.getFrame4D(vol.id))
    timepointValue.textContent = timepointInput.value
    const rest = FRAME_MS - (performance.now() - started)
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, rest)))
  }
  if (run === playback) {
    stopPlayback()
  }
}

// Start with something on screen: open the default store and load it.
await openAndLoad(SAMPLES[0].url)

import NiiVue, {
  defaultOmeZarrLevel,
  fetchOmeZarr,
  omeZarrChannelName,
  omeZarrVolumesFrom,
  SLICE_TYPE,
} from '../src/index.ts'

// OME-Zarr is the fourth of the microscopy containers this package reads (see
// docs/ome-zarr-format.md). A store is a resolution pyramid over up to five
// named dimensions; this page opens one, offers its channels, levels and
// timepoints, and loads each selected channel as its own volume: named,
// coloured and windowed by the store's omero display block when it has one.
//
// The streaming demo (range.html) is the other OME-Zarr consumer: it reads
// bricks of very large stores on demand. This loader reads whole (budgeted)
// levels, which is the right shape for multi-channel fluorescence data.

const sampleSelect = document.getElementById('sample')
const urlInput = document.getElementById('url')
const fetchButton = document.getElementById('fetchUrl')
const levelSelect = document.getElementById('level')
const viewSelect = document.getElementById('view')
const timepointPair = document.getElementById('timepointPair')
const timepointInput = document.getElementById('timepoint')
const creditLine = document.getElementById('credit')
const channelsBox = document.getElementById('channels')
const loadButton = document.getElementById('load')
const opacityInput = document.getElementById('opacity')
const statusLine = document.getElementById('status')
// id="location" shadows window.location, so this one element is looked up.
const footer = document.getElementById('location')

/**
 * Real stores written by other software, each exercising a different corner
 * of the format. Every host below sends CORS headers, which a browser needs
 * for a cross-origin fetch; many archives do not, so an arbitrary URL may
 * still be blocked.
 *
 * Nothing is vendored: the licences below cover redistribution, but a demo
 * that links is simpler to keep honest than one that copies.
 */
const SAMPLES = [
  {
    label: 'IDR: 2-channel nuclei, 271 x 275 x 236 (67 MB)',
    url: 'https://uk1s3.embassy.ebi.ac.uk/idr/zarr/v0.4/idr0062A/6001240.zarr',
    credit:
      'Image Data Resource idr0062 (Blin et al., CC BY 4.0). NGFF 0.4, czyx ' +
      'uint16, omero labels/colours/windows: LaminB1 and Dapi.',
  },
  {
    label: 'IDR: 6 channels x 18 timepoints, 198 x 223 x 12 (115 MB full)',
    url: 'https://uk1s3.embassy.ebi.ac.uk/idr/zarr/v0.4/idr0101A/13457537.zarr',
    credit:
      'Image Data Resource idr0101 (Chessel et al., CC BY 4.0). NGFF 0.4, the ' +
      'full tczyx shape: pick a timepoint before loading.',
  },
  {
    label: 'IDR: 50-channel imaging mass cytometry, 464 x 494 (92 MB full)',
    url: 'https://uk1s3.embassy.ebi.ac.uk/idr/zarr/v0.4/idr0076A/10501752.zarr',
    credit:
      'Image Data Resource idr0076 (Ali et al., CC BY 4.0). A 2D cyx float64 ' +
      'image: each channel loads as a single-slice volume, so pick a few of ' +
      'the fifty rather than all of them.',
  },
  {
    label: 'Human Organ Atlas: whole heart, 7 levels to 5787 x 5943 x 7865',
    url:
      'https://storage.googleapis.com/ucl-hip-ct-35a68e99feaae8932b1d44da0358940b/' +
      'UCL-ZCR-3341/heart/7.013um_overview_bm18.ome.zarr',
    credit:
      'Human Organ Atlas HiP-CT heart (CC BY 4.0), the streaming demo store. ' +
      'Declares its axes x y z (the loader honours that order), ' +
      'and its finest levels are far past any budget, so the level picker ' +
      'matters here: the default stays under 256 MB.',
  },
]

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
  backgroundColor: [0, 0, 0, 1],
  sliceType: SLICE_TYPE.MULTIPLANAR,
  isColorbarVisible: false,
})
window.nv1 = nv1
nv1.addEventListener('locationChange', (e) => {
  footer.textContent = e.detail.string
})
await nv1.attachToCanvas(gl1)

// textContent (not innerHTML): messages include data-derived channel names.
function say(message) {
  statusLine.textContent = message
}

function fail(message, err) {
  say(`${message}: ${err?.message ?? err}`)
  console.error(message, err)
}

/** The opened store currently on offer. */
let source = null

/** How many channels start ticked: plenty to see, not fifty volumes. */
const DEFAULT_CHECKED = 4

function megabytes(bytes) {
  return bytes < 2 ** 20
    ? `${Math.max(1, Math.round(bytes / 1024))} kB`
    : `${Math.round(bytes / 2 ** 20)} MB`
}

/** Describe an opened store and offer its channels, levels and timepoints. */
function offer(next, label) {
  source = next
  channelsBox.replaceChildren()
  for (let c = 0; c < source.channelCount; c++) {
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.value = String(c)
    box.checked = c < DEFAULT_CHECKED
    box.id = `channel-${c}`
    const text = document.createElement('label')
    text.htmlFor = box.id
    text.textContent = omeZarrChannelName(source, c)
    const wrap = document.createElement('span')
    wrap.className = 'pair'
    wrap.append(box, text)
    channelsBox.append(wrap)
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

  timepointPair.hidden = source.timepointCount <= 1
  timepointInput.max = String(source.timepointCount - 1)
  timepointInput.value = '0'

  loadButton.disabled = false
  const axes = source.axes.map((a) => a.name).join(' ')
  say(
    `${label}: NGFF ${source.info.version ?? '?'}, axes ${axes}, ` +
      `${source.channelCount} channel(s), ${source.timepointCount} timepoint(s), ` +
      `${source.levels.length} level(s), ${source.levels[0].dtype}`,
  )
}

for (const sample of SAMPLES) {
  const option = document.createElement('option')
  option.value = sample.url
  option.textContent = sample.label
  sampleSelect.append(option)
}

sampleSelect.onchange = async () => {
  const sample = SAMPLES.find((s) => s.url === sampleSelect.value)
  creditLine.textContent = sample?.credit ?? ''
  urlInput.value = sample?.url ?? ''
  // Only load on success: otherwise the stale store would reload and its
  // status line would paper over the fetch error the user needs to read.
  if (await fetchButton.onclick()) {
    await loadButton.onclick()
  }
}

fetchButton.onclick = async () => {
  const url = urlInput.value.trim()
  if (!url) {
    return false
  }
  say(`Opening ${url}...`)
  loadButton.disabled = true
  levelSelect.disabled = true
  try {
    const name = url.split('/').filter(Boolean).pop() || url
    offer(await fetchOmeZarr(url), name)
    return true
  } catch (err) {
    fail('Could not open that store (a cross-origin host must send CORS)', err)
    return false
  }
}

function selectedChannels() {
  return [...channelsBox.querySelectorAll('input:checked')].map((b) =>
    Number(b.value),
  )
}

/**
 * Show every channel at once: the first opaque, the rest translucent on top.
 *
 * A channel with an omero window keeps it (the loader set calMin/calMax); one
 * without gets the robust range, since a fluorescence channel is mostly
 * background and the global range would leave the signal a few counts above
 * black.
 */
function applyDisplay(loaded) {
  const overlayOpacity = Number(opacityInput.value)
  nv1.volumes.forEach((volume, index) => {
    const hasWindow = loaded?.[index]?.calMin !== undefined
    nv1.setVolume(index, {
      ...(hasWindow
        ? {}
        : {
            calMin: volume.robustMin ?? volume.globalMin,
            calMax: volume.robustMax ?? volume.globalMax,
          }),
      opacity: index === 0 ? 1 : overlayOpacity,
    })
  })
}

opacityInput.oninput = () => {
  if (nv1.volumes.length > 0) {
    applyDisplay(lastLoaded)
  }
}

viewSelect.onchange = () => {
  nv1.sliceType = Number(viewSelect.value)
}

/** The load options of the volumes on screen, for re-applying opacity. */
let lastLoaded = null

loadButton.onclick = async () => {
  if (!source) {
    return
  }
  const channels = selectedChannels()
  if (channels.length === 0) {
    say('Select at least one channel')
    return
  }
  loadButton.disabled = true
  const level = Number(levelSelect.value)
  const timepoint = Number(timepointInput.value) || 0
  say(`Reading ${channels.length} channel(s) at level ${level}...`)
  try {
    const volumes = await omeZarrVolumesFrom(source, {
      channels,
      level,
      timepoint,
    })
    await nv1.loadVolumes(volumes)
    lastLoaded = volumes
    applyDisplay(volumes)
    const vol = nv1.volumes[0]
    const voxels = vol.dimsRAS.slice(1, 4)
    // A single-slice image (a 2D store) has nothing to show in the other two
    // planes, so give the whole canvas to the axial; a 3D store follows the
    // View selector (the selector reflects the override so it never lies).
    const view = voxels[2] > 1 ? Number(viewSelect.value) : SLICE_TYPE.AXIAL
    nv1.sliceType = view
    viewSelect.value = String(view)
    say(
      `Showing ${volumes.map((v) => v.name).join(', ')} - ` +
        `${voxels.join(' x ')} voxels, ` +
        `${vol.pixDimsRAS
          .slice(1, 4)
          .map((v) => v.toFixed(3))
          .join(' x ')} um`,
    )
  } catch (err) {
    fail('Could not load the channels', err)
  } finally {
    loadButton.disabled = false
  }
}

// Start with something on screen: open the default store and load it.
creditLine.textContent = SAMPLES[0].credit
urlInput.value = SAMPLES[0].url
if (await fetchButton.onclick()) {
  await loadButton.onclick()
}

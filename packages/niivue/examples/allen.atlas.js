import NiiVue, {
  allenAtlasSpacing,
  fetchAllenAtlasInfo,
  loadAllenAtlasVolumes,
  SLICE_TYPE,
} from '../src/index.ts'

// Allen "volume-viewer" datasets ship one JSON sidecar plus N PNG atlases, each
// packing three independent channels into its R/G/B planes. See
// docs/allen-atlas-format.md.
//
// The default URL is the live Integrated Mitotic Stem Cell dataset. That host
// sends no Access-Control-Allow-Origin header, so a browser will refuse the
// fetch from this page — download the sidecar and its PNGs and use the file
// picker instead, or point the URL at a CORS-enabled copy.

const urlInput = document.getElementById('url')
const filesInput = document.getElementById('files')
const describeButton = document.getElementById('describe')
const loadButton = document.getElementById('load')
const channelsBox = document.getElementById('channels')
const opacityInput = document.getElementById('opacity')
const statusLine = document.getElementById('status')
// id="location" shadows window.location, so this one element is looked up.
const footer = document.getElementById('location')

const backend = webgpuCheck.checked ? 'webgpu' : 'webgl2'
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

/**
 * Source of the currently described dataset: either a URL, or a set of local
 * files served out of a Map by a stand-in fetch. `loadAllenAtlasVolumes`
 * resolves the sidecar's image names against the sidecar URL, so local files
 * only need a base that the Map can key on.
 */
let source = null

function urlSource(url) {
  return { sidecarUrl: url, options: {} }
}

function fileSource(files) {
  const byName = new Map()
  for (const file of files) {
    byName.set(file.name, file)
  }
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

function showChannels(info) {
  channelsBox.replaceChildren()
  info.channelNames.forEach((name, index) => {
    const label = document.createElement('label')
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.value = String(index)
    // Loading 32 volumes at once is slow and unreadable; start with a few.
    box.checked = index < 2
    label.append(box, ` ${name}`)
    channelsBox.append(label)
  })
  loadButton.disabled = false
}

/**
 * Window each channel over its own full range and fade the overlays.
 *
 * These channels sit on a large per-channel background offset (the IMSC data
 * floors at 126/82/72 rather than 0), and the whole cell body is above that
 * floor in every channel, so the robust auto-window saturates and each new
 * channel paints over the one below it. Windowing floor-to-peak keeps the
 * structure visible, and the opacity is what lets stacked channels show
 * through: NiiVue alpha-composites overlays rather than accumulating them the
 * way a dedicated multi-channel microscopy viewer would.
 */
function applyDisplay() {
  const overlayOpacity = Number(opacityInput.value)
  nv1.volumes.forEach((volume, index) => {
    nv1.setVolume(index, {
      calMin: volume.globalMin,
      calMax: volume.globalMax,
      opacity: index === 0 ? 1 : overlayOpacity,
    })
  })
}

opacityInput.oninput = () => {
  if (nv1.volumes.length > 0) {
    applyDisplay()
  }
}

function selectedChannels() {
  return [...channelsBox.querySelectorAll('input:checked')].map((b) =>
    Number(b.value),
  )
}

async function describe(next) {
  loadButton.disabled = true
  channelsBox.replaceChildren()
  try {
    source = next
    const info = await fetchAllenAtlasInfo(source.sidecarUrl, source.options)
    showChannels(info)
    // The atlas may store a downsampled slice, so report the spacing of what is
    // actually stored rather than the sidecar's original-resolution pixel size.
    const spacing = allenAtlasSpacing(info)
      .map((s) => s.toFixed(2))
      .join(' x ')
    say(
      `${info.channels} channels, ${info.tileWidth}x${info.tileHeight}x${info.tiles} voxels, ` +
        `${spacing} ${info.spacingUnit}, ${info.images.length} atlas images`,
    )
  } catch (err) {
    source = null
    fail('Could not read the sidecar', err)
  }
}

describeButton.onclick = () => describe(urlSource(urlInput.value.trim()))

filesInput.onchange = async () => {
  const files = [...filesInput.files]
  if (files.length === 0) {
    return
  }
  try {
    await describe(fileSource(files))
  } catch (err) {
    fail('Could not use those files', err)
  }
}

loadButton.onclick = async () => {
  const channels = selectedChannels()
  if (!source || channels.length === 0) {
    say('Select at least one channel')
    return
  }
  loadButton.disabled = true
  say(`Loading ${channels.length} channels...`)
  try {
    const volumes = await loadAllenAtlasVolumes(source.sidecarUrl, {
      ...source.options,
      channels,
    })
    await nv1.loadVolumes(volumes)
    applyDisplay()
    say(`Showing ${volumes.map((v) => v.name).join(', ')}`)
  } catch (err) {
    fail('Could not load the channels', err)
  } finally {
    loadButton.disabled = false
  }
}

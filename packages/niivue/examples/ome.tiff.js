import NiiVue, {
  describeTiff,
  omeTiffVolumesFrom,
  parseTiff,
  SHOW_RENDER,
  SLICE_TYPE,
  tiffChannelCount,
  tiffChannelName,
  tiffIsTiled,
} from '../src/index.ts'
import {
  imageJDescription,
  omeXml,
  phantomChannels,
  writeTiff,
} from './ome.tiff.write.js'

// OME-TIFF is the third of the microscopy containers this package reads (see
// docs/ome-tiff-format.md). A .tif holds a flat stack of image planes and
// nothing else; the metadata block in the first directory is what says how
// those planes fold into z, channel and time.
//
// This page synthesizes its own files so the decoders can be exercised without
// shipping a large binary: pick a metadata flavour and a compressor, generate,
// and load. Real files work the same way through the picker or the URL box.

const sourceSelect = document.getElementById('source')
const compressionSelect = document.getElementById('compression')
const generateButton = document.getElementById('generate')
const downloadLink = document.getElementById('download')
const urlInput = document.getElementById('url')
const fetchButton = document.getElementById('fetchUrl')
const sampleSelect = document.getElementById('sample')
const creditLine = document.getElementById('credit')
const fileInput = document.getElementById('file')
const loadButton = document.getElementById('load')
const channelsBox = document.getElementById('channels')
const opacityInput = document.getElementById('opacity')
const clipCheck = document.getElementById('clipCheck')
const clipOverlaysCheck = document.getElementById('clipOverlaysCheck')
const zoomInput = document.getElementById('zoom')
const statusLine = document.getElementById('status')
// id="location" shadows window.location, so this one element is looked up.
const footer = document.getElementById('location')

const SIZE = { sizeX: 192, sizeY: 160, sizeZ: 64 }
// Deliberately anisotropic: a wrong z-spacing shows up immediately as a
// squashed or stretched sagittal view.
const SPACING = [0.25, 0.25, 0.9]

/**
 * Real OME-TIFFs written by other software, so the reader is exercised against
 * files this repository did not produce. Every host below sends CORS headers,
 * which a browser needs for a cross-origin fetch; most microscopy archives do
 * not, so an arbitrary URL may still be blocked (the file picker always works).
 *
 * Nothing is vendored: the licences below cover redistribution, but a demo that
 * links is simpler to keep honest than one that copies.
 */
const SAMPLES = [
  {
    label: 'Synthetic phantom (generated here)',
    url: '',
    credit: '',
  },
  {
    label: 'tifffile, 6 x 6, 2 channels (1 kB)',
    url: 'https://cdn.jsdelivr.net/gh/tlambert03/ome-types@main/tests/data/ome.tiff',
    credit:
      'Written by tifffile 2020.9.3; test fixture from ome-types (BSD-3-Clause). ' +
      'Six pixels square, so it proves the container parses rather than showing anything.',
  },
  {
    label: 'Spheroid, Hoechst channel, 1024 x 1024 (2.2 MB)',
    url: 'https://ftp.ebi.ac.uk/biostudies/fire/S-BIAD/254/S-BIAD2254/Files/spher-colo52/PB000142_spher-colo52_HT29_L1/Well-B04-z0-HOECHST.ome.tiff',
    credit:
      'Cell Painting in 3D spheroids, BioImage Archive S-BIAD2254 (CC BY 4.0). ' +
      'Bio-Formats output: big-endian, 16-bit, micrometre units and a channel colour.',
  },
  {
    label: 'hiPSC cell, 3 channels, 238 x 284 x 70 (14 MB)',
    url: 'https://allencell.s3.amazonaws.com/aics/variance_project_dataset/crop_raw/012b784e_raw.ome.tif',
    credit:
      'Allen Institute for Cell Science, variance project dataset (single-cell crop). ' +
      'Allen Institute Terms of Use: research and other non-commercial use, with citation. ' +
      'BigTIFF, 16-bit, 210 planes folding into three channels of a 70-slice stack. ' +
      'It names no channel colours and states no voxel size, so the colours below are ' +
      'the fallback palette and the voxels are 1 um.',
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
  // The clip and zoom controls act on the 3D render, so keep its tile in the
  // multiplanar layout instead of the slices-only AUTO default.
  showRender: SHOW_RENDER.ALWAYS,
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

/** The parsed TIFF currently on offer, whatever produced it. */
let source = null

/**
 * Build one of the three shapes a TIFF stack comes in.
 *
 * All three carry identical pixels, so switching between them isolates the
 * metadata path: OME-XML, an ImageJ hyperstack block, or nothing at all.
 */
async function generate(kind, compression) {
  const channels = phantomChannels(SIZE)
  const used = kind === 'plain' ? 1 : kind === 'imagej' ? 2 : 3

  // Both OME (DimensionOrder XYCZT) and ImageJ hyperstacks vary channel
  // fastest, so one interleaving serves every flavour here.
  const planes = []
  for (let z = 0; z < SIZE.sizeZ; z++) {
    for (let c = 0; c < used; c++) {
      planes.push(channels[c].planes[z])
    }
  }

  let description = ''
  if (kind === 'ome') {
    description = omeXml({
      name: 'NiiVue synthetic phantom',
      sizeX: SIZE.sizeX,
      sizeY: SIZE.sizeY,
      sizeZ: SIZE.sizeZ,
      sizeC: used,
      spacing: SPACING,
      channels: channels.slice(0, used),
    })
  } else if (kind === 'imagej') {
    description = imageJDescription({
      sizeZ: SIZE.sizeZ,
      sizeC: used,
      spacingZ: SPACING[2],
    })
  }

  const bytes = await writeTiff({
    width: SIZE.sizeX,
    height: SIZE.sizeY,
    planes,
    description,
    compression,
  })
  const name = kind === 'ome' ? 'phantom.ome.tif' : `phantom.${kind}.tif`
  return { bytes, name }
}

/** Describe a parsed file and offer its channels. */
function offer(next, label) {
  source = next
  channelsBox.replaceChildren()
  const total = tiffChannelCount(source)
  for (let c = 0; c < total; c++) {
    const box = document.createElement('input')
    box.type = 'checkbox'
    box.value = String(c)
    box.checked = true
    box.id = `channel-${c}`
    const text = document.createElement('label')
    text.htmlFor = box.id
    text.textContent = tiffChannelName(source, c)
    const wrap = document.createElement('span')
    wrap.append(box, text)
    channelsBox.append(wrap)
  }
  loadButton.disabled = total === 0

  const ome = source.ome
  const imagej = source.imagej
  const flavour = ome
    ? `OME-XML (${ome.dimensionOrder}, ${ome.pixelType})`
    : imagej
      ? 'ImageJ hyperstack'
      : 'plain TIFF, no metadata'
  const spacing = ome
    ? ome.spacingUm.map((v) => v || 1).join(' x ')
    : imagej?.spacingUm
      ? `1 x 1 x ${imagej.spacingUm}`
      : 'unstated (1 x 1 x 1)'
  say(
    `${label}: ${flavour}, ${source.tiff.ifds.length} planes, ` +
      `${total} channel(s), ${spacing} um voxels` +
      `${source.tiff.isBigTiff ? ', BigTIFF' : ''}` +
      `${tiffIsTiled(source.tiff) ? ', tiled' : ''}`,
  )
}

/** `parseTiff` reads an ArrayBuffer, so every source hands one over. */
async function offerBuffer(buffer, label) {
  offer(describeTiff(parseTiff(buffer)), label)
}

generateButton.onclick = async () => {
  generateButton.disabled = true
  loadButton.disabled = true
  sampleSelect.value = ''
  creditLine.textContent = ''
  say('Generating...')
  try {
    const { bytes, name } = await generate(
      sourceSelect.value,
      compressionSelect.value,
    )
    if (downloadLink.href) {
      URL.revokeObjectURL(downloadLink.href)
    }
    downloadLink.href = URL.createObjectURL(new Blob([bytes]))
    downloadLink.download = name
    downloadLink.hidden = false
    const kb = Math.round(bytes.length / 1024)
    await offerBuffer(
      bytes.buffer,
      `${name} (${kb} kB, ${compressionSelect.value})`,
    )
    return true
  } catch (err) {
    fail('Could not generate the file', err)
    return false
  } finally {
    generateButton.disabled = false
  }
}

fileInput.onchange = async () => {
  const file = fileInput.files?.[0]
  if (!file) {
    return
  }
  creditLine.textContent = ''
  say(`Reading ${file.name}...`)
  try {
    await offerBuffer(await file.arrayBuffer(), file.name)
  } catch (err) {
    fail(`Could not read ${file.name}`, err)
  }
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
  if (!sample?.url) {
    if (await generateButton.onclick()) {
      await loadButton.onclick()
    }
    return
  }
  urlInput.value = sample.url
  // Only load on success: otherwise the stale file would reload and its status
  // line would paper over the fetch error the user needs to read.
  if (await fetchButton.onclick()) {
    await loadButton.onclick()
  }
}

fetchButton.onclick = async () => {
  const url = urlInput.value.trim()
  if (!url) {
    return false
  }
  say(`Fetching ${url}...`)
  try {
    // fetchOmeTiff does exactly this; it is inlined so a failure here is
    // clearly a network or CORS problem rather than a parse one.
    const response = await fetch(url)
    if (!response.ok) {
      throw new Error(`${response.status} ${response.statusText}`)
    }
    const name = url.split('/').pop() || url
    await offerBuffer(await response.arrayBuffer(), name)
    return true
  } catch (err) {
    fail('Could not fetch that URL (a cross-origin host must send CORS)', err)
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
 * Each carries the colormap the loader picked from its OME Color attribute.
 *
 * Windowing is the robust range, not the global one: a fluorescence channel is
 * mostly background with a few bright nuclei, so stretching the colormap across
 * the full range leaves the real signal a few counts above black.
 */
function applyDisplay() {
  const overlayOpacity = Number(opacityInput.value)
  nv1.volumes.forEach((volume, index) => {
    nv1.setVolume(index, {
      calMin: volume.robustMin ?? volume.globalMin,
      calMax: volume.robustMax ?? volume.globalMax,
      opacity: index === 0 ? 1 : overlayOpacity,
    })
  })
}

opacityInput.oninput = () => {
  if (nv1.volumes.length > 0) {
    applyDisplay()
  }
}

// --- 3D clip plane + zoom ---------------------------------------------------
//
// Right-dragging the render tile also positions a clip plane, but this
// checkbox is the discoverable way in: on drops a plane through the stack at
// a fixed angle, off retracts it (depth 2 is the "no clip" sentinel).
clipCheck.onchange = () => {
  nv1.setClipPlane(clipCheck.checked ? [0.1, 270, 0] : [2, 0, 0])
}

// Overlays normally show through a clipped base (each channel of a stack is
// an overlay, so the clip appears to do nothing on a multi-channel load).
// This is the core clipPlaneOverlay flag: cut every channel with the plane.
clipOverlaysCheck.onchange = () => {
  nv1.clipPlaneOverlay = clipOverlaysCheck.checked
}

// While a clip plane is active the wheel adjusts the plane's depth, not the
// camera, so the slider is the way to zoom a clipped render. Two-way: wheel
// zoom (no clip active) emits 'change', which keeps the slider in step.
zoomInput.oninput = () => {
  nv1.scaleMultiplier = Number(zoomInput.value)
}
nv1.addEventListener('change', (e) => {
  if (e.detail?.property !== 'scaleMultiplier') return
  const value = Number(e.detail.value)
  if (Number.isFinite(value) && Number(zoomInput.value) !== value) {
    // Assigning .value fires no 'input', so this cannot loop.
    zoomInput.value = String(value)
  }
})

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
  say('Decoding planes...')
  try {
    const volumes = await omeTiffVolumesFrom(source, { channels })
    await nv1.loadVolumes(volumes)
    applyDisplay()
    const vol = nv1.volumes[0]
    const voxels = vol.dimsRAS.slice(1, 4)
    // A single-plane file (one z, as most published 2D fields are) has nothing
    // to show in the other two planes, so give the whole canvas to the axial.
    nv1.sliceType = voxels[2] > 1 ? SLICE_TYPE.MULTIPLANAR : SLICE_TYPE.AXIAL
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

// Start with something on screen: generate the default file and load it.
if (await generateButton.onclick()) {
  await loadButton.onclick()
}

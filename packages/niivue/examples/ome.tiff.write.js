/**
 * A minimal TIFF writer, used only by `ome.tiff.js` to synthesize demo files
 * in the browser.
 *
 * The reader has no sample data of its own: a real microscopy stack is a large
 * binary that would need Git LFS, and the licence on the public Allen datasets
 * is unconfirmed. Generating a phantom instead keeps the page self-contained,
 * exercises the decoders end to end, and lets the shape of the file be varied
 * (OME-XML vs ImageJ vs plain, one compressor vs another) from a dropdown.
 *
 * Only what the demo needs is implemented: classic little-endian TIFF, one
 * strip per plane, 16-bit unsigned samples, one sample per pixel. It is a
 * fixture generator, not a general writer.
 */

/** TIFF field types used here. */
const TYPE = { ascii: 2, short: 3, long: 4 }

/** TIFF `Compression` codes for the encoders below. */
const COMPRESSION_CODE = { none: 1, deflate: 8, packbits: 32773 }

/**
 * PackBits (TIFF compression 32773): runs of 3 or more become a repeat count,
 * everything else is copied as a literal run. Both counts cap at 128.
 */
function packBits(src) {
  const out = []
  const runLengthAt = (start) => {
    let n = 1
    while (start + n < src.length && src[start + n] === src[start] && n < 128) {
      n++
    }
    return n
  }
  let i = 0
  while (i < src.length) {
    const run = runLengthAt(i)
    if (run >= 3) {
      out.push(257 - run, src[i])
      i += run
      continue
    }
    const start = i
    while (i < src.length && i - start < 128 && runLengthAt(i) < 3) {
      i++
    }
    out.push(i - start - 1)
    for (let k = start; k < i; k++) {
      out.push(src[k])
    }
  }
  return Uint8Array.from(out)
}

/**
 * Zlib deflate, which is what TIFF compression 8 (Adobe Deflate) carries.
 * `CompressionStream('deflate')` emits the zlib wrapper, matching the reader's
 * format sniff.
 */
async function deflate(bytes) {
  const stream = new CompressionStream('deflate')
  const writer = stream.writable.getWriter()
  writer.write(bytes)
  writer.close()
  return new Uint8Array(await new Response(stream.readable).arrayBuffer())
}

/** Pack 16-bit samples little-endian, the byte order the header declares. */
function planeToBytes(plane) {
  const bytes = new Uint8Array(plane.length * 2)
  const view = new DataView(bytes.buffer)
  for (let i = 0; i < plane.length; i++) {
    view.setUint16(i * 2, plane[i], true)
  }
  return bytes
}

function writeEntry(view, at, tag, type, count, value) {
  view.setUint16(at, tag, true)
  view.setUint16(at + 2, type, true)
  view.setUint32(at + 4, count, true)
  if (type === TYPE.short && count === 1) {
    // A SHORT that fits inline sits in the FIRST half of the value field, with
    // the rest zero; writing it as a LONG would land it in the wrong two bytes
    // on a little-endian file.
    view.setUint16(at + 8, value, true)
    view.setUint16(at + 10, 0, true)
  } else {
    view.setUint32(at + 8, value, true)
  }
}

/**
 * Assemble a single-page-per-plane TIFF.
 *
 * `description` becomes the `ImageDescription` of the first IFD, which is where
 * both OME-XML and an ImageJ block live.
 */
export async function writeTiff({
  width,
  height,
  planes,
  description = '',
  compression = 'none',
}) {
  const blocks = []
  for (const plane of planes) {
    const raw = planeToBytes(plane)
    if (compression === 'packbits') {
      blocks.push(packBits(raw))
    } else if (compression === 'deflate') {
      blocks.push(await deflate(raw))
    } else {
      blocks.push(raw)
    }
  }
  const descBytes = description
    ? new TextEncoder().encode(`${description}\0`)
    : null

  // Lay the file out before writing any of it: pixel blocks, then the
  // description, then the IFD chain. Every offset must be even.
  const pad = (n) => n + (n % 2)
  let offset = 8
  const blockOffsets = blocks.map((block) => {
    const at = offset
    offset = pad(offset + block.length)
    return at
  })
  let descOffset = 0
  if (descBytes) {
    descOffset = offset
    offset = pad(offset + descBytes.length)
  }
  const entryCount = (i) => (i === 0 && descBytes ? 11 : 10)
  const ifdOffsets = blocks.map((_block, i) => {
    const at = offset
    offset += 2 + 12 * entryCount(i) + 4
    return at
  })

  const bytes = new Uint8Array(offset)
  const view = new DataView(bytes.buffer)
  view.setUint16(0, 0x4949, true) // 'II', little-endian
  view.setUint16(2, 42, true) // classic TIFF, not BigTIFF
  view.setUint32(4, ifdOffsets[0], true)

  blocks.forEach((block, i) => {
    bytes.set(block, blockOffsets[i])
  })
  if (descBytes) {
    bytes.set(descBytes, descOffset)
  }

  blocks.forEach((block, i) => {
    const start = ifdOffsets[i]
    view.setUint16(start, entryCount(i), true)
    let slot = 0
    const put = (tag, type, count, value) => {
      writeEntry(view, start + 2 + slot * 12, tag, type, count, value)
      slot++
    }
    // Entries must be in ascending tag order.
    put(256, TYPE.long, 1, width)
    put(257, TYPE.long, 1, height)
    put(258, TYPE.short, 1, 16)
    put(259, TYPE.short, 1, COMPRESSION_CODE[compression])
    put(262, TYPE.short, 1, 1) // BlackIsZero
    if (i === 0 && descBytes) {
      put(270, TYPE.ascii, descBytes.length, descOffset)
    }
    put(273, TYPE.long, 1, blockOffsets[i])
    put(277, TYPE.short, 1, 1)
    put(278, TYPE.long, 1, height)
    put(279, TYPE.long, 1, block.length)
    put(339, TYPE.short, 1, 1) // uint
    // The IFD chain ends with a pointer to the next directory, 0 for the last.
    view.setUint32(start + 2 + slot * 12, ifdOffsets[i + 1] ?? 0, true)
  })
  return bytes
}

/** OME-XML for a plane stack, written the way Bio-Formats writes it. */
export function omeXml({
  name,
  sizeX,
  sizeY,
  sizeZ,
  sizeC,
  spacing,
  channels,
}) {
  const channelXml = channels
    .map(
      (channel, i) =>
        `<Channel ID="Channel:0:${i}" Name="${channel.name}"` +
        ` Color="${channel.color}" SamplesPerPixel="1"/>`,
    )
    .join('')
  return (
    '<?xml version="1.0" encoding="UTF-8"?>' +
    '<OME xmlns="http://www.openmicroscopy.org/Schemas/OME/2016-06">' +
    `<Image ID="Image:0" Name="${name}">` +
    '<Pixels ID="Pixels:0" DimensionOrder="XYCZT" Type="uint16"' +
    ` SizeX="${sizeX}" SizeY="${sizeY}" SizeZ="${sizeZ}"` +
    ` SizeC="${sizeC}" SizeT="1" SignificantBits="16" Interleaved="false"` +
    ` PhysicalSizeX="${spacing[0]}" PhysicalSizeXUnit="µm"` +
    ` PhysicalSizeY="${spacing[1]}" PhysicalSizeYUnit="µm"` +
    ` PhysicalSizeZ="${spacing[2]}" PhysicalSizeZUnit="µm">` +
    `${channelXml}</Pixels></Image></OME>`
  )
}

/** An ImageJ hyperstack `ImageDescription`. ImageJ hyperstacks are XYCZT. */
export function imageJDescription({ sizeZ, sizeC, spacingZ }) {
  return [
    'ImageJ=1.54f',
    `images=${sizeZ * sizeC}`,
    `channels=${sizeC}`,
    `slices=${sizeZ}`,
    'frames=1',
    'hyperstack=true',
    'mode=composite',
    'unit=micron',
    `spacing=${spacingZ}`,
    'loop=false',
    '',
  ].join('\n')
}

/**
 * Three channels of synthetic structure, each a different shape so a wrong
 * plane-to-channel mapping is obvious on screen rather than subtle.
 *
 * Values stay well under the 16-bit ceiling so nothing looks clipped.
 */
export function phantomChannels({ sizeX, sizeY, sizeZ }) {
  const peak = 4000
  const cx = (sizeX - 1) / 2
  const cy = (sizeY - 1) / 2
  const cz = (sizeZ - 1) / 2

  // Nuclei: a lattice of blobs, brightest at the centre of each cell.
  const nuclei = (x, y, z) => {
    const pitch = 32
    const dx = (((x % pitch) + pitch) % pitch) - pitch / 2
    const dy = (((y % pitch) + pitch) % pitch) - pitch / 2
    const dz = (((z % 20) + 20) % 20) - 10
    const d2 = dx * dx + dy * dy + dz * dz * 2.5
    return Math.exp(-d2 / (2 * 6 * 6))
  }

  // Membrane: a thin ellipsoid shell around the whole specimen.
  const membrane = (x, y, z) => {
    const r = Math.hypot(
      (x - cx) / (sizeX * 0.42),
      (y - cy) / (sizeY * 0.42),
      (z - cz) / (sizeZ * 0.42),
    )
    const t = r - 1
    return Math.exp(-(t * t) / (2 * 0.05 * 0.05))
  }

  // Filaments: a two-strand helix running the depth of the stack.
  const filaments = (x, y, z) => {
    const turn = (z / Math.max(1, sizeZ - 1)) * 4 * Math.PI
    const radius = Math.min(sizeX, sizeY) * 0.28
    let best = 0
    for (const phase of [0, Math.PI]) {
      const d2 =
        (x - (cx + radius * Math.cos(turn + phase))) ** 2 +
        (y - (cy + radius * Math.sin(turn + phase))) ** 2
      best = Math.max(best, Math.exp(-d2 / (2 * 3.5 * 3.5)))
    }
    return best
  }

  const build = (field) => {
    const planes = []
    for (let z = 0; z < sizeZ; z++) {
      const plane = new Uint16Array(sizeX * sizeY)
      for (let y = 0; y < sizeY; y++) {
        for (let x = 0; x < sizeX; x++) {
          plane[y * sizeX + x] = Math.round(peak * field(x, y, z))
        }
      }
      planes.push(plane)
    }
    return planes
  }

  // Colours are the SIGNED 32-bit RGBA integers OME uses: blue, green, red.
  return [
    { name: 'Nuclei', color: 65535, planes: build(nuclei) },
    { name: 'Membrane', color: 16711935, planes: build(membrane) },
    { name: 'Filaments', color: -16776961, planes: build(filaments) },
  ]
}

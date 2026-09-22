/**
 * OME-XML metadata: the layer that turns a flat TIFF plane stack into a 5-D
 * (X, Y, Z, C, T) image.
 *
 * An OME-TIFF stores its OME-XML in the `ImageDescription` tag of the first
 * IFD. Each subsequent IFD is one plane, and `DimensionOrder` says how the
 * plane index maps onto (Z, C, T).
 *
 * Parsing is done with a small attribute scanner rather than `DOMParser`
 * because the volume readers must stay usable outside a browser (the Bun unit
 * harness has no DOM), and because only a fixed handful of attributes matter.
 *
 * A plain ImageJ stack description is handled too - it is the other metadata
 * block that routinely rides in `ImageDescription`, and it is the only way to
 * recover z-spacing from an ImageJ-written stack.
 *
 * See `docs/ome-tiff-format.md`.
 */

import { log } from '@/logger'

/** One channel of an OME image. */
export interface OmeChannel {
  name: string
  /** Display colour from the `Color` attribute, or null when unset. */
  color: [number, number, number] | null
  samplesPerPixel: number
}

/** The first `<Image>` of an OME-XML document. */
export interface OmeTiffInfo {
  imageName: string
  sizeX: number
  sizeY: number
  sizeZ: number
  sizeC: number
  sizeT: number
  /** Always starts `XY`; the remaining three letters order Z, C and T. */
  dimensionOrder: string
  /** OME `PixelType`, e.g. `uint16`. */
  pixelType: string
  /** Voxel spacing in micrometres. Zero for an axis the file does not state. */
  spacingUm: [number, number, number]
  channels: OmeChannel[]
}

/** An ImageJ `ImageDescription` block. */
export interface ImageJStackInfo {
  images: number
  channels: number
  slices: number
  frames: number
  /** Slice spacing in micrometres, or 0 when the block gives no usable unit. */
  spacingUm: number
}

/**
 * Length units OME writes, expressed in MICROMETRES.
 *
 * Micrometres, not millimetres, are the working unit for every microscopy
 * volume in this package (see `allenAtlasSpacing`). A 0.65 um pixel expressed
 * in mm is 0.00065, and voxel sizes that small make the scene extents, clip
 * planes and label sizes behave badly; micrometres keep the numbers near 1
 * where the renderer is well conditioned. It is also OME's own default unit,
 * so the common case is an exact passthrough.
 */
const UNIT_UM: Record<string, number> = buildUnitTable()

function buildUnitTable(): Record<string, number> {
  // OME-XML writes SI symbols; OME-NGFF axes use spelled-out UDUNITS-2 names
  // ("millimeter"), so both families and both -er/-re spellings are needed.
  const prefixUm: Record<string, number> = {
    '': 1e6,
    yotta: 1e30,
    zetta: 1e27,
    exa: 1e24,
    peta: 1e21,
    tera: 1e18,
    giga: 1e15,
    mega: 1e12,
    kilo: 1e9,
    hecto: 1e8,
    deca: 1e7,
    deci: 1e5,
    centi: 1e4,
    milli: 1e3,
    micro: 1,
    nano: 1e-3,
    pico: 1e-6,
    femto: 1e-9,
    atto: 1e-12,
    zepto: 1e-15,
    yocto: 1e-18,
  }
  const table: Record<string, number> = {
    m: 1e6,
    dm: 1e5,
    cm: 1e4,
    mm: 1e3,
    µm: 1,
    um: 1,
    micron: 1,
    microns: 1,
    nm: 1e-3,
    pm: 1e-6,
    km: 1e9,
    a: 1e-4, // angstrom
    å: 1e-4,
    angstrom: 1e-4,
    in: 25400,
    inch: 25400,
    ft: 304800,
    foot: 304800,
    yd: 914400,
    yard: 914400,
    mi: 1.609344e9,
    mile: 1.609344e9,
    pc: 3.0856775814914e22,
    parsec: 3.0856775814914e22,
  }
  for (const [prefix, um] of Object.entries(prefixUm)) {
    table[`${prefix}meter`] = um
    table[`${prefix}metre`] = um
  }
  return table
}

/**
 * Convert a physical size to micrometres, returning 0 when the unit is
 * unrecognised (a spacing of 0 means "not stated", never "zero-thickness").
 */
export function omeLengthToMicrons(
  value: number,
  unit: string | undefined,
): number {
  if (!Number.isFinite(value) || value <= 0) {
    return 0
  }
  const scale = UNIT_UM[normalizeUnit(unit)]
  if (scale === undefined) {
    // Callers treat 0 as "not stated" and fall back to 1 um, so an
    // unrecognised unit silently mis-sizes the volume unless surfaced.
    log.warn(`OME: unrecognised length unit "${unit}"; treating as unstated`)
    return 0
  }
  return value * scale
}

/**
 * Fold a unit string to a `UNIT_UM` key. Writers spell micrometres with either
 * MICRO SIGN (U+00B5, what the OME schema uses) or GREEK SMALL LETTER MU
 * (U+03BC, what many editors and fonts substitute); the two look identical and
 * must mean the same thing here. Case folding leaves both untouched.
 */
function normalizeUnit(unit: string | undefined): string {
  return (unit ?? 'µm').trim().toLowerCase().replace(/μ/g, 'µ')
}

/** Split an element's attribute text into a map. */
function parseAttributes(source: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  const pattern =
    /([A-Za-z_][\w:.-]*)\s*=\s*"([^"]*)"|([A-Za-z_][\w:.-]*)\s*=\s*'([^']*)'/g
  let match = pattern.exec(source)
  while (match !== null) {
    const name = match[1] ?? match[3]
    const value = match[2] ?? match[4]
    attrs[name] = decodeXmlEntities(value)
    match = pattern.exec(source)
  }
  return attrs
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_all, code: string) =>
      String.fromCodePoint(Number(code)),
    )
    .replace(/&amp;/g, '&')
}

/** Attributes of the first `<tag ...>` in `xml`, namespace prefix tolerated. */
function firstElement(
  xml: string,
  tag: string,
): { attrs: Record<string, string>; end: number } | null {
  const pattern = new RegExp(`<(?:\\w+:)?${tag}\\b([^>]*)>`)
  const match = pattern.exec(xml)
  if (!match) {
    return null
  }
  return {
    attrs: parseAttributes(match[1]),
    end: match.index + match[0].length,
  }
}

function positiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

const DIMENSION_ORDERS = new Set([
  'XYZCT',
  'XYZTC',
  'XYCZT',
  'XYCTZ',
  'XYTCZ',
  'XYTZC',
])

/**
 * Parse an OME-XML document, returning `null` when the text is not OME-XML.
 *
 * Only the FIRST `<Image>` is described. Multi-image (multi-scene) OME-TIFFs
 * and the sub-resolution levels of a pyramidal OME-TIFF are out of scope: both
 * need the `<TiffData>` IFD map, and neither is used by the datasets this
 * targets.
 */
export function parseOmeXml(xml: string | undefined): OmeTiffInfo | null {
  if (!xml || !/<(?:\w+:)?OME[\s>]/.test(xml)) {
    return null
  }
  const imageStart = xml.search(/<(?:\w+:)?Image\b/)
  if (imageStart < 0) {
    return null
  }
  const imageEnd = xml.search(/<\/(?:\w+:)?Image>/)
  const imageXml = xml.slice(imageStart, imageEnd < 0 ? xml.length : imageEnd)
  const image = firstElement(imageXml, 'Image')
  const pixels = firstElement(imageXml, 'Pixels')
  if (!pixels) {
    return null
  }
  const attrs = pixels.attrs
  const sizeX = positiveInt(attrs.SizeX, 0)
  const sizeY = positiveInt(attrs.SizeY, 0)
  if (sizeX === 0 || sizeY === 0) {
    return null
  }
  const declaredOrder = (attrs.DimensionOrder ?? 'XYZCT').toUpperCase()
  const dimensionOrder = DIMENSION_ORDERS.has(declaredOrder)
    ? declaredOrder
    : 'XYZCT'

  const channels: OmeChannel[] = []
  const channelPattern = /<(?:\w+:)?Channel\b([^>]*)>/g
  let channelMatch = channelPattern.exec(imageXml)
  while (channelMatch !== null) {
    const channelAttrs = parseAttributes(channelMatch[1])
    channels.push({
      name:
        channelAttrs.Name ?? channelAttrs.ID ?? `Channel ${channels.length}`,
      color: parseOmeColor(channelAttrs.Color),
      samplesPerPixel: positiveInt(channelAttrs.SamplesPerPixel, 1),
    })
    channelMatch = channelPattern.exec(imageXml)
  }

  return {
    imageName: image?.attrs.Name ?? 'OME image',
    sizeX,
    sizeY,
    sizeZ: positiveInt(attrs.SizeZ, 1),
    sizeC: positiveInt(attrs.SizeC, Math.max(1, channels.length)),
    sizeT: positiveInt(attrs.SizeT, 1),
    dimensionOrder,
    pixelType: (attrs.Type ?? attrs.PixelType ?? 'uint8').toLowerCase(),
    spacingUm: [
      omeLengthToMicrons(Number(attrs.PhysicalSizeX), attrs.PhysicalSizeXUnit),
      omeLengthToMicrons(Number(attrs.PhysicalSizeY), attrs.PhysicalSizeYUnit),
      omeLengthToMicrons(Number(attrs.PhysicalSizeZ), attrs.PhysicalSizeZUnit),
    ],
    channels,
  }
}

/**
 * Decode an OME `Color` attribute, a SIGNED 32-bit RGBA integer.
 *
 * Signed is not incidental: the common green `16711935` and the common red
 * `-16776961` are the same field, so parsing as unsigned silently loses every
 * colour whose red channel exceeds 127.
 */
export function parseOmeColor(
  value: string | undefined,
): [number, number, number] | null {
  if (value === undefined || value.trim() === '') {
    return null
  }
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed)) {
    return null
  }
  const rgba = parsed >>> 0
  return [(rgba >>> 24) & 0xff, (rgba >>> 16) & 0xff, (rgba >>> 8) & 0xff]
}

/**
 * Number of separately-stored channels: the C extent of the plane grid.
 *
 * A channel whose `SamplesPerPixel` is greater than 1 stores its samples
 * interleaved within ONE plane (an RGB brightfield channel is the common
 * case), so `SizeC` counts samples while the plane grid has one slot per
 * `<Channel>` element. Falls back to `SizeC` when the channel list does not
 * account for it exactly.
 */
export function omeEffectiveSizeC(info: OmeTiffInfo): number {
  const samples = info.channels.reduce((sum, c) => sum + c.samplesPerPixel, 0)
  if (info.channels.length > 0 && samples === info.sizeC) {
    return info.channels.length
  }
  return info.sizeC
}

/** IFD index of the (z, c, t) plane under the image's `DimensionOrder`. */
export function omePlaneIndex(
  info: OmeTiffInfo,
  z: number,
  c: number,
  t: number,
): number {
  const sizes: Record<string, number> = {
    Z: info.sizeZ,
    C: omeEffectiveSizeC(info),
    T: info.sizeT,
  }
  const positions: Record<string, number> = { Z: z, C: c, T: t }
  let index = 0
  let stride = 1
  for (const axis of info.dimensionOrder.slice(2)) {
    index += positions[axis] * stride
    stride *= sizes[axis]
  }
  return index
}

/** Total number of planes the OME metadata describes. */
export function omePlaneCount(info: OmeTiffInfo): number {
  return info.sizeZ * omeEffectiveSizeC(info) * info.sizeT
}

/** Display name for a channel, falling back to a positional label. */
export function omeChannelName(info: OmeTiffInfo, channel: number): string {
  const named = info.channels[channel]?.name
  return named && named.trim() !== '' ? named : `Channel ${channel}`
}

/**
 * Parse an ImageJ `ImageDescription` block.
 *
 * ImageJ writes `key=value` lines; `slices`, `channels`, `frames` describe the
 * stack shape and `spacing` + `unit` give the z-step, which is otherwise
 * unrecoverable from a plain TIFF.
 */
export function parseImageJDescription(
  text: string | undefined,
): ImageJStackInfo | null {
  if (!text?.startsWith('ImageJ')) {
    return null
  }
  const fields: Record<string, string> = {}
  for (const line of text.split('\n')) {
    const split = line.indexOf('=')
    if (split > 0) {
      fields[line.slice(0, split).trim()] = line.slice(split + 1).trim()
    }
  }
  const spacing = Number(fields.spacing)
  return {
    images: positiveInt(fields.images, 0),
    channels: positiveInt(fields.channels, 1),
    slices: positiveInt(fields.slices, 0),
    frames: positiveInt(fields.frames, 1),
    spacingUm: Number.isFinite(spacing)
      ? omeLengthToMicrons(Math.abs(spacing), fields.unit)
      : 0,
  }
}

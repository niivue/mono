/**
 * Sanitized technical metadata for the Quick Look overlay.
 *
 * Deliberately header-derived and *closed*: every field below is a number, a
 * code, or a filename. The product contract forbids free-text and
 * patient-adjacent header fields, so `descrip`, `aux_file`, `intent_name` and
 * `db_name` are never read here — a preview that Finder renders unprompted is
 * the wrong place to surface whatever a scanner wrote into a string field.
 *
 * Every NiiVue volume reader normalizes into a NIfTI header, so one extractor
 * covers NIfTI, MGH/MGZ, NRRD and MetaImage alike.
 */
import { NiiDataType, type NVImage, type NVMesh } from '@niivue/niivue'

/** Terse names; the strip is narrow. `getDatatypeCodeString` is far too wordy. */
const datatypeNames: Record<number, string> = {
  [NiiDataType.DT_BINARY]: 'bit',
  [NiiDataType.DT_UINT8]: 'uint8',
  [NiiDataType.DT_INT16]: 'int16',
  [NiiDataType.DT_INT32]: 'int32',
  [NiiDataType.DT_FLOAT32]: 'float32',
  [NiiDataType.DT_COMPLEX64]: 'complex64',
  [NiiDataType.DT_FLOAT64]: 'float64',
  [NiiDataType.DT_RGB24]: 'rgb24',
  [NiiDataType.DT_INT8]: 'int8',
  [NiiDataType.DT_UINT16]: 'uint16',
  [NiiDataType.DT_UINT32]: 'uint32',
  [NiiDataType.DT_INT64]: 'int64',
  [NiiDataType.DT_UINT64]: 'uint64',
  [NiiDataType.DT_FLOAT128]: 'float128',
  [NiiDataType.DT_COMPLEX128]: 'complex128',
  [NiiDataType.DT_COMPLEX256]: 'complex256',
  [NiiDataType.DT_RGBA32]: 'rgba32',
}

/**
 * Complex data reaches the screen as a derived scalar, not as the data itself,
 * so the contract routes it to metadata rather than a picture that
 * misrepresents the file.
 *
 * NiiVue's plain NIfTI reader rejects these outright ("Unsupported datatype:
 * 32") and never gets here — the path that does is spectroscopy, where the
 * volume carries `complexFID` alongside a scalar `img`.
 */
const complexTypes = new Set<number>([
  NiiDataType.DT_COMPLEX64,
  NiiDataType.DT_COMPLEX128,
  NiiDataType.DT_COMPLEX256,
])

/** Elements per voxel, for the datatypes that pack more than one. */
const componentsPerVoxel: Record<number, number> = {
  [NiiDataType.DT_RGB24]: 3,
  [NiiDataType.DT_RGBA32]: 4,
}

/** Spatial unit from the low three bits of `xyzt_units`. */
const spatialUnits: Record<number, string> = { 1: 'm', 2: 'mm', 3: 'µm' }

/**
 * NIfTI is one of many containers NiiVue normalizes; name what the user opened.
 *
 * Exactly the extensions the extension claims, and no more. NiiVue reads a
 * dozen others, but a name here for a type Quick Look never routes to us is
 * dead config that reads as though the format were supported. The detached
 * families (`nhdr`, `mhd`, AFNI `head`/`brik`, NIfTI `hdr`/`img`) are
 * deliberately absent — see the Milestone 6 decision.
 */
const formatNames: Record<string, string> = {
  nii: 'NIfTI',
  mgh: 'MGH',
  mgz: 'MGZ',
  nrrd: 'NRRD',
  mha: 'MetaImage',
  gii: 'GIFTI',
  mz3: 'MZ3',
  tck: 'TCK',
  trk: 'TRK',
  trx: 'TRX',
}

/** The extension that identifies the format, looking past a `.gz` wrapper. */
export function formatName(fileName: string): string {
  let name = fileName.toLowerCase()
  if (name.endsWith('.gz')) name = name.slice(0, -3)
  const dot = name.lastIndexOf('.')
  const ext = dot < 0 ? '' : name.slice(dot + 1)
  return formatNames[ext] ?? (ext ? ext.toUpperCase() : 'Unknown')
}

/**
 * Anatomical orientation code (`RAS`, `LPI`, …) from NiiVue's `permRAS`.
 *
 * `permRAS[i]` is the 1-based source axis that maps to RAS axis `i`, negated
 * when that axis is flipped. The conventional code labels the *source* axes, so
 * this inverts the mapping rather than reading it off directly.
 */
export function orientationCode(permRAS: number[] | undefined): string {
  if (!permRAS || permRAS.length < 3) return '—'
  const positive = ['R', 'A', 'S']
  const negative = ['L', 'P', 'I']
  const code = ['?', '?', '?']
  for (let i = 0; i < 3; i++) {
    const axis = Math.abs(permRAS[i]) - 1
    if (axis < 0 || axis > 2) return '—'
    code[axis] = permRAS[i] < 0 ? negative[i] : positive[i]
  }
  return code.join('')
}

/** Trim trailing zeros so `1.00×1.00×1.00` reads as `1×1×1`. */
function trim(value: number): string {
  if (!Number.isFinite(value)) return '—'
  return String(Math.round(value * 100) / 100)
}

export interface VolumeSummary {
  /** Ordered pairs for the overlay strip. */
  pairs: Record<string, string>
  /** False when the file loaded but is not an ordinary displayable volume. */
  displayable: boolean
  /** Set when `displayable` is false: why, in one phrase. */
  reason?: string
}

export function describeVolume(
  volume: NVImage,
  fileName: string,
  fileSize: number | undefined,
): VolumeSummary {
  const hdr = volume.hdr
  // `hdr.dims`/`pixDims` are the file's own values, not NiiVue's RAS-reordered
  // view. Someone checking a preview against `fslhd` should see the same
  // numbers; the reorientation is reported separately, as the orientation code.
  const dims = [hdr.dims[1], hdr.dims[2], hdr.dims[3]]
  const pix = [hdr.pixDims[1], hdr.pixDims[2], hdr.pixDims[3]]
  const unit = spatialUnits[hdr.xyzt_units & 7] ?? 'mm'
  const loadedFrames = volume.nFrame4D ?? 1
  const totalFrames = volume.nTotalFrame4D ?? loadedFrames

  const pairs: Record<string, string> = {
    format: formatName(fileName),
    dims: dims.map((d) => String(d)).join('×'),
    voxel: `${pix.map(trim).join('×')} ${unit}`,
    // Physical extent, which is what tells you at a glance whether this is a
    // whole head or a specimen — neither dims nor spacing says that alone.
    fov: `${dims.map((d, i) => trim(d * pix[i])).join('×')} ${unit}`,
    type: datatypeNames[hdr.datatypeCode] ?? `code ${hdr.datatypeCode}`,
    orient: orientationCode(volume.permRAS),
  }
  // Only a 4D file mentions frames; a plain volume saying "frames 1" is noise.
  // "1 of 240" is the whole contract in one field: frame zero is what is drawn,
  // the total is what the file holds, and the preview never pretends otherwise.
  if (totalFrames > 1) pairs.frames = `${loadedFrames} of ${totalFrames}`
  if (fileSize !== undefined && fileSize >= 0)
    pairs.size = formatBytes(fileSize)

  if (dims.some((d) => !Number.isFinite(d) || d < 1)) {
    return { pairs, displayable: false, reason: 'zero-dimension' }
  }
  // A single-voxel-thick volume has no ordinary three-plane view.
  if (dims.filter((d) => d > 1).length < 3) {
    return { pairs, displayable: false, reason: 'not three-dimensional' }
  }
  if (complexTypes.has(hdr.datatypeCode) || volume.isImaginary) {
    return { pairs, displayable: false, reason: 'complex data' }
  }
  if (!volume.img) {
    return { pairs, displayable: false, reason: 'no voxel data' }
  }
  // A truncated file still parses: the header promises a full volume and NiiVue
  // hands back whatever data was there, so `img` is short. Rendering it would
  // draw a head with the bottom third missing and no indication why.
  const expected =
    volume.nVox3D * loadedFrames * (componentsPerVoxel[hdr.datatypeCode] ?? 1)
  if (Number.isFinite(expected) && volume.img.length < expected) {
    return { pairs, displayable: false, reason: 'the file is incomplete' }
  }
  return { pairs, displayable: true }
}

/**
 * Geometry summary for a mesh or a tract bundle.
 *
 * The two are one NiiVue species apart and need different numbers: a surface is
 * described by vertices and triangles, a bundle by streamlines and points.
 * Reporting a tract's `positions` would be misleading — those are the
 * tessellated cylinder vertices NiiVue generates, not anything in the file.
 */
export function describeMesh(
  mesh: NVMesh,
  fileName: string,
  fileSize: number | undefined,
): VolumeSummary {
  const pairs: Record<string, string> = { format: formatName(fileName) }

  if (mesh.kind === 'tract' && mesh.trx) {
    pairs.kind = 'streamlines'
    pairs.streamlines = String(Math.max(0, mesh.trx.offsets.length - 1))
    pairs.points = String(mesh.trx.vertices.length / 3)
  } else {
    pairs.kind = 'surface'
    pairs.vertices = String(mesh.positions.length / 3)
    pairs.triangles = String(mesh.indices.length / 3)
    if (mesh.layers.length > 0) pairs.layers = String(mesh.layers.length)
  }

  const min = mesh.extentsMin
  const max = mesh.extentsMax
  const extent = [0, 1, 2].map((i) => max[i] - min[i])
  if (extent.every((v) => Number.isFinite(v))) {
    pairs.extent = `${extent.map(trim).join('×')} mm`
  }
  if (fileSize !== undefined && fileSize >= 0)
    pairs.size = formatBytes(fileSize)

  // A GIFTI holding only scalars or labels loads cleanly with no geometry at
  // all. The contract is explicit that this shows metadata and does NOT go
  // looking through the filesystem for the surface those values belong to.
  if (mesh.positions.length < 9) {
    return {
      pairs,
      displayable: false,
      reason:
        mesh.layers.length > 0
          ? 'it holds per-vertex data but no surface'
          : 'it holds no geometry',
    }
  }
  return { pairs, displayable: true }
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) return '—'
  const units = ['B', 'KB', 'MB', 'GB']
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024
    unit += 1
  }
  return `${value < 10 && unit > 0 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`
}

/**
 * Deterministic NIfTI-1 fixture generation for the preview regression checks.
 *
 * Milestone 0 of the Quick Look plan allows "a documented deterministic
 * fixture-generation step" in place of a redistributable file, which is what
 * this is. The cases that matter — 4D, complex, zero-dimension, truncated —
 * have no licensed fixture anywhere in the monorepo, and synthesising them is
 * both smaller and more precise than hunting for real scans that happen to have
 * the property under test.
 *
 * Layout follows the NIfTI-1 spec: a 348-byte header, `magic` "n+1\0" at 344,
 * and voxel data at `vox_offset` 352.
 */

const HEADER_BYTES = 348
const VOX_OFFSET = 352

/** Bytes per voxel for the datatype codes these fixtures use. */
const BYTES_PER_VOXEL = { 2: 1, 4: 2, 16: 4, 32: 8, 64: 8 }

/**
 * @param {object} spec
 * @param {number[]} spec.dims  [x, y, z] or [x, y, z, t]
 * @param {number[]} [spec.pixDims]  voxel size in mm, defaults to 1×1×1
 * @param {number} [spec.datatype]  NIfTI datatype code, defaults to uint8
 * @param {(i: number, voxel: number) => number} [spec.fill]  value per element
 * @param {number} [spec.truncateTo]  total byte length to cut the file down to
 */
export function nifti1(spec) {
  const [nx, ny, nz, nt = 1] = spec.dims
  const pix = spec.pixDims ?? [1, 1, 1]
  const datatype = spec.datatype ?? 2
  const perVoxel = BYTES_PER_VOXEL[datatype]
  if (!perVoxel) throw new Error(`no fixture support for datatype ${datatype}`)

  const voxels = Math.max(0, nx * ny * nz * nt)
  // Complex packs two float32 per voxel; everything else is one element.
  const elements = datatype === 32 ? voxels * 2 : voxels
  const buffer = Buffer.alloc(VOX_OFFSET + voxels * perVoxel)
  const view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)

  view.setInt32(0, HEADER_BYTES, true) // sizeof_hdr
  view.setInt16(40, nt > 1 ? 4 : 3, true) // dim[0]
  view.setInt16(42, nx, true)
  view.setInt16(44, ny, true)
  view.setInt16(46, nz, true)
  view.setInt16(48, nt, true)
  for (let i = 5; i <= 7; i++) view.setInt16(40 + i * 2, 1, true)
  view.setInt16(70, datatype, true)
  view.setInt16(72, perVoxel * 8, true) // bitpix
  view.setFloat32(76, 1, true) // pixdim[0] qfac
  view.setFloat32(80, pix[0], true)
  view.setFloat32(84, pix[1], true)
  view.setFloat32(88, pix[2], true)
  view.setFloat32(92, 1, true) // pixdim[4], TR
  view.setFloat32(108, VOX_OFFSET, true) // vox_offset
  view.setFloat32(112, 1, true) // scl_slope
  view.setUint8(123, 2 | 8) // xyzt_units: mm + sec
  view.setInt16(254, 1, true) // sform_code = scanner anat

  // An axis-aligned RAS affine centred on the volume, so `orient` reads "RAS".
  const srow = [
    [pix[0], 0, 0, (-pix[0] * nx) / 2],
    [0, pix[1], 0, (-pix[1] * ny) / 2],
    [0, 0, pix[2], (-pix[2] * nz) / 2],
  ]
  srow.forEach((row, r) => {
    row.forEach((v, c) => {
      view.setFloat32(280 + r * 16 + c * 4, v, true)
    })
  })
  buffer.write('n+1\0', 344, 'ascii')

  // A soft-edged blob, so slices have structure rather than a flat field.
  const fill =
    spec.fill ??
    ((i) => {
      const v = i % (nx * ny * nz)
      const x = v % nx
      const y = Math.floor(v / nx) % ny
      const z = Math.floor(v / (nx * ny)) % nz
      const r =
        Math.hypot(x - nx / 2, y - ny / 2, z - nz / 2) /
        (Math.min(nx, ny, nz) / 2)
      return r > 1 ? 0 : Math.round(255 * (1 - r * r))
    })

  for (let i = 0; i < elements; i++) {
    const at = VOX_OFFSET + i * (datatype === 32 ? 4 : perVoxel)
    const value = fill(i)
    if (datatype === 2) view.setUint8(at, value & 0xff)
    else if (datatype === 4) view.setInt16(at, value, true)
    else if (datatype === 16 || datatype === 32)
      view.setFloat32(at, value, true)
    else if (datatype === 64) view.setFloat64(at, value, true)
  }

  return spec.truncateTo === undefined
    ? buffer
    : buffer.subarray(0, spec.truncateTo)
}

/**
 * A GIFTI surface, or — with no geometry — the layer-only file the product
 * contract singles out: one that supplies scalars and expects a viewer to go
 * looking for a companion surface, which this preview must refuse to do.
 *
 * ASCII encoding keeps the fixture readable and sidesteps base64 endianness.
 * NiiVue's reader defaults an absent `Dim2` to 1, so the conventional
 * `Dimensionality="2"` form is what it expects.
 */
function dataArray(intent, dataType, dims, values) {
  const dimAttrs = dims.map((d, i) => `Dim${i}="${d}"`).join(' ')
  return `  <DataArray Intent="${intent}" DataType="${dataType}"
    ArrayIndexingOrder="RowMajorOrder" Dimensionality="${dims.length}" ${dimAttrs}
    Encoding="ASCII" Endian="LittleEndian" ExternalFileName="" ExternalFileOffset="">
    <Data>${values.join(' ')}</Data>
  </DataArray>`
}

export function gifti(spec) {
  const arrays = []
  if (spec.vertices) {
    arrays.push(
      dataArray(
        'NIFTI_INTENT_POINTSET',
        'NIFTI_TYPE_FLOAT32',
        [spec.vertices.length / 3, 3],
        spec.vertices,
      ),
    )
  }
  if (spec.triangles) {
    arrays.push(
      dataArray(
        'NIFTI_INTENT_TRIANGLE',
        'NIFTI_TYPE_INT32',
        [spec.triangles.length / 3, 3],
        spec.triangles,
      ),
    )
  }
  if (spec.scalars) {
    arrays.push(
      dataArray(
        'NIFTI_INTENT_SHAPE',
        'NIFTI_TYPE_FLOAT32',
        [spec.scalars.length],
        spec.scalars,
      ),
    )
  }
  return Buffer.from(
    `<?xml version="1.0" encoding="UTF-8"?>
<GIFTI Version="1.0" NumberOfDataArrays="${arrays.length}">
${arrays.join('\n')}
</GIFTI>
`,
    'utf8',
  )
}

/** The specimens `preview-regression.mjs` asserts on, defined once. */
export const SPECIMENS = {
  volume: () => nifti1({ dims: [24, 28, 20], pixDims: [2, 2, 2.5] }),
  truncated: () =>
    nifti1({
      dims: [24, 28, 20],
      truncateTo: 352 + Math.floor((24 * 28 * 20) / 3),
    }),
  corrupt: () =>
    Buffer.from('not a volume in any format niivue reads '.repeat(64)),
  surface: () => gifti(octahedron()),
  layerOnly: () => gifti({ scalars: [0, 1, 2, 3, 4, 5] }),
}

/** A closed octahedron, big enough in mm to look like something on screen. */
export function octahedron(radius = 40) {
  const r = radius
  const vertices = [r, 0, 0, -r, 0, 0, 0, r, 0, 0, -r, 0, 0, 0, r, 0, 0, -r]
  const triangles = [
    0, 2, 4, 2, 1, 4, 1, 3, 4, 3, 0, 4, 2, 0, 5, 1, 2, 5, 3, 1, 5, 0, 3, 5,
  ]
  return { vertices, triangles }
}

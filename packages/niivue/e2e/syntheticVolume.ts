/** Options for `syntheticVolume`. */
export type SyntheticVolumeOptions = {
  /** File name; default `synthetic.nii` (`oblique.nii` when tilted). */
  name?: string
  /** Voxels per axis; default 64. */
  n?: number
  /** Isotropic voxel size in mm; default 3, about the MNI field of view. */
  mm?: number
  /**
   * Degrees about x, then about y: the voxel grid is rotated in world space,
   * so an axial voxel plane is oblique in mm. Default none.
   */
  tilt?: [number, number]
}

/**
 * A small uint8 NIfTI built in the page, for specs that need a volume but not
 * a particular one: no Git LFS object, no fetch and next to no decode time.
 * An ellipsoid with an x-gradient (40..164) and a bright sphere (220) off
 * centre, so slices and 3D renders show structure, centred on the origin.
 *
 * It runs IN THE PAGE: interpolate it into page source
 * (`const synth = ${syntheticVolume}`). It uses nothing but its argument.
 */
export function syntheticVolume(opts: SyntheticVolumeOptions = {}): File {
  const n = opts.n ?? 64
  const mm = opts.mm ?? 3
  const [ax, ay] = (opts.tilt ?? [0, 0]).map((d) => (d * Math.PI) / 180)
  const name = opts.name ?? (opts.tilt ? 'oblique.nii' : 'synthetic.nii')
  const OFFSET = 352
  const bytes = new Uint8Array(OFFSET + n * n * n)
  const dv = new DataView(bytes.buffer)
  dv.setInt32(0, 348, true)
  const dims = [3, n, n, n, 1, 1, 1, 1]
  dims.forEach((d, i) => {
    dv.setInt16(40 + 2 * i, d, true)
  })
  dv.setInt16(70, 2, true) // DT_UINT8
  dv.setInt16(72, 8, true) // bitpix
  const pixdim = [1, mm, mm, mm, 1, 1, 1, 1]
  pixdim.forEach((p, i) => {
    dv.setFloat32(76 + 4 * i, p, true)
  })
  dv.setFloat32(108, OFFSET, true)
  dv.setFloat32(112, 1, true) // scl_slope
  dv.setInt16(254, 1, true) // sform_code: scanner
  // sform rows: mm * Rx(ax) * Ry(ay), keeping the grid centre on the origin.
  const ry = [
    [Math.cos(ay), 0, Math.sin(ay)],
    [0, 1, 0],
    [-Math.sin(ay), 0, Math.cos(ay)],
  ]
  const rx = [
    [1, 0, 0],
    [0, Math.cos(ax), -Math.sin(ax)],
    [0, Math.sin(ax), Math.cos(ax)],
  ]
  const c = (n - 1) / 2
  for (let i = 0; i < 3; i++) {
    const row = [0, 1, 2].map(
      (j) => mm * rx[i].reduce((s, v, k) => s + v * ry[k][j], 0),
    )
    const srow = [...row, -(row[0] + row[1] + row[2]) * c]
    srow.forEach((v, j) => {
      dv.setFloat32(280 + 16 * i + 4 * j, v, true)
    })
  }
  bytes.set([110, 43, 49, 0], 344) // 'n+1\0'
  for (let z = 0; z < n; z++)
    for (let y = 0; y < n; y++)
      for (let x = 0; x < n; x++) {
        const [u, v, w] = [x / (n - 1), y / (n - 1), z / (n - 1)]
        const inside =
          ((u - 0.5) / 0.44) ** 2 +
            ((v - 0.5) / 0.38) ** 2 +
            ((w - 0.5) / 0.32) ** 2 <=
          1
        const bright =
          (u - 0.62) ** 2 + (v - 0.38) ** 2 + (w - 0.56) ** 2 < 0.01
        bytes[OFFSET + x + n * (y + n * z)] = bright
          ? 220
          : inside
            ? 40 + Math.round(124 * u)
            : 0
      }
  return new File([bytes], name)
}

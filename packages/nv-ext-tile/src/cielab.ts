// DICOM CIELab (PS3.3 C.10.7.1.1: ICC PCSLab, D50, 16-bit scaled) to sRGB.

const D50 = [0.96422, 1, 0.82521]
// XYZ (D50) to linear sRGB, Bradford-adapted to D65 (Lindbloom).
const M = [
  [3.1338561, -1.6168667, -0.4906146],
  [-0.9787684, 1.9161415, 0.033454],
  [0.0719453, -0.2289914, 1.4052427],
]

/** sRGB 0..255 of a DICOM-encoded CIELab value: L* = L/65535*100, a*, b* = v/65535*255-128. */
export function dicomLabToSrgb(
  lab: readonly number[],
): [number, number, number] {
  const L = ((lab[0] as number) / 0xffff) * 100
  const a = ((lab[1] as number) / 0xffff) * 255 - 128
  const b = ((lab[2] as number) / 0xffff) * 255 - 128
  const fy = (L + 16) / 116
  const inv = (t: number) =>
    t > 6 / 29 ? t ** 3 : 3 * (6 / 29) ** 2 * (t - 4 / 29)
  const xyz = [fy + a / 500, fy, fy - b / 200].map(
    (t, i) => inv(t) * (D50[i] as number),
  )
  return M.map((row) => {
    const v = Math.min(
      1,
      Math.max(
        0,
        row.reduce((s, m, i) => s + m * (xyz[i] as number), 0),
      ),
    )
    const g = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055
    return Math.round(g * 255)
  }) as [number, number, number]
}

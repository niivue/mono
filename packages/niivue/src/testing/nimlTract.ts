/** Two binary bundles with three streamlines; no external fixture needed. */
export function nimlTract(littleEndian = true): Uint8Array<ArrayBuffer> {
  const encoder = new TextEncoder()
  const parts: Uint8Array[] = [
    encoder.encode('<network N_tracts="3" ni_form="ni_group">\n'),
  ]
  for (const [bundle, tracts] of [
    [
      21,
      [
        [1, 2, 3, 4, 5, 6],
        [7, 8, 9, 10, 11, 12, 13, 14, 15],
      ],
    ],
    [47, [[-1, -2, -3, -4, -5, -6]]],
  ] as const) {
    parts.push(
      encoder.encode(
        `<tracts ni_form="binary.${littleEndian ? 'lsbfirst' : 'msbfirst'}" ni_type="TAYLOR_TRACT_DATUM" ni_dimen="${tracts.length}" Bundle_Tag="${bundle}">`,
      ),
    )
    for (const xyz of tracts) {
      const data = new Uint8Array(8 + xyz.length * 4)
      const view = new DataView(data.buffer)
      view.setInt32(0, 10, littleEndian) // First byte can be whitespace.
      view.setInt32(4, xyz.length, littleEndian)
      xyz.forEach((v, i) => {
        view.setFloat32(8 + i * 4, v, littleEndian)
      })
      parts.push(data)
    }
    parts.push(encoder.encode('</tracts>\n'))
  }
  parts.push(encoder.encode('</network>\n'))
  const result = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0))
  let pos = 0
  for (const part of parts) {
    result.set(part, pos)
    pos += part.length
  }
  return result
}

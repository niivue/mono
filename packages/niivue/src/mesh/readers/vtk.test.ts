import { describe, expect, test } from 'bun:test'
import { probeVTKContent, read, readVTKLines } from './vtk'

const enc = new TextEncoder()
const POINTS = [0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0]

/** Concatenate header text and big-endian int32/float32 payloads. */
function vtk(...parts: (string | { f32: number[] } | { i32: number[] })[]) {
  const bytes = parts.map((p) => {
    if (typeof p === 'string') return enc.encode(p)
    const vals = 'f32' in p ? p.f32 : p.i32
    const dv = new DataView(new ArrayBuffer(vals.length * 4))
    vals.forEach((v, i) => {
      if ('f32' in p) dv.setFloat32(i * 4, v, false)
      else dv.setInt32(i * 4, v, false)
    })
    return new Uint8Array(dv.buffer)
  })
  const out = new Uint8Array(bytes.reduce((n, b) => n + b.length, 0))
  let o = 0
  for (const b of bytes) {
    out.set(b, o)
    o += b.length
  }
  return out.buffer
}

describe('VTK reader', () => {
  test('ASCII polygons without a title line', async () => {
    const buf = vtk(
      `# vtk DataFile Version 3.0\nASCII\nDATASET POLYDATA\nPOINTS 4 float\n${POINTS.join(' ')}\nPOLYGONS 1 5\n4 0 1 3 2\n`,
    )
    expect(probeVTKContent(buf)).toBe('mesh')
    const mesh = await read(buf)
    expect(Array.from(mesh.positions ?? [])).toEqual(POINTS)
    expect(Array.from(mesh.indices ?? [])).toEqual([0, 1, 3, 0, 3, 2])
  })

  test('binary triangle strip after a title line', async () => {
    const buf = vtk(
      '# vtk DataFile Version 3.0\ntitle\nBINARY\nDATASET POLYDATA\nPOINTS 4 float\n',
      { f32: POINTS },
      '\nTRIANGLE_STRIPS 1 5\n',
      { i32: [4, 0, 1, 2, 3] },
      '\n',
    )
    const mesh = await read(buf)
    expect(Array.from(mesh.positions ?? [])).toEqual(POINTS)
    expect(Array.from(mesh.indices ?? [])).toEqual([0, 1, 2, 3, 2, 1])
  })

  test('ASCII and binary LINES give the same streamlines', () => {
    const ascii = vtk(
      `# vtk DataFile Version 3.0\nt\nASCII\nDATASET POLYDATA\nPOINTS 4 float\n${POINTS.join(' ')}\nLINES 2 7\n3 0 1 2\n2 3 0\n`,
    )
    const binary = vtk(
      '# vtk DataFile Version 3.0\nBINARY\nDATASET POLYDATA\nPOINTS 4 float\n',
      { f32: POINTS },
      '\nLINES 2 7\n',
      { i32: [3, 0, 1, 2, 2, 3, 0] },
      '\n',
    )
    for (const buf of [ascii, binary]) {
      expect(probeVTKContent(buf)).toBe('tract')
      const tract = readVTKLines(buf)
      expect(Array.from(tract.offsets)).toEqual([0, 3, 5])
      expect(Array.from(tract.vertices)).toEqual([
        ...POINTS.slice(0, 9),
        ...POINTS.slice(9, 12),
        ...POINTS.slice(0, 3),
      ])
    }
  })
})

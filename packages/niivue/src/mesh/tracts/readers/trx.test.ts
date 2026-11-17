import { describe, expect, it } from 'bun:test'
import { read } from './trx'

// A stored (uncompressed) zip: local file headers then an end-of-directory record.
function storedZip(files: Record<string, Uint8Array>): ArrayBuffer {
  const parts: Uint8Array[] = []
  for (const [name, data] of Object.entries(files)) {
    const nameBytes = new TextEncoder().encode(name)
    const head = new DataView(new ArrayBuffer(30))
    head.setUint32(0, 0x04034b50, true)
    head.setUint32(18, data.byteLength, true) // compressed size
    head.setUint32(22, data.byteLength, true) // uncompressed size
    head.setUint16(26, nameBytes.byteLength, true)
    parts.push(new Uint8Array(head.buffer), nameBytes, data)
  }
  const end = new DataView(new ArrayBuffer(22))
  end.setUint32(0, 0x06054b50, true)
  parts.push(new Uint8Array(end.buffer))
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.byteLength
  }
  return out.buffer
}

const bytes = (a: Float32Array | Uint32Array) => new Uint8Array(a.buffer)

describe('TRX reader', () => {
  it.each([
    { offsets: [0] },
    { offsets: [0, 2] },
  ])('reads %j and prototype-named scalars', async ({ offsets }) => {
    const tract = await read(
      storedZip({
        'positions.3.float32': bytes(new Float32Array([0, 0, 0, 1, 1, 1])),
        'offsets.uint32': bytes(new Uint32Array(offsets)),
        'groups/__proto__.uint32': bytes(new Uint32Array([0])),
        'dpg/__proto__/fa.float32': bytes(new Float32Array([0.5])),
        'dps/constructor.float32': bytes(new Float32Array([2])),
      }),
    )
    expect(Object.hasOwn(tract.groups, '__proto__')).toBe(true)
    expect(Array.from(tract.groups.__proto__ as Uint32Array)).toEqual([0])
    expect(Object.hasOwn(tract.dps, 'constructor')).toBe(true)
    expect(Array.from(tract.offsets)).toEqual([0, 2])
    expect(Array.from(tract.dps['dpg:fa'])).toEqual([0.5])
  })
  it('keeps an empty last streamline in legacy offsets', async () => {
    const tract = await read(
      storedZip({
        'header.json': new TextEncoder().encode('{"NB_STREAMLINES":2}'),
        'positions.3.float32': bytes(new Float32Array([0, 0, 0, 1, 1, 1])),
        'offsets.uint32': bytes(new Uint32Array([0, 2])),
      }),
    )
    expect(Array.from(tract.offsets)).toEqual([0, 2, 2])
  })
  it.each([
    '{',
    '{"NB_STREAMLINES":"1"}',
    '{"NB_STREAMLINES":-1}',
  ])('falls back to the offsets heuristic for header %s', async (header) => {
    const tract = await read(
      storedZip({
        'header.json': new TextEncoder().encode(header),
        'positions.3.float32': bytes(new Float32Array([0, 0, 0, 1, 1, 1])),
        'offsets.uint32': bytes(new Uint32Array([0])),
      }),
    )
    expect(Array.from(tract.offsets)).toEqual([0, 2])
  })
})

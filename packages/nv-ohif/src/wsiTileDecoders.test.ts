import { describe, expect, it } from 'bun:test'
import type { FrameDecoder } from '@niivue/dcm2niix'
import type { SlideTileDecoder } from '@niivue/niivue'
import { createWsiTileDecoder } from './wsiTileDecoders'

type Ctx = Parameters<SlideTileDecoder>[1]
const ctx = {
  level: { photometric: 'MONOCHROME2', bitsStored: 12 },
} as unknown as Ctx
const bytes = new Uint8Array([1])
const samples = { samples: new Uint16Array(1) }

// A pool whose decode runs `behave`, counting creations and terminations.
function fakePools(behave: (pool: number) => Promise<unknown>) {
  const stats = { created: 0, terminated: [] as number[] }
  const create = async () => {
    const id = stats.created++
    return {
      decode: () => behave(id),
      iccLut: async () => null,
      terminate: () => stats.terminated.push(id),
    } as unknown as FrameDecoder
  }
  return { stats, decode: createWsiTileDecoder(create) }
}

const named = (name: string, message: string) =>
  Object.assign(new Error(message), { name })

describe('createWsiTileDecoder', () => {
  it('replaces a pool whose workers died, and terminates the old one', async () => {
    const { stats, decode } = fakePools(async (id) => {
      if (id === 0) throw new Error('dcm2niix WASM failed to load: offline')
      return samples
    })
    await expect(decode(bytes, ctx)).rejects.toThrow('WASM failed to load')
    expect(stats.terminated).toEqual([0])
    expect(await decode(bytes, ctx)).toBe(samples as never)
    expect(stats.created).toBe(2)
  })

  it('keeps the pool for a bad frame, an abort, a full queue or a terminated pool', async () => {
    const errors = [
      named('FrameDecodeError', 'decode-error'),
      named('AbortError', 'aborted'),
      new Error('frame decoder busy: 256 decodes pending'),
      new Error('frame decoder terminated'),
    ]
    let n = 0
    const { stats, decode } = fakePools(async () => {
      throw errors[n++]
    })
    for (const _ of errors) await expect(decode(bytes, ctx)).rejects.toThrow()
    expect(stats.created).toBe(1)
    expect(stats.terminated).toEqual([])
  })

  it('waits for in-flight decodes before terminating a retired pool', async () => {
    let release: (v: unknown) => void = () => {}
    let call = 0
    const { stats, decode } = fakePools((id) => {
      if (id > 0) return Promise.resolve(samples)
      if (call++ === 0) return new Promise((r) => (release = r))
      return Promise.reject(new Error('dcm2niix frame worker trapped: oob'))
    })
    const slow = decode(bytes, ctx)
    await expect(decode(bytes, ctx)).rejects.toThrow('trapped')
    expect(stats.terminated).toEqual([])
    await decode(bytes, ctx) // a fresh pool serves the next tile
    release(samples)
    await slow
    expect(stats.terminated).toEqual([0])
  })

  it('retries the module load after it fails', async () => {
    let loads = 0
    const decode = createWsiTileDecoder(async () => {
      if (loads++ === 0) throw new TypeError('Failed to fetch module')
      return {
        decode: async () => samples,
      } as unknown as FrameDecoder
    })
    await expect(decode(bytes, ctx)).rejects.toThrow('Failed to fetch')
    expect(await decode(bytes, ctx)).toBe(samples as never)
  })
})

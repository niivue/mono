import { describe, expect, test } from 'bun:test'
import type { NVImage } from '@/NVTypes'
import { volumeUpdateScope } from '@/view/volumeUpdateScope'

function vol(id: string, modulationImage?: string): NVImage {
  return { id, modulationImage } as unknown as NVImage
}

describe('volumeUpdateScope', () => {
  test('a full update rebuilds everything', () => {
    const vols = [vol('bg'), vol('ov')]
    expect(volumeUpdateScope(vols, undefined, false)).toEqual({
      background: true,
      overlays: true,
    })
  })

  test('an edited overlay skips the background', () => {
    const vols = [vol('bg'), vol('ov')]
    expect(volumeUpdateScope(vols, [vols[1]], false)).toEqual({
      background: false,
      overlays: true,
    })
  })

  test('an edited background skips the overlays', () => {
    const vols = [vol('bg'), vol('ov')]
    expect(volumeUpdateScope(vols, [vols[0]], false)).toEqual({
      background: true,
      overlays: false,
    })
  })

  test('background masking makes a background edit redo the overlays', () => {
    const vols = [vol('bg'), vol('ov')]
    expect(volumeUpdateScope(vols, [vols[0]], true)).toEqual({
      background: true,
      overlays: true,
    })
  })

  test('a volume modulated by an edited volume is rebuilt', () => {
    const vols = [vol('bg', 'mask'), vol('mask')]
    expect(volumeUpdateScope(vols, [vols[1]], false)).toEqual({
      background: true,
      overlays: true,
    })
  })

  test('modulation is followed transitively', () => {
    const vols = [vol('bg', 'a'), vol('a', 'b'), vol('b')]
    expect(volumeUpdateScope(vols, [vols[2]], false).background).toBe(true)
  })

  test('an unrelated modulation link does not widen the scope', () => {
    const vols = [vol('bg', 'mask'), vol('mask'), vol('ov')]
    expect(volumeUpdateScope(vols, [vols[2]], false)).toEqual({
      background: false,
      overlays: true,
    })
  })
})

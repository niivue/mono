import { describe, expect, it } from 'bun:test'
import { joinFrames, split4D } from './frames4D'
import { isMip } from './hangingOptions'

// 2x1x1 voxels x 3 frames, int16, vox_offset 352.
function nifti4D(): File {
  const hdr = new DataView(new ArrayBuffer(352))
  hdr.setInt32(0, 348, true)
  for (const [i, d] of [4, 2, 1, 1, 3].entries())
    hdr.setInt16(40 + 2 * i, d, true)
  hdr.setInt16(70, 4, true)
  hdr.setInt16(72, 16, true)
  hdr.setFloat32(108, 352, true)
  return new File([hdr.buffer, new Int16Array([1, 2, 3, 4, 5, 6])], 'pt.nii')
}

describe('split4D', () => {
  it('serves frame t of a 4D NIfTI and writes frame 0 as a 3D file', async () => {
    const split = await split4D(nifti4D())
    expect(split?.frames.count).toBe(3)
    const frame = await split?.frames.load(2, new AbortController().signal)
    expect(Array.from(frame ?? [])).toEqual([5, 6])
    const head = new DataView(
      await (split as { image: File }).image.arrayBuffer(),
    )
    expect([head.getInt16(40, true), head.getInt16(48, true)]).toEqual([3, 1])
    expect([head.getInt16(352, true), head.getInt16(354, true)]).toEqual([1, 2])
  })
})

describe('isMip', () => {
  // The 4D demo's PT panes say MIP without a slab: cornerstone shows a slice.
  it('needs a full-volume slab', () => {
    expect(isMip([{ options: { blendMode: 'MIP' } }])).toBe(false)
    expect(
      isMip([{ options: { blendMode: 'MIP', slabThickness: 'fullVolume' } }]),
    ).toBe(true)
  })
})

describe('joinFrames', () => {
  it('starts the cine clock only once a pane shows a 4D series', () => {
    let scheduled = 0
    const raf = globalThis.requestAnimationFrame
    globalThis.requestAnimationFrame = () => ++scheduled
    const listeners: Record<string, () => void> = {}
    const nv = {
      volumes: [{}] as { frameSource?: object }[],
      addEventListener: (t: string, f: () => void) => {
        listeners[t] = f
      },
      removeEventListener: () => {},
    }
    const leave = joinFrames('p', nv as never, undefined, null)
    listeners.volumeLoaded?.()
    expect(scheduled).toBe(0)
    nv.volumes = [{ frameSource: { group: {}, frame: 0, count: 2 } }]
    listeners.volumeLoaded?.()
    expect(scheduled).toBe(1)
    leave()
    globalThis.requestAnimationFrame = raf
  })
})

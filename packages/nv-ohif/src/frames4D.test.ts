import { describe, expect, it } from 'bun:test'
import NiiVue from '@niivue/niivue'
import { joinFrames, onFrame, paneFrames, setFrame, split4D } from './frames4D'

// 2x1x1 voxels x 3 frames, int16, vox_offset 352.
function nifti4D(): File {
  const hdr = new DataView(new ArrayBuffer(352))
  hdr.setInt32(0, 348, true)
  for (const [i, d] of [4, 2, 1, 1, 3].entries())
    hdr.setInt16(40 + 2 * i, d, true)
  hdr.setInt16(70, 4, true)
  hdr.setInt16(72, 16, true)
  hdr.setFloat32(108, 352, true)
  for (const i of [1, 2, 3]) hdr.setFloat32(76 + 4 * i, 1, true)
  hdr.setUint32(344, 0x00312b6e, true) // magic 'n+1'
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

// Audit: a paused series joining a new fusion pane catches up asynchronously;
// the panel must read the caught-up frame, so Next steps forward.
it('late-pane catch-up updates the frame readout', async () => {
  globalThis.requestAnimationFrame ??= () => 0
  const split = (await split4D(nifti4D())) as NonNullable<
    Awaited<ReturnType<typeof split4D>>
  >
  const [pt, fusion] = [0, 1].map(() => {
    const nv = new NiiVue({ backend: 'webgl2' })
    nv.drawScene = () => {}
    return nv
  }) as [NiiVue, NiiVue]
  const leave = [
    joinFrames('pt', pt, undefined, null),
    joinFrames('fusion', fusion, undefined, null),
  ]
  await pt.loadVolumes([{ url: split.image, frameSource: split.frames }])
  await setFrame(split.frames.group, 1)
  await fusion.loadVolumes([{ url: split.image }])
  let shown = -1
  const off = onFrame(() => {
    shown = paneFrames('fusion')?.frame ?? -1
  })
  await fusion.addVolume({ url: split.image, frameSource: split.frames })
  await new Promise((r) => setTimeout(r, 30))
  expect(shown).toBe(1)
  await setFrame(split.frames.group, shown + 1) // Next
  expect(paneFrames('fusion')?.frame).toBe(2)
  off()
  for (const l of leave) l()
})

// A frame hotkey or graph click calls setFrame4D on one pane directly.
it('a frame NiiVue changes itself reaches every pane, late ones too', async () => {
  globalThis.requestAnimationFrame ??= () => 0
  const split = (await split4D(nifti4D())) as NonNullable<
    Awaited<ReturnType<typeof split4D>>
  >
  const [a, b, late] = [0, 1, 2].map(() => {
    const nv = new NiiVue({ backend: 'webgl2' })
    nv.drawScene = () => {}
    return nv
  }) as [NiiVue, NiiVue, NiiVue]
  const leave = [
    joinFrames('a', a, undefined, null),
    joinFrames('b', b, undefined, null),
  ]
  await a.loadVolumes([{ url: split.image, frameSource: split.frames }])
  await b.loadVolumes([{ url: split.image, frameSource: split.frames }])
  await a.setFrame4D(a.volumes[0]?.id as string, 2)
  await new Promise((r) => setTimeout(r, 30))
  expect(paneFrames('b')?.frame).toBe(2)
  leave.push(joinFrames('late', late, undefined, null))
  await late.loadVolumes([{ url: split.image, frameSource: split.frames }])
  await new Promise((r) => setTimeout(r, 30))
  expect(paneFrames('late')?.frame).toBe(2)
  for (const l of leave) l()
})

// The panel hides its frame controls once no pane shows a 4D series.
it('removing the last 4D volume notifies the panel', async () => {
  globalThis.requestAnimationFrame ??= () => 0
  const split = (await split4D(nifti4D())) as NonNullable<
    Awaited<ReturnType<typeof split4D>>
  >
  const nv = new NiiVue({ backend: 'webgl2' })
  nv.drawScene = () => {}
  const leave = joinFrames('solo', nv, undefined, null)
  await nv.loadVolumes([{ url: split.image, frameSource: split.frames }])
  let shown: unknown = 'stale'
  const off = onFrame(() => {
    shown = paneFrames('solo')
  })
  await nv.removeAllVolumes()
  off()
  leave()
  expect(shown).toBeUndefined()
})

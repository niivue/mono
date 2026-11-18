import { describe, expect, it } from 'bun:test'
import NiiVue from '@niivue/niivue'
import {
  isComputedShown,
  joinFrames,
  onFrame,
  paneFrames,
  setFrame,
  showComputed,
  showFrames,
  split4D,
} from './frames4D'

// 2x1x1 voxels x `frames` frames, int16, vox_offset 352.
function nifti4D(frames = 3, nx = 2, ny = 1): File {
  const hdr = new DataView(new ArrayBuffer(352))
  hdr.setInt32(0, 348, true)
  for (const [i, d] of [4, nx, ny, 1, frames].entries())
    hdr.setInt16(40 + 2 * i, d, true)
  hdr.setInt16(70, 4, true)
  hdr.setInt16(72, 16, true)
  hdr.setFloat32(108, 352, true)
  for (const i of [1, 2, 3]) hdr.setFloat32(76 + 4 * i, 1, true)
  hdr.setUint32(344, 0x00312b6e, true) // magic 'n+1'
  const data = Int16Array.from({ length: nx * ny * frames }, (_, i) => i + 1)
  return new File([hdr.buffer, data], 'pt.nii')
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

// A computed volume is requantized into the frame buffer with its own scaling.
// The playing cine must not step it (it would restore the frame mid-display),
// and the next frame step must restore the series' scaling.
it('shows a computed volume until the next frame step', async () => {
  let tick: FrameRequestCallback | undefined
  globalThis.requestAnimationFrame = (cb) => {
    tick = cb
    return 1
  }
  const paused: unknown[] = []
  const cineService = {
    getState: () => ({
      cines: { computed: { isPlaying: true, frameRate: 50 } },
    }),
    setCine: (c: unknown) => paused.push(c),
  }
  const split = (await split4D(nifti4D())) as NonNullable<
    Awaited<ReturnType<typeof split4D>>
  >
  const nv = new NiiVue({ backend: 'webgl2' })
  nv.drawScene = () => {}
  const leave = joinFrames('computed', nv, { services: { cineService } }, null)
  await nv.loadVolumes([{ url: split.image, frameSource: split.frames }])
  const v = nv.volumes[0] as NonNullable<(typeof nv.volumes)[0]>
  await showComputed(split.frames.group, Float32Array.from([10.5, -3]))
  expect(paused).toEqual([{ id: 'computed', isPlaying: false }])
  tick?.(performance.now() + 1000)
  await new Promise((r) => setTimeout(r, 10))
  const shown = Array.from(
    v.img ?? [],
    (r) => r * v.hdr.scl_slope + v.hdr.scl_inter,
  )
  expect(shown[0]).toBeCloseTo(10.5, 3)
  expect(shown[1]).toBeCloseTo(-3, 3)
  await setFrame(split.frames.group, 2)
  expect([v.hdr.scl_slope, ...Array.from(v.img ?? [])]).toEqual([1, 5, 6])
  leave()
})

const scaled = (nv: NiiVue) => {
  const v = nv.volumes[0] as NonNullable<(typeof nv.volumes)[0]>
  return Array.from(v.img ?? [], (r) => r * v.hdr.scl_slope + v.hdr.scl_inter)
}
const pane = () => {
  const nv = new NiiVue({ backend: 'webgl2' })
  nv.drawScene = () => {}
  return nv
}

// Audit 22.1: a frame step waiting on the GPU must not land over computed
// data. Audit 24.2: one pane finished that step, so returning to 4D must bring
// both panes to one frame.
it('a pending frame step does not overwrite a computed volume', async () => {
  globalThis.requestAnimationFrame = () => 0
  const split = (await split4D(nifti4D())) as NonNullable<
    Awaited<ReturnType<typeof split4D>>
  >
  const [done, nv] = [pane(), pane()]
  const leave = [
    joinFrames('done', done, undefined, null),
    joinFrames('pending', nv, undefined, null),
  ]
  for (const p of [done, nv])
    await p.loadVolumes([{ url: split.image, frameSource: split.frames }])
  let release = () => {}
  let updates = 0
  nv.view = {
    updateBindGroups: () =>
      ++updates === 1
        ? new Promise<void>((r) => {
            release = r
          })
        : Promise.resolve(),
  } as never
  const busy = nv.updateGLVolume()
  const step = setFrame(split.frames.group, 1)
  await new Promise((r) => setTimeout(r, 0))
  const frames = [done, nv].map((p) => p.volumes[0]?.frameSource?.frame)
  expect(frames).toEqual([1, 0])
  const computed = showComputed(split.frames.group, Float32Array.from([9, 12]))
  release()
  await Promise.all([busy, step, computed])
  expect(scaled(nv).map((x) => Math.round(x * 1e3) / 1e3)).toEqual([9, 12])
  await showFrames(split.frames.group)
  expect(scaled(nv)).toEqual(scaled(done))
  for (const l of leave) l()
})

it('a compute shown while frames restore stays shown', async () => {
  globalThis.requestAnimationFrame = () => 0
  const split = (await split4D(nifti4D())) as NonNullable<
    Awaited<ReturnType<typeof split4D>>
  >
  const nv = pane()
  const leave = joinFrames('slow', nv, undefined, null)
  await nv.loadVolumes([{ url: split.image, frameSource: split.frames }])
  await showComputed(split.frames.group, Float32Array.from([9, 12]))
  const load = split.frames.load
  let release = () => {}
  split.frames.load = async (f, signal) => {
    await new Promise<void>((r) => {
      release = r
    })
    return load(f, signal)
  }
  const restore = showFrames(split.frames.group)
  await showComputed(split.frames.group, Float32Array.from([50, 20]))
  release()
  await restore
  split.frames.load = load
  expect(scaled(nv).map((x) => Math.round(x * 1e3) / 1e3)).toEqual([50, 20])
  leave()
})

// Audit 22.2: a pane joining a computed series shows the computed volume and
// returns to the series' frame with its own scaling.
it('a pane joining while computed shows the computed volume', async () => {
  globalThis.requestAnimationFrame = () => 0
  const split = (await split4D(nifti4D())) as NonNullable<
    Awaited<ReturnType<typeof split4D>>
  >
  const [a, b] = [pane(), pane()]
  const leave = [
    joinFrames('first', a, undefined, null),
    joinFrames('late', b, undefined, null),
  ]
  await a.loadVolumes([{ url: split.image, frameSource: split.frames }])
  await setFrame(split.frames.group, 1)
  await showComputed(split.frames.group, Float32Array.from([9, 12]))
  await b.loadVolumes([{ url: split.image, frameSource: split.frames }])
  await new Promise((r) => setTimeout(r, 30))
  expect(scaled(b).map((x) => Math.round(x * 1e3) / 1e3)).toEqual([9, 12])
  await showFrames(split.frames.group)
  expect(scaled(b)).toEqual([3, 4])
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

it('an older compute does not overwrite a newer one on another pane', async () => {
  globalThis.requestAnimationFrame = () => 0
  const split = (await split4D(nifti4D())) as NonNullable<
    Awaited<ReturnType<typeof split4D>>
  >
  const [a, b] = [pane(), pane()]
  const leave = [
    joinFrames('older', a, undefined, null),
    joinFrames('newer', b, undefined, null),
  ]
  for (const p of [a, b])
    await p.loadVolumes([{ url: split.image, frameSource: split.frames }])
  const update = a.updateVolumeData.bind(a)
  let release = () => {}
  let held = true
  a.updateVolumeData = async (i, data) => {
    if (held) {
      held = false
      await new Promise<void>((r) => {
        release = r
      })
    }
    return update(i, data)
  }
  const older = showComputed(split.frames.group, Float32Array.from([1, 2]))
  await new Promise((r) => setTimeout(r, 0))
  const newer = showComputed(split.frames.group, Float32Array.from([10, 20]))
  release()
  await Promise.all([older, newer])
  const round = (nv: NiiVue) => scaled(nv).map((x) => Math.round(x * 1e3) / 1e3)
  expect([round(a), round(b)]).toEqual([
    [10, 20],
    [10, 20],
  ])
  for (const l of leave) l()
})

it('an older upload landing late does not overwrite a newer compute', async () => {
  globalThis.requestAnimationFrame = () => 0
  const split = (await split4D(nifti4D())) as NonNullable<
    Awaited<ReturnType<typeof split4D>>
  >
  const a = pane()
  const leave = joinFrames('late', a, undefined, null)
  await a.loadVolumes([{ url: split.image, frameSource: split.frames }])
  // Hold the computed upload, not the frame cancel's reload.
  a.setFrame4D = async () => {}
  const update = a.updateVolumeData.bind(a)
  let release = () => {}
  let held = true
  a.updateVolumeData = async (i, data) => {
    if (held) {
      held = false
      await new Promise<void>((r) => {
        release = r
      })
    }
    return update(i, data)
  }
  // Reversed order: two voxels otherwise quantize to the same raw pair.
  const older = showComputed(split.frames.group, Float32Array.from([2, 1]))
  await new Promise((r) => setTimeout(r, 0))
  const newer = showComputed(split.frames.group, Float32Array.from([10, 25]))
  await new Promise((r) => setTimeout(r, 0))
  release()
  await Promise.all([older, newer])
  expect(scaled(a).map((x) => Math.round(x * 1e3) / 1e3)).toEqual([10, 25])
  leave()
})

it('unmounting the last 4D pane notifies the panel', async () => {
  globalThis.requestAnimationFrame ??= () => 0
  const split = (await split4D(nifti4D())) as NonNullable<
    Awaited<ReturnType<typeof split4D>>
  >
  const nv = new NiiVue({ backend: 'webgl2' })
  nv.drawScene = () => {}
  const leave = joinFrames('gone', nv, undefined, null)
  await nv.loadVolumes([{ url: split.image, frameSource: split.frames }])
  let shown: unknown = 'stale'
  const off = onFrame(() => {
    shown = paneFrames('gone')
  })
  leave()
  off()
  expect(shown).toBeUndefined()
})

// The conversion cache evicts: a reconversion must rejoin the series' panes.
// Review of #855: a reopen after the last pane closed starts fresh instead.
it('a reconverted series rejoins its frame group while shown', async () => {
  globalThis.requestAnimationFrame ??= () => 0
  const split = async (series: string) =>
    (await split4D(nifti4D(), series)) as NonNullable<
      Awaited<ReturnType<typeof split4D>>
    >
  const first = await split('ds1')
  const nv = new NiiVue({ backend: 'webgl2' })
  nv.drawScene = () => {}
  const leave = joinFrames('rejoin', nv, undefined, null)
  await nv.loadVolumes([{ url: first.image, frameSource: first.frames }])
  await showComputed(first.frames.group, Float32Array.from([9, 12]))
  const shown = [
    (await split('ds1')).frames.group === first.frames.group,
    (await split('ds2')).frames.group === first.frames.group,
    // A refresh with another frame count steps on its own.
    (await split4D(nifti4D(2), 'ds1'))?.frames.group === first.frames.group,
    (await split4D(nifti4D(3, 4), 'ds1'))?.frames.group === first.frames.group,
    // Same voxel count (2x1x1 vs 1x2x1), other geometry.
    (await split4D(nifti4D(3, 1, 2), 'ds1'))?.frames.group ===
      first.frames.group,
  ]
  await nv.removeVolume(0)
  const afterRemove = (await split('ds1')).frames.group
  leave()
  const reopened = (await split('ds1')).frames.group
  expect(afterRemove).not.toBe(first.frames.group)
  expect([...shown, reopened === first.frames.group]).toEqual([
    true,
    false,
    false,
    false,
    false,
    false,
  ])
  expect(isComputedShown(reopened)).toBe(false)
})

// Review of #855: the group outlives its panes, so a shorter reload must not
// be sent the old series' frame.
it('a reload with fewer frames skips a frame it lacks', async () => {
  globalThis.requestAnimationFrame ??= () => 0
  const load = async () =>
    (await split4D(nifti4D(), 'ds-short')) as NonNullable<
      Awaited<ReturnType<typeof split4D>>
    >
  const pane = () => {
    const nv = new NiiVue({ backend: 'webgl2' })
    nv.drawScene = () => {}
    return nv
  }
  const first = await load()
  const a = pane()
  const leaveA = joinFrames('short-a', a, undefined, null)
  await a.loadVolumes([{ url: first.image, frameSource: first.frames }])
  await setFrame(first.frames.group, 2)
  leaveA()
  const second = await load()
  const b = pane()
  const asked: number[] = []
  const setFrame4D = b.setFrame4D.bind(b)
  b.setFrame4D = (id, f) => {
    asked.push(f)
    return setFrame4D(id, f)
  }
  const leaveB = joinFrames('short-b', b, undefined, null)
  await b.loadVolumes([
    { url: second.image, frameSource: { ...second.frames, count: 2 } },
  ])
  await new Promise((r) => setTimeout(r, 30))
  expect(asked).toEqual([])
  leaveB()
})

// Review of #855: loadVolumes emits volumeRemoved before its swap lands, so a
// series switched in must keep its group for a later reconversion.
it('a series switched into a pane keeps its frame group', async () => {
  globalThis.requestAnimationFrame ??= () => 0
  const split = async (series: string) =>
    (await split4D(nifti4D(), series)) as NonNullable<
      Awaited<ReturnType<typeof split4D>>
    >
  const nv = new NiiVue({ backend: 'webgl2' })
  nv.drawScene = () => {}
  const leave = joinFrames('switch', nv, undefined, null)
  const old = await split('switch-old')
  await nv.loadVolumes([{ url: old.image, frameSource: old.frames }])
  const fresh = await split('switch-fresh')
  await nv.loadVolumes([{ url: fresh.image, frameSource: fresh.frames }])
  const again = (await split('switch-fresh')).frames.group
  leave()
  expect(again).toBe(fresh.frames.group)
})

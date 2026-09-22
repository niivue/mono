import { describe, expect, test } from 'bun:test'
import {
  type ApiVolume,
  type Dataset,
  groupDatasets,
  hollowMask,
  isLoadableHere,
  isSegChannel,
  matchesFamily,
  opacityFor,
  percentileWindow,
  SerialLoadQueue,
  suggestedOpacity,
} from './microscopy-core'

function vol(overrides: Partial<ApiVolume> & { id: string }): ApiVolume {
  return {
    format: 'allen-atlas',
    shape: [4, 4, 4],
    dtype: 'uint8',
    spacing: [1, 1, 1],
    channel: null,
    channelName: null,
    dataset: 'set',
    ...overrides,
  }
}

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms))

describe('SerialLoadQueue', () => {
  // The regression this queue exists for: an older load whose network phase
  // outlives a newer one. With a bare token, the old load's loadVolumes would
  // commit LAST and the screen would show the superseded selection. Here the
  // viewer double records every mutation so the final state is provable.
  test('a slow older load cannot overwrite a newer selection', async () => {
    const queue = new SerialLoadQueue()
    const viewer = {
      volumes: [] as string[],
      loaded: [] as string[],
      windows: new Map<string, number>(),
      status: '',
    }
    const runLoad =
      (name: string, networkMs: number) =>
      async (isCurrent: () => boolean): Promise<void> => {
        viewer.status = `loading ${name}`
        await delay(networkMs) // the nv.loadVolumes phase
        viewer.volumes = [name] // loadVolumes mutates the shared viewer
        if (!isCurrent()) return // superseded: skip the bookkeeping
        viewer.loaded = [name]
        viewer.windows.clear()
        viewer.windows.set(name, 1)
        viewer.status = ''
      }

    // Old load is slow (50 ms of "network"); new load is fast (1 ms) and is
    // scheduled while the old one is still queued/running.
    const first = queue.schedule(runLoad('old', 50))
    const second = queue.schedule(runLoad('new', 1))
    await Promise.all([first, second])

    expect(viewer.volumes).toEqual(['new'])
    expect(viewer.loaded).toEqual(['new'])
    expect([...viewer.windows.keys()]).toEqual(['new'])
    expect(viewer.status).toBe('')
  })

  test('a load superseded while queued never runs at all', async () => {
    const queue = new SerialLoadQueue()
    const ran: string[] = []
    const task = (name: string, ms: number) => async () => {
      ran.push(name)
      await delay(ms)
    }
    const a = queue.schedule(task('a', 20))
    await delay(0) // let a START before newer loads arrive
    const b = queue.schedule(task('b', 1)) // superseded by c before its turn
    const c = queue.schedule(task('c', 1))
    await Promise.all([a, b, c])
    // a was current when it started; b went stale while queued; c ran.
    expect(ran).toEqual(['a', 'c'])
  })

  test('a load superseded while running skips its commit phase', async () => {
    const queue = new SerialLoadQueue()
    const commits: string[] = []
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const first = queue.schedule(async (isCurrent) => {
      await gate // now schedule the second load while this one runs
      if (isCurrent()) commits.push('first')
    })
    const second = queue.schedule(async (isCurrent) => {
      if (isCurrent()) commits.push('second')
    })
    release()
    await Promise.all([first, second])
    expect(commits).toEqual(['second'])
  })

  test('a rejected load does not break the chain', async () => {
    const queue = new SerialLoadQueue()
    const ran: string[] = []
    const failing = queue.schedule(async () => {
      throw new Error('load failed')
    })
    await expect(failing).rejects.toThrow('load failed')
    await queue.schedule(async () => {
      ran.push('after')
    })
    expect(ran).toEqual(['after'])
  })
})

describe('dataset grouping and filtering', () => {
  test('groups by dataset key, sorts channels and keys', () => {
    const datasets = groupDatasets([
      vol({ id: 'b1', dataset: 'b', channel: 1 }),
      vol({ id: 'a0', dataset: 'a', channel: 0 }),
      vol({ id: 'b0', dataset: 'b', channel: 0 }),
    ])
    expect(datasets.map((d) => d.key)).toEqual(['a', 'b'])
    expect(datasets[1].channels.map((c) => c.id)).toEqual(['b0', 'b1'])
    expect(datasets[0].shape).toEqual([4, 4, 4])
  })

  test('family filtering keys on the _seg suffix alone', () => {
    const raw = vol({ id: 'r', channelName: 'TUBA1B_71126_raw' })
    const seg = vol({ id: 's', channelName: 'TUBA1B_71126_seg' })
    const bare = vol({ id: 'b', channelName: null })
    expect(isSegChannel(seg)).toBe(true)
    expect(isSegChannel(raw)).toBe(false)
    expect(matchesFamily(seg, 'seg')).toBe(true)
    expect(matchesFamily(seg, 'raw')).toBe(false)
    expect(matchesFamily(bare, 'raw')).toBe(true)
    expect(matchesFamily(raw, 'all')).toBe(true)
  })

  test('loadability: nifti never, size caps everything else', () => {
    const base: Dataset = {
      key: 'k',
      format: 'allen-atlas',
      shape: [100, 100, 100],
      spacing: [1, 1, 1],
      channels: [vol({ id: 'only' })],
    }
    expect(isLoadableHere(base)).toBe(true)
    expect(isLoadableHere({ ...base, format: 'nifti' })).toBe(false)
    expect(isLoadableHere({ ...base, shape: [1000, 1000, 1000] })).toBe(false)
    // Channel count must not bypass the cap: the page auto-loads channels on
    // open, so an oversize multi-channel source would fire N huge requests.
    expect(
      isLoadableHere({
        ...base,
        shape: [1000, 1000, 1000],
        channels: [vol({ id: 'c0' }), vol({ id: 'c1' })],
      }),
    ).toBe(false)
    expect(
      isLoadableHere({
        ...base,
        channels: [vol({ id: 'c0' }), vol({ id: 'c1' })],
      }),
    ).toBe(true)
  })
})

describe('percentileWindow', () => {
  test('brackets the requested top fractions of voxels', () => {
    // 100 voxels: 90 at 0, 9 at 128, 1 at 255.
    const img = new Uint8Array(100)
    img.fill(128, 90, 99)
    img[99] = 255
    const win = percentileWindow(img, 0, 255, 0.1, 0.01)
    // Walking from the bright end: the top 1% is the single 255 voxel, the
    // top 10% is reached inside the 128 bin.
    expect(win.calMax).toBe(255)
    expect(win.calMin).toBe(128)
  })

  test('a flat channel does not collapse to a zero-width window', () => {
    const img = new Uint8Array(64).fill(7)
    const win = percentileWindow(img, 7, 42, 0.015, 0.001)
    expect(win.calMax).toBeGreaterThan(win.calMin)
  })

  test('a top-clipped channel does not collapse to a zero-width window', () => {
    // 1000 voxels with 30 pinned at max (clipped saturation): both the high
    // and low crossings land in the TOP bin, so calMin reaches max and the
    // guard must reset both ends, not just calMax.
    const img = new Uint8Array(1000)
    for (let i = 0; i < 970; i++) img[i] = 126 + (i % 75)
    img.fill(255, 970)
    const win = percentileWindow(img, 0, 255, 0.015, 0.001)
    expect(win.calMax).toBeGreaterThan(win.calMin)
    expect(win.calMin).toBe(0)
    expect(win.calMax).toBe(255)
  })

  test('a zero range returns the range unchanged', () => {
    const img = new Uint8Array(8)
    expect(percentileWindow(img, 5, 5, 0.1, 0.01)).toEqual({
      calMin: 5,
      calMax: 5,
    })
  })
})

describe('hollowMask', () => {
  test('keeps the shell, resets the interior to the floor, copies the array', () => {
    // 3x3x3 solid of 9s over floor 1: only the centre voxel is interior.
    const img = new Uint8Array(27).fill(9)
    const out = hollowMask(img, [3, 3, 3], 1)
    expect(out).not.toBe(img)
    expect(img[13]).toBe(9) // source untouched
    expect(out[13]).toBe(1) // centre hollowed to the floor
    expect([...out].filter((v) => v === 9)).toHaveLength(26)
  })

  test('a structure clipped by the volume face stays closed', () => {
    // 2x2x2 solid: every voxel touches a face, so nothing is interior.
    const img = new Uint8Array(8).fill(5)
    const out = hollowMask(img, [2, 2, 2], 0)
    expect([...out]).toEqual([...img])
  })
})

describe('opacity policy', () => {
  const raw = vol({ id: 'r', channelName: 'x_raw' })
  const seg = vol({ id: 's', channelName: 'x_seg' })

  test('base layer is opaque only when it is not a mask', () => {
    expect(opacityFor(raw, 0, 0.6, false)).toBe(1)
    expect(opacityFor(raw, 1, 0.6, false)).toBe(0.6)
    expect(opacityFor(seg, 0, 0.6, false)).toBe(0.3)
    expect(opacityFor(seg, 0, 0.6, true)).toBe(0.6)
    expect(opacityFor(undefined, 0, 0.6, false)).toBe(1)
  })

  test('suggested opacity scales down with channel count', () => {
    expect(suggestedOpacity([raw], false)).toBe(0.6)
    expect(suggestedOpacity([raw, seg], false)).toBe(0.6)
    const sixteen = Array.from({ length: 16 }, (_u, i) =>
      vol({ id: `c${i}`, channelName: `g${i}_raw` }),
    )
    // 1.2/16 = 0.075 is below the floor; the floor wins.
    expect(suggestedOpacity(sixteen, false)).toBeCloseTo(0.12, 5)
    // A hollowed all-seg stack keeps the two-channel default.
    const segs = Array.from({ length: 8 }, (_u, i) =>
      vol({ id: `s${i}`, channelName: `g${i}_seg` }),
    )
    expect(suggestedOpacity(segs, true)).toBe(0.6)
    expect(suggestedOpacity(segs, false)).toBeCloseTo(1.2 / 8, 5)
  })
})

import { afterEach, expect, test } from 'bun:test'
import NiiVue, {
  type ChunkedVolumeSource,
  NiiDataType,
  type NVChunkedVolume,
} from '@/index'
import type { NVImage } from '@/NVTypes'
import { chunkedVolumeBudgets } from '@/volume/NVChunkedVolume'

const defaultBudgets = { ...chunkedVolumeBudgets }
afterEach(() => Object.assign(chunkedVolumeBudgets, defaultBudgets))

// Lazy time on a streamed volume (VOL-01): a synthetic `frames` source whose
// voxels hold 100 * frame + channel.

const SHAPE: [number, number, number] = [8, 8, 8]

type Read = { frame: number; signal?: AbortSignal; level: number }

function source(
  c: number,
  opts: {
    frames?: number
    reads?: Read[]
    gate?: (frame: number) => Promise<void> | undefined
  } = {},
): ChunkedVolumeSource {
  return {
    levels: [
      { level: 0, shape: SHAPE, spacing: [1, 1, 1] },
      { level: 1, shape: [4, 4, 4], spacing: [2, 2, 2] },
    ],
    datatypeCode: NiiDataType.DT_UINT8,
    frames: opts.frames ?? 3,
    async fetchChunk({ texDims, frame = 0, signal, levelIndex }) {
      opts.reads?.push({ frame, signal, level: levelIndex })
      await opts.gate?.(frame)
      signal?.throwIfAborted()
      return new Uint8Array(texDims[0] * texDims[1] * texDims[2]).fill(
        100 * frame + c,
      )
    },
  }
}

/** Settle every pending promise chain (the synthetic sources resolve at once). */
const flush = () => new Promise((r) => setImmediate(r))

const until = async (ok: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !ok(); i++) await flush()
  if (!ok()) throw new Error('timed out')
}

/** Bytes the scene volume's current chunk source serves for brick 0. */
async function brickValue(vol: NVImage, bytesPerVoxel = 1): Promise<number> {
  const desc = vol.chunkPlan?.chunks[0]
  if (!desc || !vol.chunkSource) throw new Error('not streamed')
  const bytes = await vol.chunkSource({ desc, bytesPerVoxel } as Parameters<
    NonNullable<NVImage['chunkSource']>
  >[0])
  return new Uint8Array(bytes as Uint8Array)[0]
}

test('E1: a frames:3 source reads frame 2 after setFrame', async () => {
  const reads: Read[] = []
  const nv = new NiiVue({ backend: 'webgl2' })
  const chunked = await nv.loadChunkedVolume(source(0, { reads }), {
    coarseFloor: false,
  })
  expect(chunked.frames).toBe(3)
  await chunked.setFrame(2)
  expect(chunked.frame).toBe(2)
  expect(nv.getFrame4D(chunked.id)).toBe(2)
  expect(await brickValue(nv.volumes[0])).toBe(200)
  expect(reads.some((r) => r.frame === 2)).toBe(true)
  const { buildLocationMessage } = await import('@/control/locationTracking')
  const msg = buildLocationMessage(
    nv as unknown as Parameters<typeof buildLocationMessage>[0],
    0,
  )
  expect(msg?.string).toMatch(/×2 = /)
  // Clamped to the frame count.
  await chunked.setFrame(99)
  expect(chunked.frame).toBe(2)
})

test('a frame group switches together, after every member has its bricks', async () => {
  const group = {}
  let release: () => void = () => {}
  const gated = new Promise<void>((r) => {
    release = r
  })
  const nv = new NiiVue({ backend: 'webgl2' })
  const a = await nv.loadChunkedVolume(source(1), { frameGroup: group })
  const bReads: Read[] = []
  const b = await nv.loadChunkedVolume(
    source(2, { reads: bReads, gate: (f) => (f === 1 ? gated : undefined) }),
    { frameGroup: group },
  )
  const changes: string[] = []
  nv.addEventListener('frameChange', (e) =>
    changes.push(`${e.detail.volume.id}:${e.detail.frame}`),
  )
  const sources = nv.volumes.map((v) => v.chunkSource)
  const pending = a.setFrame(1)
  await until(() => bReads.some((r) => r.frame === 1))
  await flush()
  // b is still fetching: nothing committed, a included.
  expect(nv.volumes.map((v) => v.chunkSource)).toEqual(sources)
  expect(a.frame).toBe(0)
  release()
  await pending
  expect([a.frame, b.frame]).toEqual([1, 1])
  expect(await brickValue(nv.volumes[0])).toBe(101)
  expect(await brickValue(nv.volumes[1])).toBe(102)
  expect(changes).toEqual([`${a.id}:1`, `${b.id}:1`])
  // The floor moved with the frame: the pick sampler reads frame 1 voxels.
  expect(nv.volumes[0].pickSampler?.(4, 4, 4)).toBeGreaterThan(0)
})

test('the newest request wins and aborts the superseded reads', async () => {
  const reads: Read[] = []
  const nv = new NiiVue({ backend: 'webgl2' })
  // Frame 1 reads hang until aborted, as a slow network read that honours its signal.
  const src = source(0, { reads })
  const fetch = src.fetchChunk.bind(src)
  src.fetchChunk = (req) =>
    req.frame === 1
      ? new Promise((_, reject) => {
          reads.push({ frame: 1, signal: req.signal, level: req.levelIndex })
          req.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          )
        })
      : fetch(req)
  const chunked = await nv.loadChunkedVolume(src, {
    coarseFloor: false,
    maxConcurrentLoads: 2,
  })
  const first = chunked.setFrame(1)
  await until(() => reads.some((r) => r.frame === 1))
  await flush()
  // Bounded: no more than maxConcurrentLoads frame-1 reads ever started.
  expect(reads.filter((r) => r.frame === 1).length).toBeLessThanOrEqual(2)
  await chunked.setFrame(2)
  await first
  expect(chunked.frame).toBe(2)
  expect(
    reads.filter((r) => r.frame === 1).every((r) => r.signal?.aborted),
  ).toBe(true)
  expect(await brickValue(nv.volumes[0])).toBe(200)
})

test('a failed frame fetch rejects and keeps the shown frame', async () => {
  const nv = new NiiVue({ backend: 'webgl2' })
  const src = source(0)
  const fetch = src.fetchChunk.bind(src)
  src.fetchChunk = (req) =>
    req.frame === 2 ? Promise.reject(new Error('gone')) : fetch(req)
  const chunked = await nv.loadChunkedVolume(src, { coarseFloor: false })
  const before = nv.volumes[0].chunkSource
  await expect(chunked.setFrame(2)).rejects.toThrow('gone')
  expect(chunked.frame).toBe(0)
  expect(nv.volumes[0].chunkSource).toBe(before)
})

test('staging is bounded by the frame staging budget, nearest the focus first', async () => {
  const reads: Read[] = []
  const nv = new NiiVue({ backend: 'webgl2', maxTextureDimension3D: 8 })
  chunkedVolumeBudgets.frameStagingBytes = 1
  const chunked = await nv.loadChunkedVolume(source(0, { reads }), {
    coarseFloor: false,
  })
  expect(chunked.currentPlan.chunks.length).toBeGreaterThan(1)
  await chunked.setFrame(1)
  // One brick at least, never the whole plan when it has more than one
  // (level 1 is the window probe's re-read).
  const staged = reads.filter((r) => r.frame === 1 && r.level === 0).length
  expect(staged).toBe(1)
})

test('readout: exact uint32 label IDs from the finest decoded brick, per frame', async () => {
  const nv = new NiiVue({ backend: 'webgl2' })
  const src: ChunkedVolumeSource = {
    levels: [{ level: 0, shape: SHAPE, spacing: [1, 1, 1] }],
    datatypeCode: NiiDataType.DT_UINT32,
    frames: 2,
    async fetchChunk({ texDims, frame = 0 }) {
      const out = new Uint32Array(texDims[0] * texDims[1] * texDims[2])
      out.fill(frame ? 16777217 : 70000)
      return new Uint8Array(out.buffer)
    },
  }
  const chunked = await nv.loadChunkedVolume(src, {
    colormap: 'Random',
    coarseFloor: false,
  })
  // Bricks reach the readout as the renderer would stream them.
  await brickValue(nv.volumes[0], 4)
  const { getVoxelValue } = await import('@/volume/utils')
  expect(getVoxelValue(nv.volumes[0], 3, 3, 3)).toBe(70000)
  await chunked.setFrame(1)
  // 2^24 + 1 survives: integer IDs are never routed through float32.
  expect(getVoxelValue(nv.volumes[0], 3, 3, 3)).toBe(16777217)
  expect(nv.getFrame4D(chunked.id)).toBe(1)
})

test('a label channel whose dtype reaches the GPU as float is rejected', async () => {
  const nv = new NiiVue({ backend: 'webgl2' })
  const src = { ...source(0), datatypeCode: NiiDataType.DT_FLOAT64 }
  await expect(
    nv.loadChunkedVolume(src, { colormap: 'Random' }),
  ).rejects.toThrow('2^24')
})

test('the view floor follows every switch, back and forth', async () => {
  const nv = new NiiVue({ backend: 'webgl2' })
  const chunked = await nv.loadChunkedVolume(source(4))
  const floorValue = () => nv._baseCoarseFloor?.img?.[0]
  expect(floorValue()).toBe(4)
  await chunked.setFrame(1)
  expect(floorValue()).toBe(104)
  const pending = chunked.setFrame(2)
  await chunked.setFrame(0)
  await pending
  expect([chunked.frame, floorValue()]).toEqual([0, 4])
  await chunked.setFrame(2)
  expect(floorValue()).toBe(204)
})

test('P1: the readout holds the whole plan (over 32 MiB), exact at the focus', async () => {
  const nv = new NiiVue({ backend: 'webgl2' })
  const src: ChunkedVolumeSource = {
    levels: [{ level: 0, shape: [384, 384, 384], spacing: [1, 1, 1] }],
    datatypeCode: NiiDataType.DT_UINT8,
    async fetchChunk({ texDims }) {
      return new Uint8Array(texDims[0] * texDims[1] * texDims[2]).fill(7)
    },
  }
  const chunked = await nv.loadChunkedVolume(src, {
    coarseFloor: false,
    calMin: 0,
    calMax: 255,
  })
  const vol = nv.volumes[0]
  const plan = chunked.currentPlan
  const at = (c: (typeof plan.chunks)[number]) =>
    c.voxelOrigin.map((o, i) => o + c.voxelDims[i] / 2)
  const focus = [192, 192, 192]
  const d = (c: (typeof plan.chunks)[number]) =>
    at(c).reduce((s, v, i) => s + (v - focus[i]) ** 2, 0)
  // Stream nearest-first, as the renderer does: the focus brick is the oldest.
  const order = [...plan.chunks.keys()].sort(
    (a, b) => d(plan.chunks[a]) - d(plan.chunks[b]),
  )
  let bytes = 0
  for (const i of order) {
    const desc = plan.chunks[i]
    await vol.chunkSource?.({ desc, bytesPerVoxel: 1 } as Parameters<
      NonNullable<NVImage['chunkSource']>
    >[0])
    bytes += desc.texDims[0] * desc.texDims[1] * desc.texDims[2]
  }
  expect(bytes).toBeGreaterThan(32 * 1024 ** 2)
  expect(vol.voxelValue?.(192, 192, 192)).toEqual({ value: 7, exact: true })
})

test('P1: no brick reads the floor, flagged approximate; staged bricks stay out', async () => {
  const gate = { open: () => {} }
  const opened = new Promise<void>((r) => {
    gate.open = r
  })
  const nv = new NiiVue({ backend: 'webgl2' })
  const chunked = await nv.loadChunkedVolume(
    source(3, { gate: (f) => (f === 1 ? opened : undefined) }),
  )
  const vol = nv.volumes[0]
  // Nothing decoded but the floor: approximate, never NaN.
  expect(vol.voxelValue?.(4, 4, 4)).toEqual({ value: 3, exact: false })
  const { buildLocationMessage } = await import('@/control/locationTracking')
  const msg = buildLocationMessage(
    nv as unknown as Parameters<typeof buildLocationMessage>[0],
    0,
  )
  expect(msg?.values[0].approximate).toBe(true)
  expect(msg?.string).toContain('= ~3')
  await brickValue(vol)
  expect(vol.voxelValue?.(0, 0, 0)).toEqual({ value: 3, exact: true })
  // A switch whose reads are in but whose group is still loading: its
  // staged bricks are not the shown frame's.
  let openB = () => {}
  const openedB = new Promise<void>((r) => {
    openB = r
  })
  await nv.loadChunkedVolume(
    source(9, { gate: (f) => (f === 1 ? openedB : undefined) }),
    { frameGroup: chunked.volume.frameSource?.group },
  )
  const pending = chunked.setFrame(1)
  gate.open()
  await until(() => (chunked as unknown as { staged: unknown }).staged !== null)
  expect(vol.voxelValue?.(0, 0, 0)).toEqual({ value: 3, exact: true })
  openB()
  await pending
  expect(vol.voxelValue?.(0, 0, 0)).toEqual({ value: 103, exact: true })
})

test('P2: an aborted switch keeps no staged bytes; a failed member aborts its siblings', async () => {
  const group = {}
  const aborted: number[] = []
  const nv = new NiiVue({ backend: 'webgl2' })
  const hang = source(1)
  hang.fetchChunk = (req) =>
    new Promise((_, reject) =>
      req.signal?.addEventListener('abort', () => {
        aborted.push(req.frame ?? 0)
        reject(new DOMException('aborted', 'AbortError'))
      }),
    )
  const fail = source(2)
  const fetchFail = fail.fetchChunk.bind(fail)
  fail.fetchChunk = (req) =>
    req.frame === 1 ? Promise.reject(new Error('gone')) : fetchFail(req)
  const ok = await nv.loadChunkedVolume(source(0), {
    frameGroup: group,
    coarseFloor: false,
  })
  // Loaded with frame 0 served; only frame-1 reads hang.
  const fetchHang = source(1).fetchChunk
  const hanging = hang.fetchChunk
  hang.fetchChunk = (req) => (req.frame ? hanging(req) : fetchHang(req))
  await nv.loadChunkedVolume(hang, { frameGroup: group, coarseFloor: false })
  await nv.loadChunkedVolume(fail, { frameGroup: group, coarseFloor: false })
  await expect(ok.setFrame(1)).rejects.toThrow('gone')
  expect(aborted.length).toBeGreaterThan(0)
  expect((ok as unknown as { staged: unknown }).staged).toBeNull()
  expect(ok.frame).toBe(0)
})

test('P2: the staging budget is for the whole group, floor included', async () => {
  const stagedReads = async (members: number, budget: number) => {
    const group = {}
    const reads: Read[] = []
    const nv = new NiiVue({ backend: 'webgl2', maxTextureDimension3D: 8 })
    const handles = []
    chunkedVolumeBudgets.frameStagingBytes = budget
    for (let c = 0; c < members; c++)
      handles.push(
        await nv.loadChunkedVolume(source(c, { reads }), { frameGroup: group }),
      )
    const brick = handles[0].currentPlan.chunks[0].texDims
    reads.length = 0
    await handles[0].setFrame(1)
    const fine = reads.filter((r) => r.frame === 1 && r.level === 0).length
    return { fine, brick: brick[0] * brick[1] * brick[2] }
  }
  const { brick } = await stagedReads(1, 1)
  // The 4^3 floor plus four bricks, for the group as a whole.
  const budget = 64 + 4 * brick
  const alone = await stagedReads(1, budget)
  const pair = await stagedReads(2, budget)
  expect(alone.fine).toBe(4)
  expect(pair.fine).toBe(2)
})

test('the readout cap is shared by every streamed volume of the viewer', async () => {
  // 256x128x128 u8 in two 128^3 bricks (about 2.2 MB each with the halo).
  const src = (): ChunkedVolumeSource => ({
    levels: [{ level: 0, shape: [256, 128, 128], spacing: [1, 1, 1] }],
    datatypeCode: NiiDataType.DT_UINT8,
    async fetchChunk({ texDims }) {
      return new Uint8Array(texDims[0] * texDims[1] * texDims[2]).fill(5)
    },
  })
  const readoutBytes = 5e6
  chunkedVolumeBudgets.readoutBytes = readoutBytes
  const opts = { coarseFloor: false, calMin: 0, calMax: 9 }
  const nv = new NiiVue({ backend: 'webgl2' })
  const fill = async (handle: NVChunkedVolume) => {
    const vol = nv.volumes.find((v) => v.id === handle.id)
    expect(handle.currentPlan.chunks.length).toBe(2)
    for (const desc of handle.currentPlan.chunks)
      await vol?.chunkSource?.({ desc, bytesPerVoxel: 1 } as Parameters<
        NonNullable<NVImage['chunkSource']>
      >[0])
  }
  const held = (h: NVChunkedVolume) =>
    (h as unknown as { readout: { bytes: number } }).readout.bytes
  const a = await nv.loadChunkedVolume(src(), opts)
  await fill(a)
  // Alone: both bricks fit.
  const c = a.currentPlan.chunks[0]
  expect(nv.volumes[0].voxelValue?.(c.voxelOrigin[0], 1, 1).exact).toBe(true)
  // A second volume added later shrinks the first one's share.
  const b = await nv.loadChunkedVolume(src(), opts)
  await fill(b)
  expect(held(a) + held(b)).toBeLessThanOrEqual(readoutBytes)
})

test('staged bricks a refocus leaves out are released', async () => {
  const nv = new NiiVue({ backend: 'webgl2', maxTextureDimension3D: 8 })
  chunkedVolumeBudgets.frameStagingBytes = 1e9
  const chunked = await nv.loadChunkedVolume(source(0), {
    coarseFloor: false,
    focus: [0.1, 0.1, 0.1],
  })
  await chunked.setFrame(1)
  const served = () =>
    (chunked as unknown as { servedBricks: Map<string, unknown> }).servedBricks
      .size
  expect(served()).toBe(chunked.currentPlan.chunks.length)
  await chunked.setMaxDetail(1)
  const keys = new Set(
    chunked.currentPlan.chunks.map(
      (c) =>
        `${c.sourceLevel ?? 0}|${c.texOrigin.join(',')}|${c.texDims.join(',')}`,
    ),
  )
  const left = [
    ...(
      chunked as unknown as { servedBricks: Map<string, unknown> }
    ).servedBricks.keys(),
  ]
  expect(left.every((k) => keys.has(k))).toBe(true)
})

test('a switch before the first floor lands shows the target frame floor, never the late frame-0 one', async () => {
  const reads: Read[] = []
  let release: () => void = () => {}
  const gated = new Promise<void>((r) => {
    release = r
  })
  const nv = new NiiVue({ backend: 'webgl2' })
  const loading = nv.loadChunkedVolume(
    source(1, {
      reads,
      frames: 2,
      gate: (f) => (f === 0 && reads.at(-1)?.level === 1 ? gated : undefined),
    }),
  )
  await until(() => reads.some((r) => r.level === 1 && r.frame === 0))
  const id = nv.volumes[0].id ?? ''
  const switching = nv.setFrame4D(id, 1)
  await flush()
  release()
  await switching
  const chunked = await loading
  expect(chunked.frame).toBe(1)
  const sample = chunked.histogramSample
  expect([sample?.frame, sample?.image.img?.[0]]).toEqual([1, 101])
  expect(nv._baseCoarseFloor?.img?.[0]).toBe(101)
})

test('an aborted staged frame does not widen the label palette', async () => {
  const nv = new NiiVue({ backend: 'webgl2' })
  let release: () => void = () => {}
  const gated = new Promise<void>((r) => {
    release = r
  })
  const reads: number[] = []
  let late = 0
  const src: ChunkedVolumeSource = {
    levels: [{ level: 0, shape: SHAPE, spacing: [1, 1, 1] }],
    datatypeCode: NiiDataType.DT_UINT16,
    frames: 3,
    // Ignores its signal: frame 1's bytes arrive after it was superseded.
    async fetchChunk({ texDims, frame = 0 }) {
      reads.push(frame)
      if (frame === 1) {
        await gated
        late++
      }
      return new Uint8Array(
        new Uint16Array(texDims[0] * texDims[1] * texDims[2]).fill(
          frame === 1 ? 1000 : 3,
        ).buffer,
      )
    },
  }
  const chunked = await nv.loadChunkedVolume(src, {
    coarseFloor: false,
    colormap: 'random',
    calMin: 0,
    calMax: 10,
  })
  const first = chunked.setFrame(1)
  await until(() => reads.includes(1))
  const second = chunked.setFrame(2)
  release()
  await Promise.all([first, second])
  // Late bytes in, and any palette growth they scheduled applied.
  await until(
    () =>
      late === reads.filter((f) => f === 1).length &&
      (chunked as unknown as { labelGrowHandle: unknown }).labelGrowHandle ===
        null,
  )
  expect(chunked.frame).toBe(2)
  expect(nv.volumes[0].colormapLabel?.max).toBe(255)
})

test('without a floor, the histogram sample follows the shown frame', async () => {
  const nv = new NiiVue({ backend: 'webgl2' })
  const chunked = await nv.loadChunkedVolume(source(1, { frames: 2 }), {
    coarseFloor: false,
  })
  expect(chunked.histogramSample?.frame).toBe(0)
  await chunked.setFrame(1)
  const sample = chunked.histogramSample
  expect([sample?.frame, sample?.image.img?.[0]]).toEqual([1, 101])
  await nv.recalculateCalMinMax(0)
  expect(nv.volumes[0].calMax).toBe(101)
})

test('a switch during the first floor install never draws the frame-0 floor under frame t bricks', async () => {
  const nv = new NiiVue({ backend: 'webgl2' })
  // A stand-in view: the floor lands after a slow upload, bricks on a pass.
  let viewFloor: NVImage | null = null
  let bricksFrame = 0
  const drawn: string[] = []
  // The first floor upload lands only when the test releases it.
  let releaseFirst: (() => void) | null = null
  const view: Record<string, unknown> = {
    setCoarseFloor: async (f: NVImage | null) => {
      if (!viewFloor && f)
        await new Promise<void>((r) => {
          releaseFirst = r
        })
      viewFloor = f
    },
    updateBindGroups: async (opts: { coarseFloor?: NVImage | null }) => {
      if ('coarseFloor' in opts) viewFloor = opts.coarseFloor ?? null
      bricksFrame = nv.volumes[0]?.frameSource?.frame ?? 0
    },
  }
  nv.view = new Proxy(view, {
    get: (t, k) =>
      k in t ? t[k as string] : k === 'then' ? undefined : () => {},
  }) as never
  nv.drawScene = () => {
    if (viewFloor?.img) drawn.push(`${viewFloor.img[0]}@${bricksFrame}`)
  }
  const reads: Read[] = []
  const loading = nv.loadChunkedVolume(source(1, { reads, frames: 2 }))
  await until(() => reads.some((r) => r.level === 1 && r.frame === 0))
  const id = nv.volumes[0].id ?? ''
  // The floor upload is in flight: start the switch now.
  await until(() => releaseFirst !== null)
  const switching = nv.setFrame4D(id, 1)
  await until(() => reads.some((r) => r.frame === 1))
  await flush()
  ;(releaseFirst as unknown as () => void)()
  const chunked = await loading
  await switching
  expect(chunked.frame).toBe(1)
  expect(drawn.length).toBeGreaterThan(0)
  for (const d of drawn) expect(['1@0', '101@1']).toContain(d)
  expect(drawn.at(-1)).toBe('101@1')
})

test('the newest frame request wins through a floor install wait', async () => {
  const nv = new NiiVue({ backend: 'webgl2' })
  // Floor installs land only when the test releases them.
  const installs: Array<() => void> = []
  let gated = false
  const view: Record<string, unknown> = {
    setCoarseFloor: () =>
      gated ? new Promise<void>((r) => installs.push(r)) : undefined,
  }
  nv.view = new Proxy(view, {
    get: (t, k) =>
      k in t ? t[k as string] : k === 'then' ? undefined : () => {},
  }) as never
  const chunked = await nv.loadChunkedVolume(source(1))
  const vol = nv.volumes[0]
  const floor = (
    nv as unknown as { _setBaseCoarseFloor(v: NVImage): Promise<void> }
  )._setBaseCoarseFloor.bind(nv)
  gated = true
  const installA = floor(vol)
  const toFrame1 = nv.setFrame4D(vol.id ?? '', 1)
  await until(() => installs.length === 1)
  await flush()
  const installB = floor(vol)
  const toFrame2 = nv.setFrame4D(vol.id ?? '', 2)
  await until(() => installs.length === 2)
  await flush()
  gated = false
  installs[1]()
  await installB
  await flush()
  installs[0]()
  await Promise.all([installA, toFrame1, toFrame2])
  expect(chunked.frame).toBe(2)
  expect(vol.frameSource?.frame).toBe(2)
})

test('the readout never holds a brick larger than its cap', async () => {
  const nv = new NiiVue({ backend: 'webgl2' })
  chunkedVolumeBudgets.readoutBytes = 1024
  const handle = await nv.loadChunkedVolume(
    {
      levels: [{ level: 0, shape: [128, 128, 128], spacing: [1, 1, 1] }],
      datatypeCode: NiiDataType.DT_UINT8,
      async fetchChunk({ texDims }) {
        return new Uint8Array(texDims[0] * texDims[1] * texDims[2]).fill(5)
      },
    },
    { coarseFloor: false, calMin: 0, calMax: 9 },
  )
  const vol = nv.volumes[0]
  for (const desc of handle.currentPlan.chunks)
    await vol.chunkSource?.({ desc, bytesPerVoxel: 1 } as Parameters<
      NonNullable<NVImage['chunkSource']>
    >[0])
  const held = (handle as unknown as { readout: { bytes: number } }).readout
    .bytes
  expect(held).toBeLessThanOrEqual(1024)
  expect(vol.voxelValue?.(1, 1, 1).exact).toBe(false)
})

test('getVoxelValue bounds-checks a streamed volume', async () => {
  const nv = new NiiVue({ backend: 'webgl2' })
  await nv.loadChunkedVolume(source(7, { frames: 1 }), { coarseFloor: false })
  await brickValue(nv.volumes[0])
  const { getVoxelValue } = await import('@/volume/utils')
  expect(getVoxelValue(nv.volumes[0], 0, 0, 0)).toBe(7)
  expect(getVoxelValue(nv.volumes[0], 8, 0, 0)).toBe(0)
  expect(getVoxelValue(nv.volumes[0], 0, -1, 0)).toBe(0)
})

test('a decoded NaN reads as exact NaN, not as a missing brick', async () => {
  const nv = new NiiVue({ backend: 'webgl2' })
  await nv.loadChunkedVolume(
    {
      levels: [
        { level: 0, shape: SHAPE, spacing: [1, 1, 1] },
        { level: 1, shape: [4, 4, 4], spacing: [2, 2, 2] },
      ],
      datatypeCode: NiiDataType.DT_FLOAT32,
      async fetchChunk({ texDims, levelIndex }) {
        const out = new Float32Array(texDims[0] * texDims[1] * texDims[2])
        out.fill(levelIndex ? 3 : Number.NaN)
        return new Uint8Array(out.buffer)
      },
    },
    { calMin: 0, calMax: 9 },
  )
  const vol = nv.volumes[0]
  await brickValue(vol, 4)
  const r = vol.voxelValue?.(1, 1, 1)
  expect(r?.exact).toBe(true)
  expect(Number.isNaN(r?.value)).toBe(true)
})

import { describe, expect, it, spyOn } from 'bun:test'
import { log } from '@/logger'
import type {
  NVChannel,
  NVSlide,
  NVSlideChannelInfo,
  NVSlideLevelManifest,
} from './NVSlide'
import {
  type FuseJob,
  FuseLutRows,
  type FuseTile,
  fusePlan,
  fuseSamples,
  fuseTarget,
  fuseTiles,
  fuseUniforms,
  labelColor,
  labelTable,
  MAX_LABEL_TABLE_IDS,
  rawFormat,
  rawPoolBytes,
  resolveWindow,
  SlideBudgetRegistration,
  tileTextureBudget,
} from './slideFuse'
import {
  DEFAULT_TILE_TEXTURE_BYTES,
  TileTextureCache,
} from './tileTextureCache'

const level = (extra: Partial<NVSlideLevelManifest> = {}) =>
  ({ index: 0, ...extra }) as NVSlideLevelManifest
const channel = (extra: Partial<NVChannel> = {}): NVChannel => ({
  name: 'c',
  colormap: 'gray',
  calMin: Number.NaN,
  calMax: Number.NaN,
  visible: true,
  ...extra,
})
const tile = (
  samples: FuseTile['samples']['samples'],
  extra: Partial<FuseTile> = {},
): FuseTile => ({
  samples: {
    samples,
    width: samples.length,
    height: 1,
    bitsStored: 16,
    planes: 1,
  },
  level: level(),
  ...extra,
})
const grey = (rgba: Uint8ClampedArray) =>
  Array.from(rgba.filter((_, i) => i % 4 === 0))

describe('resolveWindow', () => {
  it('fills non-finite bounds from the stored range, never crossing the other', () => {
    const range: [number, number] = [0, 4095]
    expect(
      resolveWindow({ calMin: Number.NaN, calMax: Number.NaN }, range),
    ).toEqual({ calMin: 0, calMax: 4095 })
    expect(resolveWindow({ calMin: 5000, calMax: Number.NaN }, range)).toEqual({
      calMin: 5000,
      calMax: 5001,
    })
    expect(resolveWindow({ calMin: Number.NaN, calMax: -5 }, range)).toEqual({
      calMin: -6,
      calMax: -5,
    })
  })
})

describe('fusePlan', () => {
  it('maps held planes to channels and skips hidden ones', () => {
    const channels = [
      channel({ colormap: 'red' }),
      channel({ visible: false }),
      channel({ colormap: 'blue', calMin: 10, calMax: 20 }),
    ]
    const t = tile(new Uint8Array(4), { channels: [0, 2] })
    t.samples.planes = 2
    t.samples.bitsStored = 8
    expect(fusePlan(channels, 'additive', t)).toEqual({
      layers: [
        { plane: 0, colormap: 'red', calMin: 0, calMax: 255 },
        { plane: 1, colormap: 'blue', calMin: 10, calMax: 20 },
      ],
      labels: [],
      additive: true,
      invert: false,
    })
  })

  it('defaults int16 to its signed range and float32 to 0..1; level bits win', () => {
    const plan = (s: FuseTile['samples']['samples'], bits?: number) =>
      fusePlan(
        [channel()],
        'max',
        tile(s, { level: level({ bitsStored: bits }) }),
      ).layers[0]
    expect(plan(new Int16Array(1))).toMatchObject({
      calMin: -32768,
      calMax: 32767,
    })
    expect(plan(new Float32Array(1))).toMatchObject({ calMin: 0, calMax: 1 })
    expect(plan(new Uint16Array(1), 12)).toMatchObject({
      calMin: 0,
      calMax: 4095,
    })
  })

  it('inverts MONOCHROME1', () => {
    const t = tile(new Uint8Array(1), {
      level: level({ photometric: 'MONOCHROME1' }),
    })
    expect(fusePlan([channel()], 'max', t).invert).toBe(true)
  })
})

describe('fuseSamples', () => {
  const plan = (calMin: number, calMax: number, invert = false) => ({
    layers: [{ plane: 0, calMin, calMax, colormap: 'gray' }],
    labels: [],
    additive: false,
    invert,
  })

  it('maps the window to 0..255, clamping outside it, ties rounded up', () => {
    const rgba = fuseSamples(
      new Uint16Array([50, 100, 200, 300, 400]),
      5,
      plan(100, 300),
    )
    // 200: 127.5 rounds up.
    expect(grey(rgba)).toEqual([0, 0, 128, 255, 255])
    expect(Array.from(rgba.subarray(8, 12))).toEqual([128, 128, 128, 255])
  })

  it('inverts MONOCHROME1 after windowing', () => {
    const rgba = fuseSamples(
      new Uint8Array([100, 200, 255]),
      3,
      plan(100, 300, true),
    )
    expect(grey(rgba)).toEqual([255, 127, 57]) // 255 - round(155 * 255 / 200)
  })

  it('windows int16 and float32 samples; NaN is black', () => {
    expect(
      grey(fuseSamples(new Int16Array([-100, 0, 100]), 3, plan(-100, 100))),
    ).toEqual([0, 128, 255])
    expect(
      grey(fuseSamples(new Float32Array([0.25, Number.NaN, 2]), 3, plan(0, 1))),
    ).toEqual([64, 0, 255])
  })

  it('combines channels by max or saturating sum; none is opaque black', () => {
    const samples = new Uint8Array([100, 200, 30])
    const layers = [
      { plane: 0, calMin: 0, calMax: 255, colormap: 'gray' },
      { plane: 1, calMin: 0, calMax: 255, colormap: 'red' },
      { plane: 2, calMin: 0, calMax: 255, colormap: 'blue' },
    ]
    const at = (additive: boolean) =>
      Array.from(
        fuseSamples(samples, 1, {
          layers,
          labels: [],
          additive,
          invert: false,
        }),
      )
    expect(at(false)).toEqual([200, 100, 100, 255])
    expect(at(true)).toEqual([255, 100, 130, 255])
    expect(
      Array.from(
        fuseSamples(samples, 1, {
          layers: [],
          labels: [],
          additive: false,
          invert: false,
        }),
      ),
    ).toEqual([0, 0, 0, 255])
  })
})

describe('fuseUniforms', () => {
  const f = Math.fround
  // The shaders' level for sample v, in float32 steps as the GPU takes them.
  const level = (calMin: number, calMax: number, v: number): number => {
    const layer = { plane: 0, colormap: 'gray', calMin, calMax }
    const [head, width, , , rest, s] = Float32Array.from(
      fuseUniforms(layer, 0, false),
    ) as unknown as number[]
    const n = f(f(Math.max(f(f(f(v) * s) - head), f(-3.4e38)) - rest) * 255)
    let g = Math.floor(f(f(n / width) + 0.5))
    if (f(f(g - 0.5) * width) > n) g -= 1
    else if (f(f(g + 0.5) * width) <= n) g += 1
    return n > 0 ? Math.min(g, 255) : 0
  }

  it('matches the CPU within a level across centres, widths and samples', () => {
    const M = Number.MAX_VALUE
    const windows: [number, number][] = [[-M, M]]
    for (const c of [0, 1, 1e-30, 1e30, 1e200, 1e-200, 3e38, 1e8])
      for (const sign of [1, -1])
        for (let k = -1000; k <= 1020; k += 25) {
          const h = 2 ** (k - 1)
          windows.push([sign * c - h, sign * c + h])
        }
    const bad: string[] = []
    for (const [calMin, calMax] of windows) {
      if (!(calMin < calMax)) continue
      const c = calMin / 2 + calMax / 2
      const q = calMax / 4 - calMin / 4
      const v = Float32Array.from(
        [0, 2 ** -149, 1e-30, 1, 1e30, 3e38].flatMap((x) => [x, -x]),
      )
      const all = Float32Array.from([...v, f(c), f(c - q), f(c + q)])
      const layer = { plane: 0, colormap: 'gray', calMin, calMax }
      const cpu = fuseSamples(all, all.length, {
        layers: [layer],
        labels: [],
        additive: false,
        invert: false,
      })
      all.forEach((x, i) => {
        const gpu = level(calMin, calMax, x)
        if (Math.abs(gpu - (cpu[i * 4] as number)) > 1)
          bad.push(`${calMin}..${calMax} at ${x}: ${gpu} vs ${cpu[i * 4]}`)
      })
    }
    expect(bad).toEqual([])
  })

  it('keeps every uniform a finite, nonzero float32', () => {
    for (const [lo, hi] of [
      [1e8 + 3.2, 1e8 + 9.6],
      [-3e38, 3.2e38],
      [-1e40, 1e40],
      [0, 8e-44],
    ] as const) {
      const u = Float32Array.from(
        fuseUniforms(
          { plane: 0, colormap: 'gray', calMin: lo, calMax: hi },
          2,
          true,
        ),
      )
      expect(u.every(Number.isFinite)).toBe(true)
      expect([u[1] as number, u[5] as number].every((x) => x > 0)).toBe(true)
      expect([u[2], u[3]]).toEqual([2, 1])
    }
  })

  it('stays within a level of the CPU for windows past float32 range', () => {
    const M = Number.MAX_VALUE
    for (const [lo, hi] of [
      [-1e80, 1e80],
      [-1e300, 1e300],
      [1e300, 1.5e300],
      [-M, M],
    ] as const) {
      const u = Float32Array.from(
        fuseUniforms(
          { plane: 0, colormap: 'gray', calMin: lo, calMax: hi },
          0,
          false,
        ),
      )
      expect(u.every(Number.isFinite)).toBe(true)
      const v = [0, 3e38, -3e38, 1e30]
      const cpu = fuseSamples(Float32Array.from(v), v.length, {
        layers: [{ plane: 0, colormap: 'gray', calMin: lo, calMax: hi }],
        labels: [],
        additive: false,
        invert: false,
      }).filter((_, i) => i % 4 === 0)
      v.forEach((x, i) => {
        expect(
          Math.abs(level(lo, hi, x) - (cpu[i] as number)),
        ).toBeLessThanOrEqual(1)
      })
    }
    // The CPU reference keeps -max..max a real window, not NaN level 0.
    const mid = fuseSamples(Float32Array.of(0), 1, {
      layers: [{ plane: 0, colormap: 'gray', calMin: -M, calMax: M }],
      labels: [],
      additive: false,
      invert: false,
    })
    expect(mid[0]).toBe(128)
  })

  it('matches the CPU levels for windows float32 alone would lose', () => {
    // Rounding calMin and calMax to float32 first gives 255 here.
    expect(level(1e8 + 3.2, 1e8 + 9.6, 1e8 + 8)).toBe(191)
    // Widths past float32 max.
    expect(level(-3e38, 3.2e38, 0)).toBe(123)
    expect(level(-3e38, 3.2e38, 3e38)).toBe(247)
    expect(level(-1e40, 1e40, 0)).toBe(128)
    // A width under float32 min normal.
    expect([0, 4e-44, 8e-44].map((v) => level(0, 8e-44, v))).toEqual([
      0, 130, 255,
    ])
  })
})

describe('FuseLutRows', () => {
  it('adds one 256 x RGBA row per colormap, bumping the version', () => {
    const rows = new FuseLutRows()
    expect(rows.row('gray')).toBe(0)
    expect(rows.row('red')).toBe(1)
    expect(rows.row('gray')).toBe(0)
    expect([rows.rows, rows.version, rows.data.length]).toEqual([2, 2, 2048])
    expect(
      Array.from(rows.data.subarray(1024 + 255 * 4, 1024 + 255 * 4 + 3)),
    ).toEqual([255, 0, 0])
  })
})

describe('fuseTiles', () => {
  // Tiles of `planes` u16 planes of 4 px: 8 B a layer.
  function jobs(n: number, planes = 1): FuseJob<string>[] {
    return Array.from({ length: n }, (_, i) => {
      const t = tile(new Uint16Array(4 * planes))
      t.samples.width = 4
      t.samples.planes = planes
      return {
        target: `t${i}`,
        key: `k${i}`,
        tile: t,
        plan: fusePlan(
          Array.from({ length: planes }, () => channel()),
          'max',
          t,
        ),
      }
    })
  }
  function run(pool: TileTextureCache<string>, list: FuseJob<string>[]) {
    const uploads: string[] = []
    const order: string[] = []
    fuseTiles(
      list,
      pool,
      (s, plane) => {
        const key = `${list.find((j) => j.tile.samples === s)?.key}#${plane}`
        uploads.push(key)
        return key
      },
      (job, layers) => {
        order.push(job.target)
        expect(layers.map(([l]) => l.plane)).toEqual(
          job.plan.layers.map((l) => l.plane),
        )
      },
    )
    return { uploads, order }
  }

  it('uploads each layer once while the pool holds them', () => {
    const pool = new TileTextureCache<string>(64, () => {})
    const list = jobs(2, 2)
    expect(run(pool, list).uploads).toEqual(['k0#0', 'k0#1', 'k1#0', 'k1#1'])
    expect(pool.bytes).toBe(32)
    expect(run(pool, list).uploads).toEqual([])
  })

  it('keeps the pool within budget plus one tile, pooled tiles first', () => {
    const destroyed: string[] = []
    // Room for 2 one-layer tiles; 4 in view.
    const pool = new TileTextureCache<string>(16, (v) => destroyed.push(v))
    const list = jobs(4)
    run(pool, list)
    expect(pool.bytes).toBeLessThanOrEqual(16)
    // The two still pooled (k2, k3) fuse first, then two uploads evict them:
    // a fixed order under LRU would miss on all four.
    const again = run(pool, list)
    expect(again.order).toEqual(['t2', 't3', 't0', 't1'])
    expect(again.uploads).toEqual(['k0#0', 'k1#0'])
    expect(pool.bytes).toBeLessThanOrEqual(16)
  })

  it('re-uploads every time with an empty pool', () => {
    const pool = new TileTextureCache<string>(0, () => {})
    const list = jobs(2, 3)
    expect(run(pool, list).uploads).toHaveLength(6)
    expect(pool.bytes).toBe(0)
    expect(run(pool, list).uploads).toHaveLength(6)
  })

  it('re-uploads a refetched tile (new samples under the same key)', () => {
    const pool = new TileTextureCache<string>(64, () => {})
    const list = jobs(1)
    run(pool, list)
    const [job] = jobs(1)
    expect(run(pool, [job as FuseJob<string>]).uploads).toEqual(['k0#0'])
  })
})

describe('fuseTarget', () => {
  const at = {
    slide: { tileKey: () => 'k' },
    key: 'k',
    level: { index: 0 } as NVSlideLevelManifest,
    col: 0,
    row: 0,
  }
  const slide = {
    displayGeneration: 1,
    liveChannels: [channel()],
    channelBlend: 'max',
    manifest: {},
    selectedLabel: null,
  } as unknown as NVSlide

  it('creates the texture once and queues it once per display generation', () => {
    const cache = new TileTextureCache<{ fused?: number }>(1 << 20, () => {})
    const jobs: FuseJob<{ fused?: number }>[] = []
    const t = tile(new Uint16Array(4))
    let made = 0
    const create = () => {
      made++
      return {}
    }
    const first = fuseTarget(jobs, cache, at, slide, t, 4096, create)
    expect(fuseTarget(jobs, cache, at, slide, t, 4096, create)).toBe(first)
    expect([made, jobs.length]).toEqual([1, 1])
  })

  it('defers an upload that would take the frame past its texture budget (ENG-11)', () => {
    // 4 x 1 tiles: 6 x 3 padded RGBA = 72 B; the budget holds two.
    const cache = new TileTextureCache<{ fused?: number }>(150, () => {})
    cache.evictToBudget()
    cache.beginFrame()
    const jobs: FuseJob<{ fused?: number }>[] = []
    const made = ['a', 'b', 'c'].map((key) =>
      fuseTarget(
        jobs,
        cache,
        { ...at, key },
        slide,
        tile(new Uint16Array(4)),
        4096,
        () => ({}),
      ),
    )
    expect(made.map((t) => t !== null)).toEqual([true, true, false])
    expect(cache.bytes).toBeLessThanOrEqual(150)
    // Next frame the undrawn tiles are evictable, so the deferred one uploads.
    cache.evictToBudget()
    cache.beginFrame()
    expect(
      fuseTarget(
        jobs,
        cache,
        { ...at, key: 'c' },
        slide,
        tile(new Uint16Array(4)),
        4096,
        () => ({}),
      ),
    ).not.toBeNull()
    expect(cache.bytes).toBeLessThanOrEqual(150)
  })

  it('refuses a tile whose padded texture exceeds the device limit', () => {
    // WebGPU fails validation (WebGL2 errors) on an oversized texture: the
    // tile draws nothing instead (its fallback shows), on both backends.
    const cache = new TileTextureCache<{ fused?: number }>(1 << 20, () => {})
    const jobs: FuseJob<{ fused?: number }>[] = []
    const t = tile(new Uint16Array(4)) // 4 x 1: 6 x 3 padded
    expect(fuseTarget(jobs, cache, at, slide, t, 5, () => ({}))).toBeNull()
    expect([cache.bytes, jobs.length]).toEqual([0, 0])
    expect(fuseTarget(jobs, cache, at, slide, t, 6, () => ({}))).not.toBeNull()
  })
})

describe('labels', () => {
  const rgb = (rgba: Uint8ClampedArray) =>
    Array.from({ length: rgba.length / 4 }, (_, i) =>
      Array.from(rgba.subarray(i * 4, i * 4 + 3)),
    )
  const LABEL: NVSlideChannelInfo = { name: 'l', active: true, kind: 'label' }
  // Hand-computed lowbias32 (64 + byte * 3 >> 2 per channel), the shaders' formula.
  const ID1 = [208, 172, 166]
  const ID2 = [160, 88, 78]
  const fused = (
    samples: FuseTile['samples']['samples'],
    info: NVSlideChannelInfo[],
    selected: { channel: number; id: number } | null = null,
    channels = [channel({ calMin: 0, calMax: 1 })],
  ) => {
    const t = tile(samples, {
      channels: channels.map((_, i) => i),
    })
    t.samples.planes = channels.length
    t.samples.width = samples.length / channels.length
    return rgb(
      fuseSamples(
        samples,
        t.samples.width,
        fusePlan(channels, 'max', t, info, selected),
      ),
    )
  }

  it('hashes IDs as the shaders do', () => {
    expect(
      [1, 2, 3, 70000, 2 ** 24].map((id) => labelColor(id).toString(16)),
    ).toEqual(['ffa6acd0', 'ff4e58a0', 'fff4eee5', 'ffaee541', 'ffb84d63'])
  })

  it('S4: maps IDs 1 and 2 side by side to their exact colours, window ignored', () => {
    // calMin 0, calMax 1 would draw both white as intensity.
    expect(fused(new Uint16Array([1, 2, 0, 2]), [LABEL])).toEqual([
      ID1,
      ID2,
      [0, 0, 0],
      ID2,
    ])
    expect(fused(new Uint8Array([2, 1]), [LABEL])).toEqual([ID2, ID1])
  })

  it('reads f32 IDs up to 2^24 exactly; NaN and negatives are 0', () => {
    const f32 = Float32Array.of(70000, 2 ** 24, Number.NaN, -3, 1)
    expect(fused(f32, [LABEL])).toEqual([
      [65, 229, 174],
      [99, 77, 184],
      [0, 0, 0],
      [0, 0, 0],
      ID1,
    ])
    expect(fused(Int16Array.of(-1, 2), [LABEL])).toEqual([[0, 0, 0], ID2])
  })

  it('uses labelColors where given, alpha folded in, the default elsewhere', () => {
    const info = {
      ...LABEL,
      labelColors: [
        { id: 2, rgba: [255, 0, 0, 255] as const },
        { id: 5, rgba: [0, 255, 0, 128] as const },
      ],
    }
    expect(fused(new Uint16Array([1, 2, 5, 7]), [info])).toEqual([
      ID1,
      [255, 0, 0],
      [0, 128, 0],
      [
        labelColor(7) & 255,
        (labelColor(7) >>> 8) & 255,
        (labelColor(7) >>> 16) & 255,
      ],
    ])
    expect(labelTable(info.labelColors)).toBe(labelTable(info.labelColors))
    expect(labelTable().size).toBe(1)
  })

  it('skips label IDs a 2048 x 2048 table cannot hold, with a warning', () => {
    const warn = spyOn(log, 'warn').mockImplementation(() => {})
    const colors = [
      { id: 2 ** 31, rgba: [255, 0, 0, 255] as const },
      { id: MAX_LABEL_TABLE_IDS, rgba: [255, 0, 0, 255] as const },
      { id: -1, rgba: [255, 0, 0, 255] as const },
      { id: 1.5, rgba: [255, 0, 0, 255] as const },
      { id: 3, rgba: [0, 0, 255, 255] as const },
    ]
    const table = labelTable(colors)
    expect([table.size, table.width, table.colors.length]).toEqual([4, 4, 4])
    expect(table.colors[3]).toBe(0xffff0000)
    expect(warn).toHaveBeenCalledTimes(1)
    const edge = labelTable([
      { id: MAX_LABEL_TABLE_IDS - 1, rgba: [0, 0, 0, 255] as const },
    ])
    expect([edge.width, edge.colors.length / edge.width]).toEqual([2048, 2048])
    warn.mockRestore()
  })

  it('highlights the selected ID of its channel, dims the others', () => {
    const dim = ID1.map((c) => (c * 77) >> 8)
    const ids = new Uint16Array([1, 2, 0])
    expect(fused(ids, [LABEL], { channel: 0, id: 2 })).toEqual([
      dim,
      ID2,
      [0, 0, 0],
    ])
    // A selection on another channel leaves this one at full colour.
    const two = [channel(), channel()]
    const both = new Uint16Array([1, 2, 0, 0])
    expect(fused(both, [LABEL, LABEL], { channel: 1, id: 1 }, two)).toEqual([
      ID1,
      ID2,
    ])
    expect(fused(both, [LABEL, LABEL], { channel: 0, id: 1 }, two)).toEqual([
      ID1,
      ID2.map((c) => (c * 77) >> 8),
    ])
  })

  it('blends label and intensity layers by max', () => {
    // Plane 0 intensity 0..255 grey, plane 1 label IDs.
    const out = fused(
      new Uint8Array([255, 0, 1, 2]),
      [{ name: 'i', active: true }, LABEL],
      null,
      [channel({ calMin: 0, calMax: 255 }), channel()],
    )
    expect(out).toEqual([[255, 255, 255], ID2])
  })

  it('draws a tile nearest only when every visible layer is a label', () => {
    const nearestOf = (info: NVSlideChannelInfo[], visible: boolean[]) => {
      const cache = new TileTextureCache<{ nearest?: boolean }>(
        1 << 20,
        () => {},
      )
      const t = tile(new Uint16Array(4), { channels: [0, 1] })
      t.samples.planes = 2
      t.samples.width = 2
      const slide = {
        displayGeneration: 1,
        liveChannels: visible.map((v) => channel({ visible: v })),
        channelBlend: 'max',
        manifest: { channelInfo: info },
        selectedLabel: null,
      } as unknown as NVSlide
      const at = { slide, key: 'k', level: level(), col: 0, row: 0 }
      const made: { nearest?: boolean } = {}
      return fuseTarget([], cache, at, slide, t, 4096, () => made)?.nearest
    }
    const I = { name: 'i', active: true }
    expect(nearestOf([LABEL, LABEL], [true, true])).toBe(true)
    expect(nearestOf([I, LABEL], [false, true])).toBe(true)
    expect(nearestOf([I, LABEL], [true, true])).toBe(false)
    expect(nearestOf([I, I], [true, true])).toBe(false)
  })

  it('gives a tile of label and intensity channels a label texture, counted; a toggle remakes it', () => {
    const destroyed: object[] = []
    const cache = new TileTextureCache<{ labels?: boolean }>(1 << 20, (v) =>
      destroyed.push(v),
    )
    const t = tile(new Uint16Array(4), { channels: [0, 1] })
    t.samples.planes = 2
    t.samples.width = 2
    const slide = {
      displayGeneration: 1,
      liveChannels: [channel(), channel()],
      channelBlend: 'max',
      manifest: { channelInfo: [{ name: 'i', active: true }, LABEL] },
      selectedLabel: null,
    } as unknown as NVSlide
    const at = { slide, key: 'k', level: level(), col: 0, row: 0 }
    const create = (_w: number, _h: number, labels: boolean) =>
      labels ? { labels } : {}
    const target = () => fuseTarget([], cache, at, slide, t, 4096, create)
    const mixed = target()
    // 2 x 1 interior: 4 x 3 padded RGBA, twice.
    expect([mixed?.labels, cache.bytes]).toEqual([true, 96])
    expect(target()).toBe(mixed)
    Object.assign(slide, {
      displayGeneration: 2,
      liveChannels: [channel(), channel({ visible: false })],
    })
    const intensity = target()
    expect([intensity?.labels, cache.bytes]).toEqual([undefined, 48])
    expect(destroyed).toEqual([mixed as object])
  })

  it('frees the entry it remakes before reserving, so a touched tile remakes at the budget', () => {
    const cache = new TileTextureCache<{ labels?: boolean }>(96, () => {})
    const t = tile(new Uint16Array(4), { channels: [0, 1] })
    t.samples.planes = 2
    t.samples.width = 2
    const slide = {
      displayGeneration: 1,
      liveChannels: [channel(), channel()],
      channelBlend: 'max',
      manifest: { channelInfo: [{ name: 'i', active: true }, LABEL] },
      selectedLabel: null,
    } as unknown as NVSlide
    const at = { slide, key: 'k', level: level(), col: 0, row: 0 }
    const create = (_w: number, _h: number, labels: boolean) =>
      labels ? { labels } : {}
    cache.evictToBudget()
    cache.beginFrame()
    expect(fuseTarget([], cache, at, slide, t, 4096, create)).not.toBeNull()
    // Next frame: planTextures touches the drawn tile before it is fused.
    cache.evictToBudget()
    cache.beginFrame()
    cache.touch('k', t.samples)
    Object.assign(slide, {
      displayGeneration: 2,
      liveChannels: [channel(), channel({ visible: false })],
    })
    expect(fuseTarget([], cache, at, slide, t, 4096, create)).not.toBeNull()
    expect(cache.bytes).toBe(48)
  })
})

describe('SlideBudgetRegistration', () => {
  it('splits the budget between the slides; a label and intensity slide takes half a share', () => {
    type Budget = { tileBytes: number; rawPoolBytes: number } | null
    const fake = (kinds: ('label' | undefined)[]) => {
      const slide = {
        budget: null as Budget,
        manifest: {
          channelInfo: kinds.map((kind) => ({ name: 'c', active: true, kind })),
        },
        setRendererBudget(_r: object, b: Budget) {
          slide.budget = b
        },
      }
      return slide
    }
    const P = 32 << 20
    const a = fake([undefined])
    const b = fake([undefined, 'label'])
    const c = fake(['label'])
    const reg = new SlideBudgetRegistration({}, P)
    const share = (s: { budget: { tileBytes: number } | null }) =>
      (s.budget?.tileBytes ?? 0) / DEFAULT_TILE_TEXTURE_BYTES
    reg.sync([a] as unknown as NVSlide[])
    expect(a.budget).toEqual({
      tileBytes: DEFAULT_TILE_TEXTURE_BYTES,
      rawPoolBytes: P,
    })
    reg.sync([a, b, c] as unknown as NVSlide[])
    expect([a, b, c].map(share)).toEqual([1 / 3, 1 / 6, 1 / 3])
    // The pool splits too, so a share's scalar bytes stay positive.
    expect(a.budget?.rawPoolBytes).toBe(P / 3)
    reg.clear()
    expect(a.budget).toBeNull()
  })
})

describe('rawPoolBytes', () => {
  it('clamps so tile textures keep at least 64 MiB', () => {
    const MiB = 1024 * 1024
    expect(rawPoolBytes()).toBe(32 * MiB)
    expect(rawPoolBytes(-1)).toBe(0)
    expect(tileTextureBudget(rawPoolBytes(256 * MiB))).toBe(64 * MiB)
  })
})

describe('tileTextureBudget', () => {
  it('is what the raw pool leaves of 128 MiB, never negative', () => {
    expect(tileTextureBudget()).toBe(96 * 1024 * 1024)
    expect(tileTextureBudget(0)).toBe(128 * 1024 * 1024)
    expect(tileTextureBudget(256 * 1024 * 1024)).toBe(0)
  })
})

describe('rawFormat', () => {
  it('names the texture format of each sample type', () => {
    expect(
      [
        new Uint8Array(),
        new Uint16Array(),
        new Int16Array(),
        new Float32Array(),
      ].map(rawFormat),
    ).toEqual(['u8', 'u16', 'i16', 'f32'])
  })
})

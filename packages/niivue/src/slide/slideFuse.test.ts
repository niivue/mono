import { describe, expect, it } from 'bun:test'
import type { NVChannel, NVSlide, NVSlideLevelManifest } from './NVSlide'
import {
  type FuseJob,
  FuseLutRows,
  type FuseTile,
  fusePlan,
  fuseSamples,
  fuseTarget,
  fuseTiles,
  fuseUniforms,
  rawFormat,
  rawPoolBytes,
  resolveWindow,
  tileTextureBudget,
} from './slideFuse'
import { TileTextureCache } from './tileTextureCache'

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
      Array.from(fuseSamples(samples, 1, { layers, additive, invert: false }))
    expect(at(false)).toEqual([200, 100, 100, 255])
    expect(at(true)).toEqual([255, 100, 130, 255])
    expect(
      Array.from(
        fuseSamples(samples, 1, { layers: [], additive: false, invert: false }),
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
    const n = f(f(Math.max(f(f(v) * s) - head, -3.4e38) - rest) * 255)
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
  const at = { slide: {}, key: 'k', level: 0, col: 0, row: 0 }
  const slide = {
    displayGeneration: 1,
    channels: [channel()],
    channelBlend: 'max',
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

  it('refuses a tile whose padded texture exceeds the device limit', () => {
    // WebGPU fails validation (WebGL2 errors) on an oversized texture: the
    // tile draws as its placeholder instead, on both backends.
    const cache = new TileTextureCache<{ fused?: number }>(1 << 20, () => {})
    const jobs: FuseJob<{ fused?: number }>[] = []
    const t = tile(new Uint16Array(4)) // 4 x 1: 6 x 3 padded
    expect(fuseTarget(jobs, cache, at, slide, t, 5, () => ({}))).toBeNull()
    expect([cache.bytes, jobs.length]).toEqual([0, 0])
    expect(fuseTarget(jobs, cache, at, slide, t, 6, () => ({}))).not.toBeNull()
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

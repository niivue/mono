// P0 contracts (plan-tile-final-contracts sections 2, 4 and 10): source
// lifetime, single-channel channelInfo, storedToValue, sampleType,
// channelInfoChanged, renderer budgets, plane state and request ownership.
// Test ids (L1, S1, P1, R1, ...) are the spec's.
import { describe, expect, it, spyOn } from 'bun:test'
import NVViewGL from '@/gl/NVViewGL'
import { SlideRenderer } from '@/gl/slide'
import { log } from '@/logger'
import NVViewGPU from '@/wgpu/NVViewGPU'
import type {
  NVSlideChannelInfo,
  NVSlideLevelManifest,
  NVSlideManifest,
  NVSlidePlaneAxes,
  NVSlidePlaneIndex,
  NVSlideSampleArray,
  NVSlideTileManifest,
} from './NVSlide'
import { NVSlide } from './NVSlide'
import { toStored, toValue } from './slideChannels'
import { rawFormat, SlideBudgetRegistration } from './slideFuse'
import { tileCapacity } from './slideLod'
import type { SlidePlaneState } from './slidePlane'
import type {
  SlidePlaneCapable,
  SlideSourceHost,
  SlideTileSource,
} from './slideSource'

const MiB = 1024 * 1024
const T = 8

/** A raw-gray pyramid of `n` x `n` tiles of T px. */
function grayManifest(
  n = 2,
  level: Partial<NVSlideLevelManifest> = {},
  channelInfo?: NVSlideChannelInfo[],
): NVSlideManifest {
  const tiles = []
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) tiles.push({ x, y, width: T, height: T })
  return {
    id: 'g',
    name: 'g',
    width: T * n,
    height: T * n,
    tileSize: T,
    dtype: 'uint16',
    channels: 'gray',
    levels: [
      {
        index: 0,
        width: T * n,
        height: T * n,
        downsample: 1,
        columns: n,
        rows: n,
        codec: 'raw-gray',
        bitsStored: 16,
        tiles,
        ...level,
      },
    ],
    ...(channelInfo ? { channelInfo } : {}),
  }
}

/** A bytes source whose every sample is `value`, in `Samples`; counts fetches. */
class ConstantSource implements SlideTileSource {
  fetches = 0
  disposed = 0
  host: SlideSourceHost | null = null
  hold = false
  constructor(
    readonly manifest: NVSlideManifest,
    private readonly value = 7,
    private readonly Samples: new (
      n: number,
    ) => NVSlideSampleArray = Uint16Array,
  ) {}
  bind(host: SlideSourceHost): void {
    this.host = host
  }
  async fetchTileBytes(
    _l: NVSlideLevelManifest,
    tile: { width: number; height: number },
    _label: string,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    this.fetches++
    if (this.hold)
      await new Promise((_, reject) =>
        signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        ),
      )
    const s = new this.Samples(tile.width * tile.height).fill(this.value)
    return new Uint8Array(s.buffer)
  }
  dispose(): void {
    this.disposed++
  }
}

describe('source lifetime', () => {
  it('L1: dispose twice disposes an owned source once', () => {
    const source = new ConstantSource(grayManifest())
    const slide = NVSlide.fromSource(source)
    slide.dispose()
    slide.dispose()
    expect(source.disposed).toBe(1)
  })

  it('L2: ownsSource false leaves the source to the caller', () => {
    const source = new ConstantSource(grayManifest())
    NVSlide.fromSource(source, { ownsSource: false }).dispose()
    expect(source.disposed).toBe(0)
  })

  it('L3: a constructor that throws leaves the source undisposed', () => {
    const manifest = grayManifest()
    manifest.format = 'dicom-wsi'
    ;(manifest.levels[0] as NVSlideLevelManifest).focalPlanes = 2
    const source = new ConstantSource(manifest)
    expect(() => NVSlide.fromSource(source)).toThrow(/focal planes/)
    expect(source.disposed).toBe(0)
  })

  it('L7: a throwing source dispose still settles pending loadSampleAt', async () => {
    const source = new ConstantSource(grayManifest())
    // Ignores abort, so only dispose's clearCache can settle the waiter.
    source.fetchTileBytes = () => new Promise<Uint8Array>(() => {})
    source.dispose = () => {
      throw new Error('boom')
    }
    const slide = NVSlide.fromSource(source)
    const pending = slide.loadSampleAt(1, 1)
    await Promise.resolve()
    expect(() => slide.dispose()).toThrow('boom')
    expect((await pending)[0]?.missing).toBe('uncached')
  })

  it('L6: a pending loadSampleAt resolves uncached after dispose', async () => {
    const source = new ConstantSource(grayManifest())
    source.hold = true
    const slide = NVSlide.fromSource(source)
    const pending = slide.loadSampleAt(1, 1)
    await Promise.resolve()
    slide.dispose()
    expect((await pending)[0]?.missing).toBe('uncached')
    expect(source.disposed).toBe(1)
  })
})

describe('single-channel channelInfo', () => {
  const screen = { widthCss: 2 * T, heightCss: 2 * T, devicePixelRatio: 1 }

  async function loaded(channelInfo?: NVSlideChannelInfo[]) {
    const source = new ConstantSource(grayManifest(2, {}, channelInfo))
    const slide = NVSlide.fromSource(source)
    slide.setViewport({ centerX: T, centerY: T, scale: 1 })
    for (const [x, y] of [
      [1, 1],
      [T + 1, 1],
      [1, T + 1],
      [T + 1, T + 1],
    ] as const)
      await slide.loadSampleAt(x, y)
    return { slide, source }
  }

  it('S1: one entry matches the no-channelInfo baseline', async () => {
    const base = await loaded()
    const one = await loaded([{ name: 'c', active: true }])
    for (const { slide, source } of [base, one]) {
      expect(slide.channels.map((c) => c.colormap)).toEqual(['gray'])
      expect(slide.channelBlend).toBe('max')
      expect(source.fetches).toBe(4)
      // No refetch on hide or show.
      slide.setChannel(0, { visible: false })
      slide.setChannel(0, { visible: true })
      expect(source.fetches).toBe(4)
      expect(slide.sampleAt(1, 1)[0]).toMatchObject({ stored: 7, exact: true })
    }
    const tiles = (s: NVSlide) => s.visibleTiles(screen).tiles.map((t) => t.key)
    expect(tiles(one.slide)).toEqual(tiles(base.slide))
    const level = base.slide.manifest.levels[0] as NVSlideLevelManifest
    const budget = { tileBytes: 128 * MiB, rawPoolBytes: 32 * MiB }
    expect(
      tileCapacity(one.slide.manifest, level, 1e6, undefined, budget),
    ).toEqual(tileCapacity(base.slide.manifest, level, 1e6, undefined, budget))
    expect(
      tileCapacity(base.slide.manifest, level, 1e6, undefined, budget),
    ).toEqual({ tiles: 4096, limitedBy: 'tiles' })
    base.slide.dispose()
    one.slide.dispose()
  })

  it('S1: a stated colormap or rgb still wins', () => {
    const slide = (c: NVSlideChannelInfo) =>
      NVSlide.fromSource(new ConstantSource(grayManifest(2, {}, [c])))
    expect(
      slide({ name: 'c', colormap: 'hot', active: true }).channels[0]?.colormap,
    ).toBe('hot')
    expect(
      slide({ name: 'c', rgb: [255, 0, 0], active: true }).channels[0]
        ?.colormap,
    ).toBe('red')
  })

  it('S6: channelInfo on an RGB bytes source throws; several on a grey one warn', async () => {
    const rgb = grayManifest(2, { codec: 'image/jpeg' }, [
      { name: 'c', active: true },
    ])
    const source = new ConstantSource(rgb)
    expect(() => NVSlide.fromSource(source)).toThrow(/monochrome/)
    expect(source.disposed).toBe(0)
    const warn = spyOn(log, 'warn').mockImplementation(() => {})
    const info = ['a', 'b', 'c'].map((name) => ({ name, active: true }))
    const slide = NVSlide.fromSource(
      new ConstantSource(grayManifest(2, {}, info)),
    )
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0]?.[0])).toMatch(/only channel 0/)
    warn.mockRestore()
    const samples = await slide.loadSampleAt(1, 1)
    expect(samples.map((s) => s.stored)).toEqual([7, null, null])
    expect(samples.map((s) => s.missing)).toEqual([
      undefined,
      'uncached',
      'uncached',
    ])
    slide.dispose()
  })
})

describe('storedToValue', () => {
  it('S2: an exact rescale is exact at level 0 and never clipped', async () => {
    const map = { scale: 2, offset: -1024, quantized: false }
    const source = new ConstantSource(
      grayManifest(2, {}, [{ name: 'ct', active: true, storedToValue: map }]),
      0,
    )
    const slide = NVSlide.fromSource(source)
    const [s] = await slide.loadSampleAt(1, 1)
    expect(s).toMatchObject({ stored: 0, value: -1024, exact: true })
    expect(s?.clipped).toBeUndefined()
    slide.dispose()
  })

  it('toValue/toStored invert; quantized stored values are integers', () => {
    expect(toValue(3)).toBe(3)
    expect(toStored(3)).toBe(3)
    const exact = { scale: 0.5, offset: 1, quantized: false }
    expect(toStored(toValue(3, exact), exact)).toBe(3)
    expect(toStored(1.25, exact)).toBe(0.5)
    // A quantized map rounds: float error never leaves a fractional sample.
    const q = { scale: 6 / 65535, offset: -3 }
    for (let s = 0; s <= 65535; s += 97)
      expect(toStored(toValue(s, q), q)).toBe(s)
  })
})

describe('sampleType', () => {
  it('S3: an i16 tile reads -5 and counts 2 bytes; f32 counts 4', async () => {
    const i16 = new ConstantSource(
      grayManifest(2, { sampleType: 'i16' }),
      -5,
      Int16Array,
    )
    const slide = NVSlide.fromSource(i16)
    expect((await slide.loadSampleAt(1, 1))[0]?.stored).toBe(-5)
    const level0 = slide.manifest.levels[0] as NVSlideLevelManifest
    const samples = slide.cachedTile(slide.tileKey(level0, { x: 0, y: 0 }))
      ?.samples?.samples
    expect(samples && rawFormat(samples)).toBe('i16')
    slide.dispose()
    const f32 = new ConstantSource(
      grayManifest(2, { sampleType: 'f32', bitsStored: 32 }),
      0.5,
      Float32Array,
    )
    const fs = NVSlide.fromSource(f32)
    expect((await fs.loadSampleAt(1, 1))[0]?.stored).toBe(0.5)
    fs.dispose()
    const budget = { tileBytes: 1e12, rawPoolBytes: 0 }
    const cap = (level: Partial<NVSlideLevelManifest>) => {
      const m = grayManifest(2, level)
      return tileCapacity(
        m,
        m.levels[0] as NVSlideLevelManifest,
        64 * T * T * 4,
        undefined,
        budget,
      ).tiles
    }
    // 0.75 of 64 tiles' bytes at 4 bytes a pixel: 48 f32 tiles, 96 at 2 bytes.
    expect(cap({ sampleType: 'f32' })).toBe(48)
    expect(cap({ sampleType: 'f32', bitsStored: 16 })).toBe(48)
    expect(cap({ sampleType: 'i16' })).toBe(96)
    expect(cap({})).toBe(96)
  })

  it('S3: raw-gray above 16 bits still throws unless f32', async () => {
    const source = new ConstantSource(grayManifest(2, { bitsStored: 32 }))
    const slide = NVSlide.fromSource(source)
    const err = spyOn(console, 'error').mockImplementation(() => {})
    await slide.loadSampleAt(1, 1)
    expect(String(err.mock.calls[0]?.[1])).toMatch(/up to 16/)
    err.mockRestore()
    slide.dispose()
  })

  it('clips quantized int16 at its range ends', async () => {
    const info = [
      { name: 'c', active: true, storedToValue: { scale: 1, offset: 0 } },
    ]
    const source = new ConstantSource(
      grayManifest(2, { sampleType: 'i16' }, info),
      -32768,
      Int16Array,
    )
    const slide = NVSlide.fromSource(source)
    expect((await slide.loadSampleAt(1, 1))[0]?.clipped).toBe(true)
    slide.dispose()
  })
})

describe('channelInfoChanged', () => {
  it('P8: a source window shows until the user sets one; readout takes the map', async () => {
    const source = new ConstantSource(
      grayManifest(2, {}, [{ name: 'c', active: true }]),
    )
    const slide = NVSlide.fromSource(source)
    const host = source.host as SlideSourceHost
    host.channelInfoChanged(0, {
      window: { calMin: 10, calMax: 20 },
      storedToValue: { scale: 2, offset: 1 },
    })
    expect(slide.channels[0]).toMatchObject({ calMin: 10, calMax: 20 })
    expect(slide.manifest.channelInfo?.[0]?.window).toEqual({
      calMin: 10,
      calMax: 20,
    })
    // The source's own manifest is left alone.
    expect(source.manifest.channelInfo?.[0]?.window).toBeUndefined()
    expect((await slide.loadSampleAt(1, 1))[0]).toMatchObject({
      stored: 7,
      value: 15,
    })
    slide.setChannel(0, { calMin: 1, calMax: 2 })
    host.channelInfoChanged(0, { window: { calMin: 30, calMax: 40 } })
    expect(slide.channels[0]).toMatchObject({ calMin: 1, calMax: 2 })
    expect(() => host.channelInfoChanged(1, {})).toThrow(RangeError)
    slide.dispose()
  })
})

describe('renderer budget', () => {
  // 32 x 32 tiles of 256 px: a full view needs 1024 tiles, so the texture
  // budget, not the cache, caps it.
  function bigSlide() {
    const n = 32
    const m = grayManifest(n, { tileWidth: 256, tileHeight: 256 })
    m.tileSize = 256
    m.width = m.height = 256 * n
    const level = m.levels[0] as NVSlideLevelManifest
    level.width = level.height = 256 * n
    level.tiles = level.tiles.map((t) => t && { ...t, width: 256, height: 256 })
    const slide = NVSlide.fromSource(new ConstantSource(m), {
      maxCacheBytes: 1 << 30,
    })
    slide.setViewport({ centerX: 128 * n, centerY: 128 * n, scale: 1 })
    return slide
  }
  const screen = { widthCss: 8192, heightCss: 8192, devicePixelRatio: 1 }

  it('RN3: a renderer with a 64 MiB pool caps what a HUD sees, and the warning says so', () => {
    const warn = spyOn(log, 'warn').mockImplementation(() => {})
    const slide = bigSlide()
    const unregistered = slide.visibleTiles(screen).tiles.length
    expect(String(warn.mock.calls[0]?.[0])).toMatch(
      /96 MiB for scalar slides, 128 for RGB/,
    )
    const renderer = new SlideRenderer({ maxRawPoolBytes: 64 * MiB })
    // Not initialised: render registers the budget, then does nothing.
    renderer.render([slide], screen)
    const hud = slide.visibleTiles(screen).tiles.length
    expect(hud).toBeLessThan(unregistered)
    expect(hud / unregistered).toBeCloseTo(64 / 96, 1)
    expect(String(warn.mock.calls.at(-1)?.[0])).toMatch(
      /64 MiB for scalar slides, 128 for RGB/,
    )
    // The outcome is unchanged frame to frame: no second warning.
    const warned = warn.mock.calls.length
    slide.visibleTiles(screen)
    slide.visibleTiles(screen)
    expect(warn.mock.calls.length).toBe(warned)
    // The smallest registered budget wins; unregistering restores the default.
    const other = {}
    slide.setRendererBudget(other, { tileBytes: 128 * MiB, rawPoolBytes: 0 })
    expect(slide.visibleTiles(screen).tiles.length).toBe(hud)
    slide.setRendererBudget(renderer, null)
    slide.setRendererBudget(other, null)
    expect(slide.visibleTiles(screen).tiles.length).toBe(unregistered)
    warn.mockRestore()
    slide.dispose()
  })

  it('a budget that flaps back between frames does not warn again', () => {
    const warn = spyOn(log, 'warn').mockImplementation(() => {})
    const slide = bigSlide()
    const renderer = {}
    const budget = { tileBytes: 128 * MiB, rawPoolBytes: 64 * MiB }
    slide.setRendererBudget(renderer, budget)
    slide.visibleTiles(screen)
    const warned = warn.mock.calls.length
    slide.setRendererBudget(renderer, null)
    slide.setRendererBudget(renderer, budget)
    slide.visibleTiles(screen)
    expect(warn.mock.calls.length).toBe(warned)
    warn.mockRestore()
    slide.dispose()
  })

  it('clearing a view slide plane unregisters its plane renderer', () => {
    const warn = spyOn(log, 'warn').mockImplementation(() => {})
    for (const View of [NVViewGL, NVViewGPU]) {
      const slide = bigSlide()
      const unregistered = slide.visibleTiles(screen).tiles.length
      const view = Object.create(View.prototype) as NVViewGL | NVViewGPU
      const renderer = {
        _budget: new SlideBudgetRegistration({}, 64 * MiB),
        clearBudget() {
          this._budget.clear()
        },
      }
      Object.assign(view, { slidePlaneRenderer: renderer })
      view.slidePlane = { slide } as SlidePlaneState
      renderer._budget.sync([slide]) // as draw does
      expect(slide.visibleTiles(screen).tiles.length).toBeLessThan(unregistered)
      view.slidePlane = null
      expect(slide.visibleTiles(screen).tiles.length).toBe(unregistered)
      slide.dispose()
    }
    warn.mockRestore()
  })

  it('a renderer drops slides it no longer draws', () => {
    const warn = spyOn(log, 'warn').mockImplementation(() => {})
    const slide = bigSlide()
    const unregistered = slide.visibleTiles(screen).tiles.length
    const renderer = new SlideRenderer({ maxRawPoolBytes: 64 * MiB })
    renderer.render([slide], screen)
    renderer.render([], screen)
    expect(slide.visibleTiles(screen).tiles.length).toBe(unregistered)
    warn.mockRestore()
    slide.dispose()
  })
})

describe('types', () => {
  it('a fixed source still satisfies SlideTileSource; a plane source adds SlidePlaneCapable', () => {
    const manifest = grayManifest()
    const fixed = {
      manifest,
      bind() {},
      fetchTileBytes: async () => new Uint8Array(0),
    } satisfies SlideTileSource
    const planes: SlideTileSource & SlidePlaneCapable = {
      ...fixed,
      planes: { z: 2, t: 1 },
      preparePlane: async (p) => ({
        ...manifest,
        levels: manifest.levels.map((l) => ({ ...l, plane: p })),
      }),
    }
    expect('preparePlane' in fixed).toBe(false)
    expect(planes.planes.z).toBe(2)
  })
})

async function waitFor(check: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now()
  while (!check()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitFor timed out')
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
}

type Fetch = {
  level: NVSlideLevelManifest
  tile: NVSlideTileManifest
  signal?: AbortSignal
}

/**
 * A raw-gray u16 source with `planes` focal planes: plane z's samples are
 * 10 * (z + 1). Records each fetch; `gated` holds fetches until `release`
 * (ignoring the signal, as a source that cannot stop a read); `failing`
 * rejects them.
 */
class PlaneSource implements SlideTileSource, SlidePlaneCapable {
  readonly fetched: Fetch[] = []
  gated = false
  failing = false
  private readonly gates: Array<() => void> = []
  prepare = async (p: NVSlidePlaneIndex, _signal?: AbortSignal) =>
    this.planeManifest(p)
  constructor(
    readonly manifest: NVSlideManifest,
    readonly planes: NVSlidePlaneAxes = { z: 3, t: 1 },
  ) {}
  bind(): void {}
  planeManifest(p: NVSlidePlaneIndex): NVSlideManifest {
    return {
      ...this.manifest,
      levels: this.manifest.levels.map((l) => ({ ...l, plane: { ...p } })),
    }
  }
  preparePlane(p: NVSlidePlaneIndex, signal?: AbortSignal) {
    return this.prepare(p, signal)
  }
  /** Resolve the oldest `n` held fetches (default all). */
  release(n = this.gates.length): void {
    for (const open of this.gates.splice(0, n)) open()
  }
  /** Fetches of plane `z`. */
  of(z: number): Fetch[] {
    return this.fetched.filter((f) => (f.level.plane?.z ?? 0) === z)
  }
  async fetchTileBytes(
    level: NVSlideLevelManifest,
    tile: NVSlideTileManifest,
    _label: string,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    this.fetched.push({ level, tile, signal })
    if (this.gated) await new Promise<void>((open) => this.gates.push(open))
    if (this.failing) throw new Error('tile fetch failed')
    const value = 10 * ((level.plane?.z ?? 0) + 1)
    const samples = new Uint16Array(tile.width * tile.height).fill(value)
    return new Uint8Array(samples.buffer)
  }
}

// 2 x 2 tiles of T px, all in view at 1:1.
const VIEW = { widthCss: 2 * T, heightCss: 2 * T, devicePixelRatio: 1 }

/** A plane slide drawn once and resident, unless `draw` is false. */
async function planeSlide(manifest = grayManifest(2), draw = true) {
  const source = new PlaneSource(manifest)
  const slide = NVSlide.fromSource(source)
  slide.setViewport({ centerX: T, centerY: T, scale: 1 })
  if (draw) {
    slide.requestVisibleTiles(VIEW)
    await waitFor(() => slide.pendingCount === 0)
  }
  return { slide, source }
}

const drawnKeys = (slide: NVSlide) => {
  const { tiles, fallback } = slide.visibleTiles(VIEW)
  return [...fallback, ...tiles].map((t) => t.key)
}

// Level 0 of plane z (the key producer is NVSlide.tileKey).
const planeLevel = (slide: NVSlide, z: number): NVSlideLevelManifest => ({
  ...(slide.manifest.levels[0] as NVSlideLevelManifest),
  plane: { z, t: 0 },
})

describe('plane state (contracts 2)', () => {
  it('P1: after a switch resolves true, samples read the new plane and nothing drawn is z0', async () => {
    const { slide, source } = await planeSlide()
    let changes = 0
    slide.addEventListener('planechange', () => changes++)
    expect(slide.sampleAt(1, 1)[0]?.stored).toBe(10)
    expect(await slide.setPlaneIndex({ z: 1, t: 0 })).toBe(true)
    expect([slide.planeIndex, changes]).toEqual([{ z: 1, t: 0 }, 1])
    expect(slide.sampleAt(1, 1)[0]?.stored).toBe(20)
    const keys = drawnKeys(slide)
    expect(keys).toHaveLength(4)
    expect(keys.filter((key) => key.startsWith('z0'))).toEqual([])
    expect(keys.every((key) => slide.cachedTile(key))).toBe(true)
    // The old plane stayed in the LRU: switching back is warm.
    const fetches = source.fetched.length
    expect(await slide.setPlaneIndex({ z: 0, t: 0 })).toBe(true)
    expect(source.fetched.length).toBe(fetches)
    expect(slide.sampleAt(1, 1)[0]?.stored).toBe(10)
    slide.dispose()
  })

  it('P2: a failed prepare leaves the plane, tiles and cache unchanged', async () => {
    const { slide, source } = await planeSlide()
    source.prepare = async () => {
      throw new Error('no such plane')
    }
    const manifest = slide.manifest
    const keys = drawnKeys(slide)
    const bytes = slide.cacheBytes
    const fetches = source.fetched.length
    await expect(slide.setPlaneIndex({ z: 1, t: 0 })).rejects.toThrow(
      'no such plane',
    )
    expect(slide.manifest).toBe(manifest)
    expect(slide.planeIndex).toEqual({ z: 0, t: 0 })
    expect(drawnKeys(slide)).toEqual(keys)
    expect(keys.every((key) => slide.cachedTile(key))).toBe(true)
    expect([slide.cacheBytes, source.fetched.length]).toEqual([bytes, fetches])
    slide.dispose()
  })

  it('P3: z0 -> 1 -> 2 in one tick: the first resolves false, only z2 commits', async () => {
    const { slide, source } = await planeSlide()
    const commits: number[] = []
    slide.addEventListener('planechange', () =>
      commits.push(slide.planeIndex.z),
    )
    const one = slide.setPlaneIndex({ z: 1, t: 0 })
    const two = slide.setPlaneIndex({ z: 2, t: 0 })
    expect([await one, await two]).toEqual([false, true])
    expect(commits).toEqual([2])
    expect(source.of(1)).toEqual([]) // superseded before its hold: no z1 load
    expect(slide.sampleAt(1, 1)[0]?.stored).toBe(30)
    slide.dispose()
  })

  it('P3: superseded during its hold, z1 resolves false and its loads count as aborted', async () => {
    const { slide, source } = await planeSlide()
    source.gated = true
    const one = slide.setPlaneIndex({ z: 1, t: 0 })
    await waitFor(() => source.of(1).length === 4)
    const aborted = slide.stats.aborted
    const two = slide.setPlaneIndex({ z: 2, t: 0 })
    expect(await one).toBe(false)
    expect(source.of(1).every((f) => f.signal?.aborted)).toBe(true)
    await waitFor(() => source.of(2).length === 4)
    source.release()
    expect(await two).toBe(true)
    await waitFor(() => slide.stats.aborted === aborted + 4)
    const z1 = planeLevel(slide, 1)
    expect(slide.cachedTile(slide.tileKey(z1, { x: 0, y: 0 }))).toBeNull()
    expect(slide.planeIndex).toEqual({ z: 2, t: 0 })
    slide.dispose()
  })

  it('P4: a z0 load that resolves after the commit is not cached', async () => {
    // Nothing drawn (a prefetch owner is not held for): the switch commits at once.
    const { slide, source } = await planeSlide(grayManifest(2), false)
    source.gated = true
    const owner = slide.createRequestOwner('prefetch')
    const level = slide.manifest.levels[0] as NVSlideLevelManifest
    owner.want(
      level.tiles.map((tile) => ({ level, tile: tile as NVSlideTileManifest })),
    )
    expect(source.of(0)).toHaveLength(4)
    expect(await slide.setPlaneIndex({ z: 1, t: 0 })).toBe(true)
    expect(source.of(0).every((f) => f.signal?.aborted)).toBe(true)
    source.release() // the z0 bytes arrive after the commit
    await waitFor(() => slide.stats.aborted === 4)
    expect([slide.stats.completed, slide.cacheBytes]).toEqual([0, 0])
    expect(slide.cachedTile(slide.tileKey(level, { x: 0, y: 0 }))).toBeNull()
    owner.release()
    slide.dispose()
  })

  it('P6: a fixed source reports {z: 1, t: 1}; {0, 0} resolves true, {1, 0} rejects', async () => {
    const slide = NVSlide.fromSource(new ConstantSource(grayManifest()))
    expect(slide.planes).toEqual({ z: 1, t: 1 })
    expect(await slide.setPlaneIndex({ z: 0, t: 0 })).toBe(true)
    await expect(slide.setPlaneIndex({ z: 1, t: 0 })).rejects.toThrow(
      RangeError,
    )
    slide.dispose()
  })

  it('P7: a plane whose sample mapping or geometry differs is rejected at commit', async () => {
    const info = [
      { name: 'c', active: true, storedToValue: { scale: 2, offset: 0 } },
    ]
    const { slide, source } = await planeSlide(grayManifest(2, {}, info))
    const changes: Array<(m: NVSlideManifest) => void> = [
      (m) => {
        m.channelInfo = [{ ...info[0], storedToValue: { scale: 3, offset: 0 } }]
      },
      (m) => {
        ;(m.levels[0] as NVSlideLevelManifest).sampleType = 'i16'
      },
      (m) => {
        ;(m.levels[0] as NVSlideLevelManifest).bitsStored = 12
      },
      (m) => {
        m.width += 1
      },
    ]
    for (const change of changes) {
      source.prepare = async (p) => {
        const m = source.planeManifest(p)
        m.levels = m.levels.map((l) => ({ ...l }))
        change(m)
        return m
      }
      await expect(slide.setPlaneIndex({ z: 1, t: 0 })).rejects.toThrow(
        RangeError,
      )
      expect(slide.planeIndex).toEqual({ z: 0, t: 0 })
    }
    expect(source.of(1)).toEqual([])
    // The same plane, unchanged, commits.
    source.prepare = async (p) => source.planeManifest(p)
    expect(await slide.setPlaneIndex({ z: 1, t: 0 })).toBe(true)
    expect(slide.sampleAt(1, 1)[0]).toMatchObject({ stored: 20, value: 40 })
    slide.dispose()
  })

  it('holds the old plane on screen until the new plane is resident', async () => {
    const { slide, source } = await planeSlide()
    source.gated = true
    let committed: boolean | undefined
    const switching = slide.setPlaneIndex({ z: 1, t: 0 }).then((ok) => {
      committed = ok
    })
    await waitFor(() => source.of(1).length === 4)
    source.release(3)
    await waitFor(() => slide.pendingCount === 1)
    // Three of four z1 tiles resident: still the whole old plane.
    expect(committed).toBeUndefined()
    expect(slide.planeIndex).toEqual({ z: 0, t: 0 })
    expect(drawnKeys(slide).every((key) => key.startsWith('z0t0/'))).toBe(true)
    expect(slide.requestVisibleTiles(VIEW).fallback).toEqual([])
    source.release()
    await switching
    expect(committed).toBe(true)
    const keys = drawnKeys(slide)
    expect(keys.every((key) => key.startsWith('z1t0/'))).toBe(true)
    expect(keys.every((key) => slide.cachedTile(key))).toBe(true)
    slide.dispose()
  })

  it('a failed tile ends the hold', async () => {
    const { slide, source } = await planeSlide()
    const error = spyOn(console, 'error').mockImplementation(() => {})
    let errors = 0
    slide.addEventListener('tileerror', () => errors++)
    source.gated = true
    const switching = slide.setPlaneIndex({ z: 1, t: 0 })
    await waitFor(() => source.of(1).length === 4)
    source.failing = true
    source.release()
    expect(await switching).toBe(true)
    expect(errors).toBe(4)
    expect(slide.planeIndex).toEqual({ z: 1, t: 0 })
    error.mockRestore()
    slide.dispose()
  })

  // Engine bug: an abort of opts.signal during the hold resolves the hold, and
  // the switch then commits with the new plane's tiles missing.
  it('an abort during the hold rejects and keeps the old plane', async () => {
    const { slide, source } = await planeSlide()
    source.gated = true
    const stop = new AbortController()
    const switching = slide.setPlaneIndex(
      { z: 1, t: 0 },
      { signal: stop.signal },
    )
    await waitFor(() => source.of(1).length === 4)
    stop.abort()
    await expect(switching).rejects.toThrow()
    expect(slide.planeIndex).toEqual({ z: 0, t: 0 })
    slide.dispose()
  })

  it('dispose aborts a pending plane switch, which settles false', async () => {
    const { slide, source } = await planeSlide()
    let seen: AbortSignal | undefined
    source.prepare = (_p, signal) =>
      new Promise((_resolve, reject) => {
        seen = signal
        signal?.addEventListener('abort', () =>
          reject(new DOMException('aborted', 'AbortError')),
        )
      })
    const switching = slide.setPlaneIndex({ z: 1, t: 0 })
    await Promise.resolve()
    slide.dispose()
    expect(seen?.aborted).toBe(true)
    expect(await switching).toBe(false)
  })

  // Engine bug: a pre-aborted signal still switched planes.
  it('a pre-aborted signal rejects AbortError without preparing; the listener goes', async () => {
    const { slide, source } = await planeSlide()
    let prepares = 0
    source.prepare = async (p) => {
      prepares++
      return source.planeManifest(p)
    }
    const stop = new AbortController()
    stop.abort()
    await expect(
      slide.setPlaneIndex({ z: 1, t: 0 }, { signal: stop.signal }),
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect([slide.planeIndex, prepares]).toEqual([{ z: 0, t: 0 }, 0])
    const live = new AbortController()
    const added = spyOn(live.signal, 'addEventListener')
    const removed = spyOn(live.signal, 'removeEventListener')
    expect(await slide.setPlaneIndex({ z: 1, t: 0 }, live)).toBe(true)
    expect(added.mock.calls).toHaveLength(1)
    expect(removed.mock.calls[0]?.[1]).toBe(added.mock.calls[0]?.[1])
    slide.dispose()
  })

  // Engine bug: with only the 3D plane drawn nothing was held, and with 2D + 3D
  // only the 2D view's tiles were.
  it('holds the 3D plane: alone, and beside the 2D view', async () => {
    for (const draw2d of [false, true]) {
      const { slide, source } = await planeSlide(grayManifest(2), false)
      const level = slide.manifest.levels[0] as NVSlideLevelManifest
      const plane = slide.createRequestOwner('plane3d')
      plane.want(
        level.tiles.map((tile) => ({
          level,
          tile: tile as NVSlideTileManifest,
        })),
      )
      // The 2D view shows tile (0, 0) only.
      if (draw2d) slide.requestVisibleTiles({ widthCss: T, heightCss: T })
      await waitFor(() => slide.pendingCount === 0)
      source.gated = true
      let committed: boolean | undefined
      const switching = slide.setPlaneIndex({ z: 1, t: 0 }).then((ok) => {
        committed = ok
      })
      await waitFor(() => source.of(1).length === 4)
      source.release(3)
      await waitFor(() => slide.pendingCount === 1)
      expect([committed, slide.planeIndex]).toEqual([undefined, { z: 0, t: 0 }])
      source.release()
      await switching
      expect(committed).toBe(true)
      const z1 = planeLevel(slide, 1)
      for (const tile of level.tiles)
        expect(
          slide.cachedTile(slide.tileKey(z1, tile as NVSlideTileManifest)),
        ).not.toBeNull()
      // A second switch before the owners want again (no frame between)
      // still holds: their z0 keys map to z2.
      let again: boolean | undefined
      const second = slide.setPlaneIndex({ z: 2, t: 0 }).then((ok) => {
        again = ok
      })
      await waitFor(() => source.of(2).length === 4)
      expect([again, slide.planeIndex]).toEqual([undefined, { z: 1, t: 0 }])
      source.release()
      await second
      expect(again).toBe(true)
      plane.release()
      slide.dispose()
    }
  })

  // Engine bug: the hold walked a placed level as a grid, holding the wrong tiles.
  it('holds a placed level by the pieces in view', async () => {
    // Three tiles in a row placed in reverse: tile 2 shows at x 0.
    const manifest = grayManifest(3)
    const l0 = manifest.levels[0] as NVSlideLevelManifest
    manifest.height = l0.height = T
    l0.rows = 1
    l0.tiles = l0.tiles.slice(0, 3)
    l0.placement = {
      width: 3 * T,
      height: T,
      pieces: [2, 1, 0].map((tile, i) => ({
        ...{ tile, sx: 0, sy: 0, sw: T, sh: T },
        ...{ dx: i * T, dy: 0 },
      })),
    }
    const source = new PlaneSource(manifest)
    const slide = NVSlide.fromSource(source)
    const screen = { widthCss: T / 2, heightCss: T, devicePixelRatio: 1 }
    slide.setViewport({ centerX: T / 4, centerY: T / 2, scale: 1 })
    const shown = slide.requestVisibleTiles(screen).tiles.map((t) => t.tile.x)
    expect(shown).toEqual([2])
    await waitFor(() => slide.pendingCount === 0)
    expect(await slide.setPlaneIndex({ z: 1, t: 0 })).toBe(true)
    expect(source.of(1).map((f) => f.tile.x)).toEqual(shown)
    slide.dispose()
  })
})

const internals = (slide: NVSlide) =>
  slide as unknown as {
    _loadQueue: { length: number }
    _activeLoads: number
  }

describe('request ownership (contracts 4)', () => {
  it('R1: a 5 x 5 view on 1 slot fetches the centre first, then by distance', async () => {
    const source = new PlaneSource(grayManifest(5))
    source.gated = true
    const slide = NVSlide.fromSource(source, { maxConcurrentLoads: 1 })
    slide.setViewport({ centerX: 2.5 * T, centerY: 2.5 * T, scale: 1 })
    slide.requestVisibleTiles({ widthCss: 5 * T, heightCss: 5 * T })
    for (let i = 1; i <= 25; i++) {
      await waitFor(() => source.fetched.length === i)
      source.release()
    }
    const dist = ({ tile }: Fetch) => (tile.x - 2) ** 2 + (tile.y - 2) ** 2
    const order = source.fetched.map(dist)
    expect(source.fetched[0]?.tile).toMatchObject({ x: 2, y: 2 })
    expect(order).toEqual([...order].sort((a, b) => a - b))
    await waitFor(() => slide.pendingCount === 0)
    slide.dispose()
  })

  it('R2: a load the view and plane3d share outlives the view, aborts on release; one fetch', async () => {
    const source = new PlaneSource(grayManifest(2))
    source.gated = true
    const slide = NVSlide.fromSource(source)
    const screen = { widthCss: T, heightCss: T }
    const level = slide.manifest.levels[0] as NVSlideLevelManifest
    const shared = level.tiles[0] as NVSlideTileManifest
    slide.setViewport({ centerX: T / 2, centerY: T / 2, scale: 1 })
    slide.requestVisibleTiles(screen)
    const plane = slide.createRequestOwner('plane3d')
    plane.want([{ level, tile: shared }])
    // The view pans to tile (1, 1): the shared load continues.
    slide.setViewport({ centerX: 1.5 * T, centerY: 1.5 * T, scale: 1 })
    slide.requestVisibleTiles(screen)
    const fetchesOf = (tile: NVSlideTileManifest) =>
      source.fetched.filter((f) => f.tile === tile)
    expect(fetchesOf(shared)).toHaveLength(1)
    expect(fetchesOf(shared)[0]?.signal?.aborted).toBe(false)
    plane.release()
    expect(fetchesOf(shared)[0]?.signal?.aborted).toBe(true)
    source.release()
    await waitFor(() => slide.stats.aborted === 1)
    expect(fetchesOf(shared)).toHaveLength(1)
    expect(slide.cachedTile(slide.tileKey(level, shared))).toBeNull()
    slide.dispose()
  })

  it('R3: a loadSampleAt aborted before it starts fetches nothing and resolves uncached', async () => {
    const source = new PlaneSource(grayManifest(2))
    source.gated = true
    const slide = NVSlide.fromSource(source, { maxConcurrentLoads: 1 })
    const stop = new AbortController()
    stop.abort()
    const early = await slide.loadSampleAt(1, 1, { signal: stop.signal })
    expect(early[0]?.missing).toBe('uncached')
    expect(source.fetched).toEqual([])
    // Queued behind another load, then aborted: dequeued, never fetched.
    const level = slide.manifest.levels[0] as NVSlideLevelManifest
    slide
      .createRequestOwner('plane3d')
      .want([{ level, tile: level.tiles[3] as NVSlideTileManifest }])
    const late = new AbortController()
    const queued = slide.loadSampleAt(1, 1, { signal: late.signal })
    late.abort()
    expect((await queued)[0]?.missing).toBe('uncached')
    expect(slide.stats.aborted).toBe(1)
    source.release()
    await waitFor(() => slide.pendingCount === 0)
    expect(source.fetched.map((f) => f.tile)).toEqual([
      level.tiles[3] as NVSlideTileManifest,
    ])
    slide.dispose()
  })

  // Engine bug: an aborted in-flight load stays in _loads until its source
  // settles, and a new owner joins it instead of starting a fresh load.
  it('a tile wanted again right after its load was aborted loads', async () => {
    const source = new PlaneSource(grayManifest(2))
    source.gated = true
    const slide = NVSlide.fromSource(source)
    const level = slide.manifest.levels[0] as NVSlideLevelManifest
    const owner = slide.createRequestOwner('plane3d')
    owner.want([{ level, tile: level.tiles[0] as NVSlideTileManifest }])
    owner.release() // aborts the fetch in flight
    const readout = slide.loadSampleAt(1, 1)
    source.release()
    await waitFor(() => source.fetched.length === 2, 500)
    source.release()
    expect((await readout)[0]?.stored).toBe(10)
    slide.dispose()
  })

  it('R5: with 200 view tiles queued on 4 slots, a thumbnail and then a prefetch tile start within 4 dequeues each', async () => {
    // L0: 16 x 16 tiles; L1: 8 x 8.
    const manifest = grayManifest(16)
    const l0 = manifest.levels[0] as NVSlideLevelManifest
    const l1: NVSlideLevelManifest = {
      ...l0,
      index: 1,
      downsample: 2,
      width: l0.width / 2,
      height: l0.height / 2,
      columns: 8,
      rows: 8,
      tiles: l0.tiles.filter((t) => t && t.x < 8 && t.y < 8),
    }
    manifest.levels.push(l1)
    const source = new PlaneSource(manifest)
    source.gated = true
    const slide = NVSlide.fromSource(source, { maxConcurrentLoads: 4 })
    const [level0, level1] = slide.manifest.levels as NVSlideLevelManifest[]
    const tilesOf = (level: NVSlideLevelManifest, n: number) =>
      level.tiles
        .slice(0, n)
        .map((tile) => ({ level, tile: tile as NVSlideTileManifest }))
    slide
      .createRequestOwner('view')
      .want(tilesOf(level0 as NVSlideLevelManifest, 204), { x: 64, y: 64 })
    expect(source.fetched).toHaveLength(4)
    const [thumbTile, prefetchTile] = tilesOf(level1 as NVSlideLevelManifest, 2)
    slide.createRequestOwner('thumbnail').want([thumbTile as Fetch])
    slide.createRequestOwner('prefetch').want([prefetchTile as Fetch])
    expect(internals(slide)._loadQueue.length).toBe(202)
    const startOf = (t?: Fetch) =>
      source.fetched.findIndex(
        (f) => f.tile === t?.tile && f.level === t?.level,
      )
    while (startOf(prefetchTile) < 0) {
      const n = source.fetched.length
      source.release(1)
      await waitFor(() => source.fetched.length === n + 1)
    }
    // Index 4 is the first dequeue after the two were queued.
    expect(startOf(thumbTile) - 4).toBeLessThan(4)
    expect(startOf(prefetchTile) - startOf(thumbTile)).toBeLessThanOrEqual(4)
    expect(internals(slide)._loadQueue.length).toBeGreaterThan(190)
    slide.dispose()
  })

  it('R6: dispose with every class queued empties the queue and settles everything', async () => {
    const source = new PlaneSource(grayManifest(4))
    source.gated = true
    const slide = NVSlide.fromSource(source, { maxConcurrentLoads: 1 })
    const level = slide.manifest.levels[0] as NVSlideLevelManifest
    const at = (x: number, y: number) => ({
      level,
      tile: level.tiles[y * 4 + x] as NVSlideTileManifest,
    })
    slide.setViewport({ centerX: T / 2, centerY: T / 2, scale: 1 })
    slide.requestVisibleTiles({ widthCss: T, heightCss: T }) // view: (0, 0), in flight
    const readout = slide.loadSampleAt(T + 1, 1) // (1, 0)
    slide.createRequestOwner('plane3d').want([at(2, 0)])
    const thumb = slide.createRequestOwner('thumbnail')
    thumb.want([at(3, 0)])
    slide.createRequestOwner('prefetch').want([at(0, 1)])
    expect(internals(slide)._loadQueue.length).toBe(4)
    slide.dispose()
    expect(internals(slide)._loadQueue.length).toBe(0)
    expect(slide.pendingCount).toBe(0)
    expect((await readout)[0]?.missing).toBe('uncached')
    expect(source.fetched).toHaveLength(1)
    expect(source.fetched[0]?.signal?.aborted).toBe(true)
    source.release()
    await waitFor(() => internals(slide)._activeLoads === 0)
    thumb.want([at(3, 1)]) // a released owner wants nothing
    expect(source.fetched).toHaveLength(1)
    expect([slide.stats.completed, slide.cacheBytes]).toEqual([0, 0])
  })

  it('R7: a still-wanted failed tile re-queues after its backoff; a readout does not retry', async () => {
    const source = new PlaneSource(grayManifest(2))
    source.failing = true
    const slide = NVSlide.fromSource(source)
    const error = spyOn(console, 'error').mockImplementation(() => {})
    const screen = { widthCss: T, heightCss: T }
    slide.setViewport({ centerX: T / 2, centerY: T / 2, scale: 1 })
    // A host redraws on 'change', as the renderers do.
    slide.addEventListener('change', () => slide.requestVisibleTiles(screen))
    slide.requestVisibleTiles(screen) // (0, 0)
    const readout = await slide.loadSampleAt(T + 1, T + 1) // (1, 1)
    expect(readout[0]?.missing).toBe('uncached')
    await waitFor(() => slide.stats.failures === 2)
    source.failing = false
    const level = slide.manifest.levels[0] as NVSlideLevelManifest
    const fetchesOf = (i: number) =>
      source.fetched.filter((f) => f.tile === level.tiles[i]).length
    expect([fetchesOf(0), fetchesOf(3)]).toEqual([1, 1])
    // The 1 s backoff's retry tick redraws: the view wants (0, 0) again.
    await waitFor(() => slide.stats.completed === 1, 3000)
    expect([fetchesOf(0), fetchesOf(3)]).toEqual([2, 1])
    expect(
      slide.cachedTile(slide.tileKey(level, { x: 0, y: 0 })),
    ).not.toBeNull()
    error.mockRestore()
    slide.dispose()
  })
})

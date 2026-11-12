// P0 contracts (plan-tile-final-contracts section 10): source lifetime,
// single-channel channelInfo, storedToValue, sampleType, channelInfoChanged and
// renderer budgets. Test ids (L1, S1, ...) are the spec's.
import { describe, expect, it, spyOn } from 'bun:test'
import NVViewGL from '@/gl/NVViewGL'
import { SlideRenderer } from '@/gl/slide'
import { log } from '@/logger'
import NVViewGPU from '@/wgpu/NVViewGPU'
import type {
  NVSlideChannelInfo,
  NVSlideLevelManifest,
  NVSlideManifest,
  NVSlideSampleArray,
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
    ).toBe(tileCapacity(base.slide.manifest, level, 1e6, undefined, budget))
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
    const samples = slide.cachedTile('L0/0/0')?.samples?.samples
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
      )
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
    // Not initialised: draw registers the budget, then does nothing.
    renderer.draw({} as WebGL2RenderingContext, [slide], screen)
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
    renderer.draw({} as WebGL2RenderingContext, [slide], screen)
    renderer.draw({} as WebGL2RenderingContext, [], screen)
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

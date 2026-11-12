import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test'

import NiiVue, { type NiiVueLocation, NVSlide } from '@/index'
import type { NVSlideTileSamples, SlideTileSource } from './NVSlide'
import { worldToSlidePixel } from './slidePlane'

const g = globalThis as Record<string, unknown>
const saved = { ImageData: g.ImageData, createImageBitmap: g.createImageBitmap }
beforeEach(() => {
  g.ImageData = class {
    constructor(
      readonly data: Uint8ClampedArray,
      readonly width: number,
      readonly height: number,
    ) {}
  }
  g.createImageBitmap = async (img: { width: number; height: number }) => ({
    width: img.width,
    height: img.height,
    close() {},
  })
})
afterEach(() => Object.assign(g, saved))

// An 8 x 8 two-channel slide in one tile, whose fetch waits for `release`;
// channel c at (x, y) stores 100 c + 8 y + x.
function gatedSlide() {
  let release = () => {}
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const tile = { x: 0, y: 0, width: 8, height: 8 }
  const source: SlideTileSource = {
    manifest: {
      id: 'sid',
      name: 'tissue',
      width: 8,
      height: 8,
      dtype: 'uint16',
      channels: 'planar',
      channelInfo: [
        { name: 'dapi', active: true },
        { name: 'gfp', active: true },
      ],
      levels: [
        {
          index: 0,
          width: 8,
          height: 8,
          downsample: 1,
          tileWidth: 8,
          tileHeight: 8,
          columns: 1,
          rows: 1,
          tiles: [tile],
        },
      ],
    },
    bind() {},
    fetchTileBytes: () => Promise.reject(new Error('samples only')),
    async fetchTileSamples(_level, t, channels): Promise<NVSlideTileSamples> {
      await gate
      const samples = new Uint16Array(64 * channels.length)
      channels.forEach((c, p) => {
        for (let i = 0; i < 64; i++) samples[p * 64 + i] = 100 * c + i
      })
      const { width, height } = t
      return { samples, width, height, bitsStored: 16, planes: channels.length }
    },
  }
  return { slide: NVSlide.fromSource(source), release }
}

const IDENTITY = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]

describe('slide plane readout', () => {
  test('worldToSlidePixel projects onto the plane and refuses off it', () => {
    const { slide } = gatedSlide()
    // Pixels 2 mm wide along x, 1 mm along -y from (10, 20, 5).
    const plane = {
      slide,
      pixelToWorld: [2, 0, 0, 0, 0, -1, 0, 0, 0, 0, 0, 0, 10, 20, 5, 1],
      tilesByLevel: new Map(),
    }
    expect(worldToSlidePixel(plane, [13, 17, 40])).toEqual({ x: 1.5, y: 3 })
    expect(worldToSlidePixel(plane, [9, 17, 5])).toBeNull()
    slide.dispose()
  })

  test('worldToSlidePixel handles micrometre pixels and refuses a collinear plane', () => {
    const { slide } = gatedSlide()
    const at = (pixelToWorld: number[]) =>
      worldToSlidePixel(
        { slide, pixelToWorld, tilesByLevel: new Map() },
        [0.00025, 0.001, 0],
      )
    // 0.25 um pixels: an absolute det threshold refused this.
    const p = at([0.00025, 0, 0, 0, 0, 0.00025, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1])
    expect(p?.x).toBeCloseTo(1, 9)
    expect(p?.y).toBeCloseTo(4, 9)
    expect(at([1, 0, 0, 0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1])).toBeNull()
    slide.dispose()
  })

  test('a slide-only scene emits, and re-emits once when the tile lands', async () => {
    const { slide, release } = gatedSlide()
    const nv = new NiiVue({ backend: 'webgl2' })
    spyOn(nv, 'drawScene').mockImplementation(() => {})
    nv.setSlidePlane(slide, { pixelToWorld: IDENTITY })
    const seen: NiiVueLocation[] = []
    nv.addEventListener('locationChange', (e) => seen.push(e.detail))
    nv.setCrosshairPos([2.5, 3.5, 0])
    expect(seen).toHaveLength(1)
    expect(seen[0].values).toEqual([])
    expect(seen[0].slide).toMatchObject({ id: 'sid', name: 'tissue' })
    expect(seen[0].slide?.samples.map((s) => s.missing)).toEqual([
      'uncached',
      'uncached',
    ])
    expect(seen[0].string).toEndWith(' tissue: - -')
    release()
    await nv.loadSlideSampleAt()
    expect(seen).toHaveLength(2)
    expect(seen[1].slide?.samples.map((s) => s.value)).toEqual([26, 126])
    expect(seen[1].string).toEndWith(' tissue: 26 126')
    // A change that leaves the samples alone (a window) does not re-emit.
    slide.setChannel(0, { calMin: 1, calMax: 9 })
    expect(seen).toHaveLength(2)
    // Off the plane: one event without a slide clears the readout, then none.
    nv.setCrosshairPos([-50, 3.5, 0])
    expect(seen).toHaveLength(3)
    expect(seen[2].slide).toBeUndefined()
    nv.setCrosshairPos([-60, 3.5, 0])
    expect(seen).toHaveLength(3)
    expect(nv.slideSampleAt()).toBeNull()
    // An explicit point is sampled even off the slide.
    expect(nv.slideSampleAt(9, 0)?.samples[0].missing).toBe('outside')
    expect(nv.slideSampleAt(3, 3)?.samples[1].value).toBe(127)
    nv.clearSlidePlane()
    expect(nv.slideSampleAt(3, 3)).toBeNull()
    expect(await nv.loadSlideSampleAt(3, 3)).toBeNull()
    slide.dispose()
  })

  test('swapping or clearing the plane re-emits the readout', () => {
    const one = gatedSlide().slide
    const two = gatedSlide().slide
    Object.assign(two, { name: 'other' })
    const nv = new NiiVue({ backend: 'webgl2' })
    spyOn(nv, 'drawScene').mockImplementation(() => {})
    const seen: NiiVueLocation[] = []
    nv.addEventListener('locationChange', (e) => seen.push(e.detail))
    nv.setSlidePlane(one, { pixelToWorld: IDENTITY })
    nv.setCrosshairPos([2, 3, 0])
    expect(seen.at(-1)?.slide?.name).toBe('tissue')
    nv.setSlidePlane(two, { pixelToWorld: IDENTITY })
    expect(seen.at(-1)?.slide?.name).toBe('other')
    const n = seen.length
    nv.clearSlidePlane()
    expect(seen).toHaveLength(n + 1)
    expect(seen.at(-1)?.slide).toBeUndefined()
    one.dispose()
    two.dispose()
  })

  test('the crosshair reaches slide pixels past the default scene extents', () => {
    const { slide } = gatedSlide()
    const nv = new NiiVue({ backend: 'webgl2' })
    spyOn(nv, 'drawScene').mockImplementation(() => {})
    // 50 mm pixels: the 8 px slide spans 0..400 mm, past the empty scene's 100.
    const scale = [50, 0, 0, 0, 0, 50, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1]
    nv.setSlidePlane(slide, { pixelToWorld: scale })
    nv.setCrosshairPos([250, 100, 0])
    expect(nv.slideSampleAt()).toMatchObject({ x: 5, y: 2 })
    // Still clamped, to the slide's far edge.
    nv.setCrosshairPos([1000, 100, 0])
    expect(nv.model.scene2mm(nv.model.scene.crosshairPos)[0]).toBeCloseTo(
      400,
      6,
    )
    slide.dispose()
  })

  test('renaming a channel re-emits the readout', () => {
    const { slide } = gatedSlide()
    const nv = new NiiVue({ backend: 'webgl2' })
    spyOn(nv, 'drawScene').mockImplementation(() => {})
    const seen: NiiVueLocation[] = []
    nv.setSlidePlane(slide, { pixelToWorld: IDENTITY })
    nv.setCrosshairPos([2, 3, 0])
    nv.addEventListener('locationChange', (e) => seen.push(e.detail))
    nv.setSlideChannel(0, { name: 'renamed' })
    expect(seen.at(-1)?.slide?.samples[0]?.name).toBe('renamed')
    slide.dispose()
  })
})

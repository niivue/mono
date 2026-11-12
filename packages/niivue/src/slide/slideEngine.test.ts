import { expect, it } from 'bun:test'
import type {
  NVSlideLevelManifest,
  NVSlideManifest,
  NVSlidePlaneAxes,
  NVSlidePlaneIndex,
  NVSlideTileManifest,
} from './NVSlide'
import { NVSlide } from './NVSlide'
import type { SlidePlaneCapable, SlideTileSource } from './slideSource'

const T = 8

function level(index: number, n: number, ds: number): NVSlideLevelManifest {
  const tiles: NVSlideTileManifest[] = []
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) tiles.push({ x, y, width: T, height: T })
  const size = T * n
  return {
    index,
    width: size,
    height: size,
    downsample: ds,
    columns: n,
    rows: n,
    codec: 'raw-gray',
    bitsStored: 16,
    tiles,
  }
}

// L0: 4 x 4 tiles, L1: 2 x 2 at downsample 2.
const MANIFEST: NVSlideManifest = {
  id: 'g',
  name: 'g',
  width: 4 * T,
  height: 4 * T,
  tileSize: T,
  dtype: 'uint16',
  channels: 'gray',
  levels: [level(0, 4, 1), level(1, 2, 2)],
}

class PlaneSource implements SlideTileSource, SlidePlaneCapable {
  readonly manifest = MANIFEST
  readonly planes: NVSlidePlaneAxes = { z: 3, t: 1 }
  gated = false
  private readonly gates: Array<() => void> = []
  bind(): void {}
  async preparePlane(p: NVSlidePlaneIndex): Promise<NVSlideManifest> {
    return {
      ...MANIFEST,
      levels: MANIFEST.levels.map((l) => ({ ...l, plane: { ...p } })),
    }
  }
  release(): void {
    for (const open of this.gates.splice(0)) open()
  }
  async fetchTileBytes(): Promise<Uint8Array> {
    if (this.gated) await new Promise<void>((open) => this.gates.push(open))
    return new Uint8Array(new Uint16Array(T * T).fill(5).buffer)
  }
}

const VIEW = { widthCss: 3 * T, heightCss: 3 * T, devicePixelRatio: 1 }

async function idle(slide: NVSlide): Promise<void> {
  while (slide.pendingCount > 0) await new Promise((r) => setTimeout(r, 2))
}

function drawnSlide(scale: number): NVSlide {
  const slide = NVSlide.fromSource(new PlaneSource())
  slide.setViewport({ centerX: 2 * T, centerY: 2 * T, scale })
  return slide
}

it('a plane switch keeps the hysteresis level, so its held tiles show', async () => {
  const slide = drawnSlide(0.8)
  expect(slide.requestVisibleTiles(VIEW).level?.index).toBe(0)
  await idle(slide)
  // 0.72 is inside the hysteresis band: L0 stays.
  slide.setViewport({ centerX: 2 * T, centerY: 2 * T, scale: 0.72 })
  expect(slide.requestVisibleTiles(VIEW).level?.index).toBe(0)
  await idle(slide)
  expect(await slide.setPlaneIndex({ z: 1, t: 0 })).toBe(true)
  const v = slide.visibleTiles(VIEW)
  expect(v.level?.index).toBe(0)
  expect(v.tiles.every((t) => slide.cachedTile(t.key))).toBe(true)
  slide.dispose()
})

it('a plane switch at the same level index sends no levelchange', async () => {
  const slide = drawnSlide(1)
  slide.requestVisibleTiles(VIEW)
  await idle(slide)
  let changes = 0
  slide.addEventListener('levelchange', () => changes++)
  expect(await slide.setPlaneIndex({ z: 1, t: 0 })).toBe(true)
  slide.requestVisibleTiles(VIEW)
  expect(changes).toBe(0)
  slide.dispose()
})

it('a load shared by equal-rank owners keeps the nearest focus', () => {
  const source = new PlaneSource()
  source.gated = true
  const slide = NVSlide.fromSource(source, { maxConcurrentLoads: 1 })
  const l0 = slide.manifest.levels[0] as NVSlideLevelManifest
  const tiles = l0.tiles.map((tile) => ({
    level: l0,
    tile: tile as NVSlideTileManifest,
  }))
  const near = slide.createRequestOwner('plane3d')
  const far = slide.createRequestOwner('plane3d')
  near.want(tiles, { x: 0, y: 0 })
  far.want(tiles, { x: 4 * T, y: 4 * T })
  const loads = (slide as unknown as { _loads: Map<string, { dist: number }> })
    ._loads
  const key = slide.tileKey(l0, { x: 1, y: 0 })
  // Tile (1,0) centre (12,4): 12^2 + 4^2 from the near focus.
  expect(loads.get(key)?.dist).toBe(160)
  // The near owner moves away: its old focus no longer counts.
  near.want(tiles, { x: 4 * T, y: 0 })
  expect(loads.get(key)?.dist).toBe(20 * 20 + 4 * 4)
  slide.dispose()
})

it('no change event after dispose', async () => {
  const source = new PlaneSource()
  source.gated = true
  const slide = NVSlide.fromSource(source)
  slide.setViewport({ centerX: 2 * T, centerY: 2 * T, scale: 1 })
  slide.requestVisibleTiles(VIEW)
  await new Promise((r) => setTimeout(r, 5))
  slide.dispose()
  let changes = 0
  slide.addEventListener('change', () => changes++)
  source.release()
  await new Promise((r) => setTimeout(r, 20))
  expect(changes).toBe(0)
})

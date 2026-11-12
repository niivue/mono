import { registerScenes, type Scene } from './renderHarness'

// Reference images for scalar slide tiles fused on the GPU (#159), drawn as a
// slide plane in the 3D render tile (slidePlaneRender.ts) seen from above: six
// u16 channels on a 2 x 2-tile slide, two channels half-bright in each 8 px
// block, through the additive blend, a W/L change and hidden channels, and
// back. Samples are multiples of 10 and windows 0..2550 or 0..1275, so every
// windowed level is an exact integer (no rounding tie to differ by GPU). See
// renderHarness.ts for how scenes run and how to update the references.

type Slide = {
  setChannel(c: number, update: Record<string, unknown>): void
  setChannelBlend(blend: 'max' | 'additive'): void
  cachedTile(key: string): unknown
  addEventListener(type: 'change', listener: () => void): void
  removeEventListener(type: 'change', listener: () => void): void
}
type SlideLib = {
  NVSlide: { fromSource(source: unknown): Slide }
  axialPlaneTransform(
    width: number,
    height: number,
    extent: Record<string, number | boolean>,
  ): number[]
}
type Stash = { __e2e: Record<string, unknown> }

const SCENES: Scene[] = [
  {
    name: 'slide-channels',
    options: { azimuth: 0, elevation: 90 },
    setup: async ({ nv, lib, p }) => {
      const { NVSlide, axialPlaneTransform } = lib as unknown as SlideLib
      nv.sliceType = lib.SLICE_TYPE.RENDER
      await nv.loadVolumes([{ url: p.anatomy(), opacity: 0 }])
      const n = 32
      const t = 16
      const tiles = []
      for (let y = 0; y < 2; y++)
        for (let x = 0; x < 2; x++) tiles.push({ x, y, width: t, height: t })
      // Black at level 0 (blue2cyan and redyell are not).
      const colormaps = ['red', 'green', 'blue', 'violet', 'gray', 'green']
      const slide = NVSlide.fromSource({
        manifest: {
          id: 'channels',
          name: 'channels',
          width: n,
          height: n,
          dtype: 'uint16',
          channels: 'planar',
          channelInfo: colormaps.map((colormap, c) => ({
            name: `c${c}`,
            colormap,
            window: { calMin: 0, calMax: 2550 },
            active: true,
          })),
          levels: [
            {
              index: 0,
              width: n,
              height: n,
              downsample: 1,
              tileWidth: t,
              tileHeight: t,
              columns: 2,
              rows: 2,
              bitsStored: 12,
              tiles,
            },
          ],
        },
        bind() {},
        fetchTileBytes: async () => new Uint8Array(0),
        fetchTileSamples: async (
          _level: unknown,
          tile: { x: number; y: number },
          channels: number[],
        ) => {
          const samples = new Uint16Array(t * t * channels.length)
          channels.forEach((c, plane) => {
            for (let y = 0; y < t; y++)
              for (let x = 0; x < t; x++) {
                const bx = (tile.x * t + x) >> 3
                const by = (tile.y * t + y) >> 3
                // Two channels half-bright per block: they overlap.
                samples[(plane * t + y) * t + x] =
                  (bx + by * 4 + c) % 3 === 0 ? 1270 : 10 * ((bx + by + c) % 4)
              }
          })
          return {
            samples,
            width: t,
            height: t,
            bitsStored: 12,
            planes: channels.length,
          }
        },
      })
      ;(globalThis as unknown as Stash).__e2e = { slide }
      nv.setSlidePlane(slide as never, {
        pixelToWorld: axialPlaneTransform(n, n, {
          xmin: -14,
          xmax: 14,
          ymin: -14,
          ymax: 14,
          z: 0,
          flipY: false,
        }),
        levelIndex: 0,
      })
      // Tiles load once the plane is drawn; the slide's change redraws.
      const keys = ['L0/0/0', 'L0/1/0', 'L0/0/1', 'L0/1/1']
      await new Promise<void>((resolve) => {
        const loaded = () => {
          if (!keys.every((k) => slide.cachedTile(k))) return
          slide.removeEventListener('change', loaded)
          resolve()
        }
        slide.addEventListener('change', loaded)
        loaded()
      })
    },
    steps: [
      {
        name: 'additive',
        run: async () => {
          const { slide } = (globalThis as unknown as Stash).__e2e as {
            slide: Slide
          }
          slide.setChannelBlend('additive')
        },
      },
      {
        // Re-fused from the kept samples: the change reaches the screen with
        // no refetch.
        name: 'window',
        run: async () => {
          const { slide } = (globalThis as unknown as Stash).__e2e as {
            slide: Slide
          }
          for (const c of [3, 4, 5]) slide.setChannel(c, { calMax: 1275 })
        },
      },
      {
        name: 'hidden',
        run: async () => {
          const { slide } = (globalThis as unknown as Stash).__e2e as {
            slide: Slide
          }
          for (const c of [1, 3, 5]) slide.setChannel(c, { visible: false })
        },
      },
      {
        // Back to the loaded state: the same picture as setup.
        name: 'restored',
        sameAs: 'slide-channels',
        run: async () => {
          const { slide } = (globalThis as unknown as Stash).__e2e as {
            slide: Slide
          }
          slide.setChannelBlend('max')
          for (const c of [1, 3, 5]) slide.setChannel(c, { visible: true })
          for (const c of [3, 4, 5]) slide.setChannel(c, { calMax: 2550 })
          // Showing a channel the tiles were fetched without refetches them.
          const keys = ['L0/0/0', 'L0/1/0', 'L0/0/1', 'L0/1/1']
          await new Promise<void>((resolve) => {
            const loaded = () => {
              if (!keys.every((k) => slide.cachedTile(k))) return
              slide.removeEventListener('change', loaded)
              resolve()
            }
            slide.addEventListener('change', loaded)
            loaded()
          })
        },
      },
    ],
  },
]

registerScenes(SCENES)

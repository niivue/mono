import { registerScenes, type Scene } from './renderHarness'

// Reference images for VOLUME_RENDER_MODE.CINEMATIC. Its sampling is seeded
// per pixel and frame, so a fixed `maxFrames` refines to the same picture on
// every run, and the harness waits for every tile to reach it. Its settings
// (merge, document round trip) are tested in src/loadDocument.roundtrip.test.ts.
// See renderHarness.ts for how scenes run and how to update the references.

const RENDER = 4
const CINEMATIC = 3

// Warnings and page errors a scene collects; the shared page's reset deletes it.
type Stash = { __e2e: { warnings: string[]; errors: string[] } }

const SCENES: Scene[] = [
  {
    // Both backends draw CINEMATIC (not a COMPOSITE stand-in), refine to
    // maxFrames and stop, and free everything when the mode is left.
    name: 'cinematic',
    options: {
      sliceType: RENDER,
      volumeRenderMode: CINEMATIC,
      volumeCinematic: { maxFrames: 8 },
    },
    setup: async ({ nv, view, p, check, settle }) => {
      await nv.loadVolumes([{ url: p.anatomy(), calMin: 0, calMax: 255 }])
      await settle()
      const cine = view().cinematicRenderer
      const frames = [...cine.tiles.values()].map((t) => t.frame)
      check(frames.length === 1 && frames[0] === 8, `frames ${frames}`)
      // Converged: the self-driven loop schedules nothing more.
      const v = view()
      const render = v.render
      let renders = 0
      v.render = () => {
        renders++
        render.call(v)
      }
      for (let i = 0; i < 5; i++)
        await new Promise((r) => requestAnimationFrame(r))
      v.render = render
      check(renders === 0, `${renders} renders after convergence`)
    },
    steps: [
      {
        name: 'composite',
        run: async ({ nv, view, lib, check, settle }) => {
          nv.volumeRenderMode = lib.VOLUME_RENDER_MODE.COMPOSITE
          await settle()
          const cine = view().cinematicRenderer as unknown as {
            isReady: boolean
            tiles: Map<unknown, unknown>
          }
          check(cine.isReady, 'renderer still ready')
          check(cine.tiles.size === 0, `${cine.tiles.size} tiles left`)
        },
      },
    ],
  },
  {
    // Statistical overlays use the standard controls: thresholds, negative
    // colormap, opacity, visibility, colormaps, affine, data, clip planes.
    // The anatomy is transparent, so the statistics are volumes in their own
    // right, on a different grid (8^3 at 2 mm) from the base.
    name: 'cinematic-stats',
    options: {
      sliceType: RENDER,
      volumeRenderMode: CINEMATIC,
      volumeCinematic: { maxFrames: 2 },
      azimuth: 180,
      elevation: 0,
    },
    setup: async ({ nv, p }) => {
      const errors: string[] = []
      addEventListener('error', (e) => errors.push(e.message))
      ;(globalThis as unknown as Stash).__e2e = { warnings: [], errors }
      nv.addColormap('cinematic_empty', {
        R: [0, 0],
        G: [0, 0],
        B: [0, 0],
        A: [0, 0],
      })
      const values = new Float32Array(8 ** 3).fill(2)
      for (let z = 2; z < 6; z++)
        for (let y = 2; y < 6; y++)
          for (let x = 2; x < 6; x++)
            values[x + 8 * (y + 8 * z)] = x < 4 ? 4 : -4
      await nv.loadVolumes([
        {
          url: p.nifti({
            name: 'base.nii',
            dims: [16, 16, 16],
            img: new Uint8Array(16 ** 3).fill(100),
          }),
          colormap: 'cinematic_empty',
          calMin: 0,
          calMax: 255,
        },
        {
          url: p.nifti({
            name: 'stats.nii',
            dims: [8, 8, 8],
            mm: 2,
            datatype: 16,
            img: values,
          }),
          colormap: 'redyell',
          colormapNegative: 'winter',
          calMin: 3,
          calMax: 6,
          calMinNeg: -3,
          calMaxNeg: -6,
        },
      ])
    },
    steps: [
      {
        name: 'negative-only',
        run: async ({ nv }) => {
          await nv.setVolume(1, { calMin: 5, calMax: 6 })
        },
      },
      {
        name: 'thresholded',
        run: async ({ nv }) => {
          await nv.setVolume(1, { calMinNeg: -5, calMaxNeg: -6 })
        },
      },
      {
        name: 'restored',
        sameAs: 'cinematic-stats',
        run: async ({ nv }) => {
          await nv.setVolume(1, { calMin: 3, calMinNeg: -3 })
        },
      },
      {
        name: 'translucent',
        run: async ({ nv }) => {
          await nv.setVolume(1, { opacity: 0.1 })
        },
      },
      {
        name: 'hidden',
        sameAs: 'cinematic-stats--thresholded',
        run: async ({ nv }) => {
          await nv.setVolume(1, { opacity: 1, visible: false })
        },
      },
      {
        name: 'recoloured',
        run: async ({ nv }) => {
          await nv.setVolume(1, {
            visible: true,
            colormap: 'winter',
            colormapNegative: 'redyell',
          })
        },
      },
      {
        name: 'moved',
        sameAs: 'cinematic-stats--thresholded',
        run: async ({ nv }) => {
          await nv.setVolumeAffine(1, [
            [2, 0, 0, 40],
            [0, 2, 0, -8],
            [0, 0, 2, -8],
            [0, 0, 0, 1],
          ])
        },
      },
      {
        name: 'realigned',
        sameAs: 'cinematic-stats--recoloured',
        run: async ({ nv }) => {
          await nv.resetVolumeAffine(1)
        },
      },
      {
        name: 'cleared-data',
        sameAs: 'cinematic-stats--thresholded',
        run: async ({ nv }) => {
          ;(globalThis as unknown as { __values?: Float32Array }).__values =
            Float32Array.from(nv.volumes[1].img as Float32Array)
          await nv.updateVolumeData(1, new Float32Array(8 ** 3))
        },
      },
      {
        // A clip plane that misses the statistics changes nothing.
        name: 'outside-clip',
        sameAs: 'cinematic-stats--recoloured',
        run: async ({ nv }) => {
          const g = globalThis as unknown as { __values: Float32Array }
          await nv.updateVolumeData(1, g.__values)
          nv.setClipPlanes([[-0.9, 0, 0]])
        },
      },
      {
        // clipPlaneOverlay clips the overlays too.
        name: 'clipped',
        sameAs: 'cinematic-stats--thresholded',
        run: async ({ nv, check }) => {
          nv.clipPlaneOverlay = true
          const { errors } = (globalThis as unknown as Stash).__e2e
          check(errors.length === 0, `page errors: ${errors}`)
        },
      },
    ],
  },
  {
    // Overlays draw over a hidden background, whether it is hidden by
    // opacity 0 or by `visible`.
    name: 'cinematic-hidden-background',
    options: {
      sliceType: RENDER,
      volumeRenderMode: CINEMATIC,
      volumeCinematic: { maxFrames: 2 },
      azimuth: 180,
      elevation: 0,
    },
    setup: async ({ nv, p }) => {
      const values = new Float32Array(16 ** 3)
      for (let z = 4; z < 12; z++)
        for (let y = 4; y < 12; y++)
          for (let x = 4; x < 12; x++) values[x + 16 * (y + 16 * z)] = 4
      await nv.loadVolumes([
        {
          url: p.nifti({
            name: 'base.nii',
            dims: [16, 16, 16],
            img: new Uint8Array(16 ** 3).fill(100),
          }),
          calMin: 0,
          calMax: 255,
        },
        {
          url: p.nifti({
            name: 'stats.nii',
            dims: [16, 16, 16],
            datatype: 16,
            img: values,
          }),
          colormap: 'redyell',
          calMin: 3,
          calMax: 6,
        },
      ])
      await nv.setVolume(0, { opacity: 0 })
    },
    steps: [
      {
        name: 'invisible',
        sameAs: 'cinematic-hidden-background',
        run: async ({ nv }) => {
          await nv.setVolume(0, { opacity: 1, visible: false })
        },
      },
    ],
  },
  {
    // Overlay alpha matches the classic march on anisotropic voxels: 4 mm
    // slices seen from above, so a ray crosses one overlay voxel (a per-mm
    // correction would count ~4 samples, ~4x the alpha). The background is
    // transparent, so the canvas alpha is the overlay's.
    name: 'cinematic-anisotropic',
    options: {
      sliceType: RENDER,
      volumeRenderMode: CINEMATIC,
      volumeCinematic: { maxFrames: 32 },
      isOverlayOpacityCorrected: true,
      backgroundColor: [0, 0, 0, 0],
      azimuth: 0,
      elevation: 90,
    },
    setup: async ({ nv, lib, p, check, settle }) => {
      nv.addColormap('cinematic_empty', {
        R: [0, 0],
        G: [0, 0],
        B: [0, 0],
        A: [0, 0],
      })
      const affine = [1, 0, 0, -8, 0, 1, 0, -8, 0, 0, 4, -32, 0, 0, 0, 1]
      const values = new Float32Array(16 ** 3)
      for (let i = 0; i < 256; i++) values[i + 256 * 8] = 4
      await nv.loadVolumes([
        {
          url: p.nifti({
            name: 'base.nii',
            dims: [16, 16, 16],
            mm: [1, 1, 4],
            affine,
            img: new Uint8Array(16 ** 3).fill(100),
          }),
          colormap: 'cinematic_empty',
          calMin: 0,
          calMax: 255,
        },
        {
          url: p.nifti({
            name: 'stats.nii',
            dims: [16, 16, 16],
            mm: [1, 1, 4],
            affine,
            datatype: 16,
            img: values,
          }),
          colormap: 'redyell',
          calMin: 3,
          calMax: 6,
          opacity: 0.1,
        },
      ])
      const centreAlpha = async () => {
        await settle()
        const img = nv.getCanvasImage()
        if (!img) throw new Error('getCanvasImage drew no frame')
        return img.data[4 * (80 * img.width + 80) + 3]
      }
      const cinematic = await centreAlpha()
      nv.volumeRenderMode = lib.VOLUME_RENDER_MODE.COMPOSITE
      const classic = await centreAlpha()
      nv.volumeRenderMode = lib.VOLUME_RENDER_MODE.CINEMATIC
      check(classic > 10, `classic alpha ${classic}`)
      check(
        Math.abs(cinematic - classic) <= 6,
        `cinematic alpha ${cinematic} vs classic ${classic}`,
      )
    },
  },
  {
    // An affine change moves the volume in the cinematic geometry.
    name: 'cinematic-affine',
    options: {
      sliceType: RENDER,
      volumeRenderMode: CINEMATIC,
      volumeCinematic: { maxFrames: 2 },
    },
    setup: async ({ nv, view, p, check, settle }) => {
      await nv.loadVolumes([{ url: p.anatomy(), calMin: 0, calMax: 255 }])
      await settle()
      const before = Array.from(view().cinematicRenderer.geometry.mm2frac)
      const affine = nv.getVolumeAffine(0)
      affine[0][3] += 8
      await nv.setVolumeAffine(0, affine)
      await settle()
      const after = Array.from(view().cinematicRenderer.geometry.mm2frac)
      // frac = mm2frac * mm: 8 mm over the x extent of the volume.
      const frac2mm = nv.volumes[0].frac2mm as Float32Array
      const shift = (before[12] - after[12]) * frac2mm[0]
      check(Math.abs(shift - 8) < 1e-3, `shift ${shift}`)
    },
  },
  {
    // An RGB background falls back to COMPOSITE, with a warning.
    name: 'cinematic-rgb',
    options: {
      sliceType: RENDER,
      volumeRenderMode: CINEMATIC,
      volumeCinematic: { maxFrames: 2 },
    },
    setup: async ({ nv, view, p, check, settle }) => {
      const warnings: string[] = []
      const warn = console.warn
      console.warn = (...a: unknown[]) => {
        warnings.push(a.map(String).join(' '))
        warn(...a)
      }
      await nv.loadVolumes([{ url: p.rgb() }])
      await settle()
      console.warn = warn
      const tiles = view().cinematicRenderer.tiles.size
      check(tiles === 0, `${tiles} cinematic tiles`)
      check(
        warnings.some((w) => w.includes('RGB/RGBA')),
        `warnings: ${warnings}`,
      )
    },
  },
  {
    // A drawing is not drawn by CINEMATIC: it warns.
    name: 'cinematic-drawing',
    options: {
      sliceType: RENDER,
      volumeRenderMode: CINEMATIC,
      volumeCinematic: { maxFrames: 2 },
    },
    setup: async ({ nv, p, check, settle }) => {
      await nv.loadVolumes([{ url: p.anatomy(), calMin: 0, calMax: 255 }])
      await settle()
      const warnings: string[] = []
      const warn = console.warn
      console.warn = (...a: unknown[]) => {
        warnings.push(a.map(String).join(' '))
        warn(...a)
      }
      const ctx = nv.createExtensionContext()
      ctx.createEmptyDrawing()
      ctx.drawing?.update(p.drawingBitmap())
      await settle()
      console.warn = warn
      check(
        warnings.some((w) => w.includes('drawing layer')),
        `warnings: ${warnings}`,
      )
    },
  },
  {
    // A label volume survives a hidden background; with nothing visible the
    // tile is released.
    name: 'cinematic-labels',
    options: {
      sliceType: RENDER,
      volumeRenderMode: CINEMATIC,
      volumeCinematic: { maxFrames: 2 },
    },
    setup: async ({ nv, view, p, check, settle }) => {
      nv.addColormap('e2eOctants', {
        R: [0, 230, 0, 0, 230, 230, 0, 255, 128],
        G: [0, 25, 200, 0, 230, 0, 230, 128, 128],
        B: [0, 75, 0, 230, 0, 230, 230, 0, 255],
        A: [0, 255, 255, 255, 255, 255, 255, 255, 255],
        I: [0, 1, 2, 3, 4, 5, 6, 7, 8],
        labels: ['', 'a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'],
      })
      await nv.loadVolumes([
        { url: p.anatomy() },
        { url: p.labels(), colormap: 'e2eOctants' },
      ])
      await nv.setVolume(0, { visible: false })
      await settle()
      const frames = [...view().cinematicRenderer.tiles.values()].map(
        (t) => t.frame,
      )
      check(frames.length === 1 && frames[0] === 2, `frames ${frames}`)
    },
    steps: [
      {
        name: 'nothing-visible',
        run: async ({ nv, view, check, settle }) => {
          await nv.setVolume(1, { visible: false })
          await settle()
          const tiles = view().cinematicRenderer.tiles.size
          check(tiles === 0, `${tiles} tiles with nothing visible`)
        },
      },
    ],
  },
  {
    // A negative clip alpha tints the cinematic cut face (here green); 0
    // leaves it untinted.
    name: 'cinematic-clip',
    options: {
      sliceType: RENDER,
      volumeRenderMode: CINEMATIC,
      volumeCinematic: { maxFrames: 2 },
      azimuth: 180,
      elevation: 0,
    },
    setup: async ({ nv, p }) => {
      await nv.loadVolumes([{ url: p.anatomy(), calMin: 0, calMax: 255 }])
      nv.setClipPlanes([[0, 180, 0]])
      nv.clipPlaneColor = [0, 1, 0, 0]
    },
    steps: [
      {
        name: 'tinted',
        run: async ({ nv }) => {
          nv.clipPlaneColor = [0, 1, 0, -1]
        },
      },
    ],
  },
]

registerScenes(SCENES)

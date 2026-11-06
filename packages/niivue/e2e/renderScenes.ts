import type { Scene } from './renderHarness'

// The basic scenes of the reference-image render tier (render-reference.spec.ts):
// one per major render path, each on tiny synthetic data (the Phantoms in
// renderHarness.ts) on a fixed camera. See renderHarness.ts for how a scene
// runs; the other render-*.spec.ts files hold scenes for narrower features.

export const SCENES: Scene[] = [
  {
    name: 'axial',
    setup: async ({ nv, lib, p }) => {
      nv.sliceType = lib.SLICE_TYPE.AXIAL
      await nv.loadVolumes([{ url: p.anatomy() }])
    },
  },
  {
    name: 'coronal',
    setup: async ({ nv, lib, p }) => {
      nv.sliceType = lib.SLICE_TYPE.CORONAL
      await nv.loadVolumes([{ url: p.anatomy() }])
    },
  },
  {
    name: 'sagittal',
    setup: async ({ nv, lib, p }) => {
      nv.sliceType = lib.SLICE_TYPE.SAGITTAL
      await nv.loadVolumes([{ url: p.anatomy() }])
    },
  },
  {
    // 2x2 grid: three slices and the 3D render tile.
    name: 'multiplanar',
    setup: async ({ nv, lib, p }) => {
      nv.sliceType = lib.SLICE_TYPE.MULTIPLANAR
      nv.multiplanarType = lib.MULTIPLANAR_TYPE.GRID
      nv.showRender = lib.SHOW_RENDER.ALWAYS
      await nv.loadVolumes([{ url: p.anatomy() }])
    },
  },
  {
    name: 'crosshair',
    setup: async ({ nv, lib, p }) => {
      nv.sliceType = lib.SLICE_TYPE.AXIAL
      // The 2D crosshair is the same lit cylinder as the 3D one.
      nv.is3DCrosshairVisible = true
      nv.crosshairWidth = 2
      nv.crosshairColor = [0, 1, 0, 1]
      nv.crosshairGap = 0
      await nv.loadVolumes([{ url: p.anatomy() }])
      // Off-centre, so a crosshair drawn at the wrong position shows.
      nv.crosshairPos = [0.3, 0.65, 0.5]
    },
  },
  {
    name: 'render',
    setup: async ({ nv, lib, p }) => {
      nv.sliceType = lib.SLICE_TYPE.RENDER
      await nv.loadVolumes([{ url: p.anatomy(), calMin: 0, calMax: 255 }])
    },
  },
  {
    name: 'overlay',
    setup: async ({ nv, lib, p }) => {
      nv.sliceType = lib.SLICE_TYPE.AXIAL
      await nv.loadVolumes([
        { url: p.anatomy() },
        {
          url: p.stats(),
          colormap: 'warm',
          colormapNegative: 'winter',
          calMin: 1,
          calMax: 4,
        },
      ])
    },
  },
  {
    // The only scene with text: the colorbar's tick labels.
    name: 'colorbar',
    setup: async ({ nv, lib, p }) => {
      nv.sliceType = lib.SLICE_TYPE.AXIAL
      nv.isColorbarVisible = true
      await nv.loadVolumes([
        { url: p.anatomy(), isColorbarVisible: false },
        { url: p.stats(), colormap: 'warm', calMin: 1, calMax: 4 },
      ])
    },
  },
  {
    name: 'labels',
    setup: async ({ nv, lib, p }) => {
      nv.sliceType = lib.SLICE_TYPE.CORONAL
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
        { url: p.labels(), colormap: 'e2eOctants', opacity: 0.6 },
      ])
    },
  },
  {
    name: 'drawing',
    setup: async ({ nv, lib, p }) => {
      nv.sliceType = lib.SLICE_TYPE.AXIAL
      await nv.loadVolumes([{ url: p.anatomy() }])
      const ctx = nv.createExtensionContext()
      ctx.createEmptyDrawing()
      ctx.drawing?.update(p.drawingBitmap())
    },
  },
  {
    name: 'mesh',
    setup: async ({ nv, lib, p }) => {
      nv.sliceType = lib.SLICE_TYPE.RENDER
      await nv.loadMeshes([{ url: p.sphereMesh(), color: [0.9, 0.7, 0.3, 1] }])
    },
  },
  {
    name: 'mesh-layer',
    setup: async ({ nv, lib, p }) => {
      nv.sliceType = lib.SLICE_TYPE.RENDER
      await nv.loadMeshes([
        {
          url: p.sphereMesh(),
          layers: [
            {
              url: p.sphereLayer(),
              colormap: 'warm',
              colormapNegative: 'winter',
              calMin: 2,
              calMax: 12,
              opacity: 1,
            },
          ],
        },
      ])
    },
  },
]

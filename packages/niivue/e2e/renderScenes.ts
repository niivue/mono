import type NiiVue from '../src/NVControl'

// Scenes for the reference-image render tier (render-reference.spec.ts).
//
// Each scene renders tiny synthetic data (the Phantoms below, built in the
// page by renderScene in the spec) on a fixed camera, so a regression in a major render path changes
// the image. Every scene runs on WebGL2 and WebGPU, against one reference PNG
// per backend that is shared by every platform (Metal, SwiftShader).
//
// `setup` runs IN THE PAGE: it is sent as source text, so it may only use its
// arguments (no closures over this module). The instance it gets is already
// attached to a SIZE x SIZE canvas with the deterministic base options in
// render-reference.spec.ts; `setup` sets the view and loads data.

/** Module exports a scene needs (the subset of `/src/index.ts` it reads). */
export type SceneLib = {
  SLICE_TYPE: Record<
    'AXIAL' | 'CORONAL' | 'SAGITTAL' | 'MULTIPLANAR' | 'RENDER',
    number
  >
  SHOW_RENDER: Record<'NEVER' | 'ALWAYS' | 'AUTO', number>
  MULTIPLANAR_TYPE: Record<'AUTO' | 'COLUMN' | 'GRID' | 'ROW', number>
}

/** Synthetic data, built in the page. The 32^3 volumes share one grid. */
export type Phantoms = {
  /**
   * 32^3 uint8, 1 mm: an ellipsoid with an x-gradient (40..164), a bright
   * sphere (220) off-centre and an anisotropic box (255) to the left, so
   * every axis and flip shows.
   */
  anatomy: () => File
  /** Same grid: the ellipsoid split into octants labelled 1..8 (uint8). */
  labels: () => File
  /** 16^3 float32 at 2 mm, same field of view: a +5 and a -5 Gaussian blob. */
  stats: () => File
  /** Icosphere (radius 12 mm, 162 vertices) as OBJ text. */
  sphereMesh: () => File
  /** Per-vertex scalar layer for `sphereMesh`: each vertex's z (-12..12). */
  sphereLayer: () => File
  /** A drawing on the `anatomy` grid: a 1-box, a 2-disc and a 3-bar. */
  drawingBitmap: () => Uint8Array
}

export type SceneContext = { nv: NiiVue; lib: SceneLib; p: Phantoms }

export type Scene = {
  name: string
  setup: (ctx: SceneContext) => Promise<void>
}

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

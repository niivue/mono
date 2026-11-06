import { expect } from '@playwright/test'
import type NiiVue from '../src/NVControl'
import { webgpuLaunchOptions } from './launchOptions'
import { test } from './sharedPage'

// The reference-image render tier. A spec lists its scenes and calls
// `registerScenes`; each scene is drawn on WebGL2 and WebGPU and every capture
// is compared with a committed PNG in
// e2e/__snapshots__/<spec file>/<capture>-<backend>.png. There is ONE reference
// set for every platform: the same PNG must match real Metal
// (PLAYWRIGHT_CHROMIUM_CHANNEL=chromium) and SwiftShader (the default headless
// shell, as on the Ubuntu CI job). The tolerance lives in playwright.config.ts
// (`expect.toMatchSnapshot`). Update the references with
//   bunx playwright test <spec> --update-snapshots
// and check the new PNGs on the other renderer before committing them.
//
// `setup` and each step's `run` run IN THE PAGE: they are sent as source text,
// so they may only use their `SceneContext` argument (no closures over the
// spec module, no imports).

/** Module exports a scene needs (the subset of `/src/index.ts` it reads). */
export type SceneLib = {
  SLICE_TYPE: Record<
    'AXIAL' | 'CORONAL' | 'SAGITTAL' | 'MULTIPLANAR' | 'RENDER',
    number
  >
  SHOW_RENDER: Record<'NEVER' | 'ALWAYS' | 'AUTO', number>
  MULTIPLANAR_TYPE: Record<'AUTO' | 'COLUMN' | 'GRID' | 'ROW', number>
  VOLUME_RENDER_MODE: Record<
    'COMPOSITE' | 'MAXIMUM' | 'SLICES' | 'CINEMATIC',
    number
  >
  chunkVolumeGrid: (
    dims: number[],
    grid: number[],
    deviceLimit: number,
    halo: number[],
  ) => unknown
}

/** A NIfTI built in the page by `Phantoms.nifti`. */
export type NiftiSpec = {
  name: string
  /** Voxels per axis. */
  dims: [number, number, number]
  /** Isotropic voxel size, or one per axis. Default 1. */
  mm?: number | [number, number, number]
  /** NIfTI datatype code: 2 uint8, 4 int16, 16 float32, 128 RGB24. Default 2. */
  datatype?: number
  /** Voxels, frame after frame; `frames` > 1 makes a 4D image. */
  img: Uint8Array | Int16Array | Float32Array
  frames?: number
  /** Row-major 4x4. Default: the voxel grid centred on the origin. */
  affine?: number[]
  /** NIfTI intent code (1002 is NIFTI_INTENT_LABEL). */
  intent?: number
}

/**
 * Synthetic data, built in the page. The 32^3 volumes share one 1 mm grid
 * centred on the origin, so any of them can overlay any other.
 */
export type Phantoms = {
  /** Side of the shared grid (32). */
  N: number
  /** A uint8 image on the shared grid from a per-voxel function. */
  grid: (f: (x: number, y: number, z: number) => number) => Uint8Array
  /** A NIfTI file from raw voxels. */
  nifti: (spec: NiftiSpec) => File
  /**
   * 32^3 uint8, 1 mm: an ellipsoid with an x-gradient (40..164), a bright
   * sphere (220) off-centre and an anisotropic box (255) to the left, so
   * every axis and flip shows.
   */
  anatomy: (name?: string) => File
  /** The voxels of `anatomy`. */
  anatomyImg: () => Uint8Array
  /**
   * `anatomy`'s voxels on a grid rotated 20 degrees about y and 10 about x, so
   * an axial voxel plane is oblique in world space.
   */
  oblique: () => File
  /** Same grid: the ellipsoid split into octants labelled 1..8 (uint8). */
  labels: () => File
  /** Same grid: 1 inside a smaller ellipsoid, 0 outside (uint8). */
  mask: () => File
  /** Same grid: float32 rising from 0 at y = 0 to 1 at y = 31. */
  ramp: () => File
  /** Same grid: RGB24, red along x, green along y, blue inside the ellipsoid. */
  rgb: () => File
  /** 16^3 float32 at 2 mm, same field of view: a +5 and a -5 Gaussian blob. */
  stats: () => File
  /** Wavefront OBJ from vertices (mm) and 0-based triangles. */
  obj: (name: string, verts: number[][], faces: number[][]) => File
  /** Icosphere (162 vertices) as OBJ text; default radius 12 at the origin. */
  sphereMesh: (opts?: {
    name?: string
    center?: [number, number, number]
    radius?: number
  }) => File
  /** Per-vertex scalar layer for `sphereMesh`: each vertex's z (-12..12). */
  sphereLayer: () => File
  /** A drawing on the `anatomy` grid: a 1-box, a 2-disc and a 3-bar. */
  drawingBitmap: () => Uint8Array
  /**
   * 32x32x4 int16 NIFTI_INTENT_LABEL volume: ID 3 on the left half, ID 20000
   * on the right. With `frames` 2, frame 0 holds only the 3s and frame 1 only
   * the 20000s.
   */
  labelHalves: (frames?: number) => File
  /**
   * The same halves as a two-level chunked source (pass to
   * `loadChunkedVolume`): the coarse level is all ID 3, so ID 20000 exists
   * only in the fine level's bricks.
   */
  labelHalvesSource: () => unknown
}

/**
 * The internals of a view that scenes read or wrap (both backends have them).
 * Not public API: a scene that needs one is checking how a result was reached.
 */
export type SceneView = {
  render: () => void
  isBusy: boolean
  _getMeshGpu: (mesh: unknown) => unknown
  updateMeshVertices: (mesh: unknown) => boolean
  updateBindGroups?: (...args: unknown[]) => unknown
  depthPick: (x: number, y: number) => Promise<ArrayLike<number> | null>
  screenSlices: { leftTopWidthHeight: number[] }[]
  colorbarRenderer: { getLayout: () => { originX: number } }
  gl?: WebGL2RenderingContext
  device?: GPUDevice
  volumeRenderer: {
    volumeGradientTexture: unknown
    volumeOrientCache: unknown
    overlayOrientCache: unknown
    volumeRgbaCache: { texture: unknown } | null
    overlayRgbaCache: { texture: unknown } | null
    volumeTexture: unknown
    coarseFloorTexture: unknown
    hasChunkedVolume: boolean
    updateVolume: (...args: unknown[]) => unknown
    _texCache: Map<
      string,
      { plan: unknown; manager: { residentCount: number } }
    >
  }
  cinematicRenderer: {
    tiles: Map<unknown, { frame: number; maxFrames: number }>
    geometry: { mm2frac: ArrayLike<number> }
  }
}

export type SceneContext = {
  nv: NiiVue
  /** `nv.view` with the internals scenes may read. */
  view: () => SceneView
  lib: SceneLib
  p: Phantoms
  /** Throws (failing the test) with `message` unless `ok`. */
  check: (ok: unknown, message: string) => void
  /** Waits until every update, chunk stream and refinement has drawn. */
  settle: () => Promise<void>
  /** The canvas the scene draws on. */
  canvas: HTMLCanvasElement
}

export type Step = {
  /** Names the capture: `<scene>--<step>-<backend>.png`. */
  name: string
  run: (ctx: SceneContext) => Promise<void>
  /**
   * Compare with another capture's reference (its `<scene>[--<step>]` name)
   * instead of this step's own: for a state that must draw exactly like
   * another one (a restored setting, a second code path to the same picture).
   */
  sameAs?: string
}

export type Scene = {
  /** Names the first capture: `<scene>-<backend>.png`. */
  name: string
  /** Constructor options on top of the deterministic base. */
  options?: Record<string, unknown>
  /** Canvas size in pixels; default 160 x 160. */
  size?: [number, number]
  setup: (ctx: SceneContext) => Promise<void>
  /** Compare the setup capture with another capture's reference. */
  sameAs?: string
  /** Further states, each captured after its `run`, in order. */
  steps?: Step[]
}

const SIZE = 160

type Rendered = { skip: string } | { backend: string; pngs: string[] }

/**
 * Runs in the page: mounts a canvas on `backend` with every nondeterministic
 * or text-drawing extra off, builds the phantoms, runs the scene's `setup`
 * and steps and returns each settled frame as a PNG.
 */
async function renderScene(
  args: {
    backend: string
    size: [number, number]
    options: Record<string, unknown>
  },
  setup: (ctx: SceneContext) => Promise<void>,
  steps: ((ctx: SceneContext) => Promise<void>)[],
): Promise<Rendered> {
  const { backend, size } = args
  if (backend === 'webgpu') {
    if (!navigator.gpu) return { skip: 'no navigator.gpu' }
    try {
      if (!(await navigator.gpu.requestAdapter()))
        return { skip: 'no WebGPU adapter' }
    } catch (e) {
      return { skip: `requestAdapter threw: ${e}` }
    }
  }
  const lib = await import('/src/index.ts')
  const { createNiftiArray } = await import('/src/volume/utils.ts')
  const NiiVue = lib.default

  // ---- phantoms (see the Phantoms type) ----
  const N = 32
  const nifti = (spec: NiftiSpec): File => {
    const { dims, img, frames = 1, datatype = 2 } = spec
    const mm = spec.mm ?? 1
    const pix: number[] = typeof mm === 'number' ? [mm, mm, mm] : mm
    const affine = spec.affine ?? [
      pix[0],
      0,
      0,
      (-dims[0] * pix[0]) / 2,
      0,
      pix[1],
      0,
      (-dims[1] * pix[1]) / 2,
      0,
      0,
      pix[2],
      (-dims[2] * pix[2]) / 2,
      0,
      0,
      0,
      1,
    ]
    const bytes = createNiftiArray(dims, pix, affine, datatype, img)
    const dv = new DataView(bytes.buffer)
    if (frames > 1) {
      dv.setInt16(40, 4, true)
      dv.setInt16(48, frames, true)
    }
    if (spec.intent) dv.setInt16(68, spec.intent, true)
    return new File([bytes], spec.name)
  }
  const inEllipsoid = (x: number, y: number, z: number, s = 1): boolean =>
    ((x - 15.5) / (14 * s)) ** 2 +
      ((y - 15.5) / (12 * s)) ** 2 +
      ((z - 15.5) / (10 * s)) ** 2 <=
    1
  const grid = (f: (x: number, y: number, z: number) => number): Uint8Array => {
    const img = new Uint8Array(N * N * N)
    for (let z = 0; z < N; z++)
      for (let y = 0; y < N; y++)
        for (let x = 0; x < N; x++) img[x + N * (y + N * z)] = f(x, y, z)
    return img
  }
  const anatomyImg = grid((x, y, z) => {
    if (x >= 6 && x <= 9 && y >= 14 && y <= 25 && z >= 8 && z <= 21) return 255
    if ((x - 20) ** 2 + (y - 12) ** 2 + (z - 18) ** 2 <= 25) return 220
    return inEllipsoid(x, y, z) ? 40 + 4 * x : 0
  })
  const labelImg = grid((x, y, z) =>
    inEllipsoid(x, y, z)
      ? 1 + (x >= 16 ? 1 : 0) + (y >= 16 ? 2 : 0) + (z >= 16 ? 4 : 0)
      : 0,
  )
  const maskImg = grid((x, y, z) => (inEllipsoid(x, y, z, 0.7) ? 1 : 0))
  const rampImg = new Float32Array(N * N * N)
  for (let i = 0; i < rampImg.length; i++)
    rampImg[i] = (Math.floor(i / N) % N) / (N - 1)
  const rgbImg = new Uint8Array(N * N * N * 3)
  for (let z = 0; z < N; z++)
    for (let y = 0; y < N; y++)
      for (let x = 0; x < N; x++) {
        const i = 3 * (x + N * (y + N * z))
        rgbImg[i] = 8 * x
        rgbImg[i + 1] = 8 * y
        rgbImg[i + 2] = inEllipsoid(x, y, z) ? 200 : 0
      }
  const statsImg = new Float32Array(16 ** 3)
  for (let z = 0; z < 16; z++)
    for (let y = 0; y < 16; y++)
      for (let x = 0; x < 16; x++) {
        const pos = Math.exp(
          -((x - 10) ** 2 + (y - 10) ** 2 + (z - 8) ** 2) / 6,
        )
        const neg = Math.exp(-((x - 5) ** 2 + (y - 5) ** 2 + (z - 8) ** 2) / 4)
        statsImg[x + 16 * (y + 16 * z)] = 5 * pos - 5 * neg
      }
  // Oblique: rotate the grid 20 degrees about y, then 10 about x, keeping
  // its centre on the origin.
  const obliqueAffine = (() => {
    const a = (20 * Math.PI) / 180
    const b = (10 * Math.PI) / 180
    const ry = [
      [Math.cos(a), 0, Math.sin(a)],
      [0, 1, 0],
      [-Math.sin(a), 0, Math.cos(a)],
    ]
    const rx = [
      [1, 0, 0],
      [0, Math.cos(b), -Math.sin(b)],
      [0, Math.sin(b), Math.cos(b)],
    ]
    const r = rx.map((row) =>
      [0, 1, 2].map((j) => row.reduce((s, v, k) => s + v * ry[k][j], 0)),
    )
    const c = (N - 1) / 2
    const out: number[] = []
    for (let i = 0; i < 3; i++)
      out.push(r[i][0], r[i][1], r[i][2], -(r[i][0] + r[i][1] + r[i][2]) * c)
    return [...out, 0, 0, 0, 1]
  })()
  const obj = (name: string, verts: number[][], faces: number[][]): File =>
    new File(
      [
        [
          ...verts.map((v) => `v ${v[0]} ${v[1]} ${v[2]}`),
          ...faces.map((f) => `f ${f[0] + 1} ${f[1] + 1} ${f[2] + 1}`),
        ].join('\n'),
      ],
      name,
    )
  // Icosphere: an icosahedron subdivided twice, on the unit sphere.
  const t = (1 + Math.sqrt(5)) / 2
  // biome-ignore format: vertex table
  let verts: number[][] = [
    [-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0],
    [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t],
    [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1],
  ]
  // biome-ignore format: face table
  let faces: number[][] = [
    [0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11],
    [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8],
    [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9],
    [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1],
  ]
  const unit = (v: number[]): number[] => {
    const l = Math.hypot(v[0], v[1], v[2])
    return [v[0] / l, v[1] / l, v[2] / l]
  }
  verts = verts.map(unit)
  for (let level = 0; level < 2; level++) {
    const mid = new Map<string, number>()
    const midpoint = (a: number, b: number): number => {
      const key = a < b ? `${a},${b}` : `${b},${a}`
      const hit = mid.get(key)
      if (hit !== undefined) return hit
      const va = verts[a]
      const vb = verts[b]
      verts.push(unit([va[0] + vb[0], va[1] + vb[1], va[2] + vb[2]]))
      mid.set(key, verts.length - 1)
      return verts.length - 1
    }
    faces = faces.flatMap(([a, b, c]) => {
      const ab = midpoint(a, b)
      const bc = midpoint(b, c)
      const ca = midpoint(c, a)
      return [
        [a, ab, ca],
        [b, bc, ab],
        [c, ca, bc],
        [ab, bc, ca],
      ]
    })
  }
  const R = 12
  const layerGifti = [
    '<?xml version="1.0" encoding="UTF-8"?>\n',
    '<GIFTI Version="1.0" NumberOfDataArrays="1">\n',
    '<DataArray Intent="NIFTI_INTENT_NONE" DataType="NIFTI_TYPE_FLOAT32" ',
    `ArrayIndexingOrder="RowMajorOrder" Dimensionality="1" Dim0="${verts.length}" `,
    'Encoding="ASCII" Endian="LittleEndian" ExternalFileName="" ExternalFileOffset="">\n',
    `<Data>${verts.map((v) => (v[2] * R).toFixed(3)).join(' ')}</Data>\n`,
    '</DataArray>\n</GIFTI>\n',
  ].join('')
  const drawingImg = grid((x, y, z) => {
    if (z < 12 || z > 20) return 0
    if (x >= 4 && x <= 11 && y >= 4 && y <= 11) return 1
    if ((x - 22) ** 2 + (y - 20) ** 2 <= 16) return 2
    if (y >= 26 && y <= 28 && x >= 8 && x <= 24) return 3
    return 0
  })
  const on = (name: string, img: NiftiSpec['img'], datatype = 2): File =>
    nifti({ name, dims: [N, N, N], datatype, img })
  const p: Phantoms = {
    N,
    grid,
    nifti,
    anatomy: (name = 'anatomy.nii') => on(name, anatomyImg),
    anatomyImg: () => new Uint8Array(anatomyImg),
    oblique: () =>
      nifti({
        name: 'oblique.nii',
        dims: [N, N, N],
        img: anatomyImg,
        affine: obliqueAffine,
      }),
    labels: () => on('labels.nii', labelImg),
    mask: () => on('mask.nii', maskImg),
    ramp: () => on('ramp.nii', rampImg, 16),
    rgb: () => on('rgb.nii', rgbImg, 128),
    stats: () =>
      nifti({
        name: 'stats.nii',
        dims: [16, 16, 16],
        mm: 2,
        datatype: 16,
        img: statsImg,
      }),
    obj,
    sphereMesh: (opts = {}) => {
      const c = opts.center ?? [0, 0, 0]
      const r = opts.radius ?? R
      return obj(
        opts.name ?? 'sphere.obj',
        verts.map((v) => [c[0] + v[0] * r, c[1] + v[1] * r, c[2] + v[2] * r]),
        faces,
      )
    },
    sphereLayer: () => new File([layerGifti], 'sphere.func.gii'),
    drawingBitmap: () => new Uint8Array(drawingImg),
    labelHalves: (frames = 1) => {
      const n = 32 * 32 * 4
      const img = new Int16Array(n * frames)
      for (let i = 0; i < n; i++) {
        const left = i % 32 < 16
        if (frames === 1) img[i] = left ? 3 : 20000
        else {
          img[i] = left ? 3 : 0
          img[i + n] = left ? 0 : 20000
        }
      }
      return nifti({
        name: `labels${frames}.nii`,
        dims: [32, 32, 4],
        datatype: 4,
        img,
        frames,
        intent: 1002,
      })
    },
    labelHalvesSource: () => ({
      datatypeCode: 4,
      levels: [
        { level: 0, shape: [32, 32, 4], spacing: [1, 1, 1] },
        { level: 1, shape: [16, 16, 2], spacing: [2, 2, 2] },
      ],
      fetchChunk: async (req: {
        levelIndex: number
        texOrigin: number[]
        texDims: number[]
      }) => {
        const { levelIndex, texOrigin: o, texDims: d } = req
        const out = new Int16Array(d[0] * d[1] * d[2])
        for (let z = 0; z < d[2]; z++)
          for (let y = 0; y < d[1]; y++)
            for (let x = 0; x < d[0]; x++)
              out[x + d[0] * (y + d[1] * z)] =
                levelIndex === 0 && o[0] + x >= 16 ? 20000 : 3
        return new Uint8Array(out.buffer)
      },
    }),
  }

  // ---- mount ----
  const canvas = document.createElement('canvas')
  canvas.width = size[0]
  canvas.height = size[1]
  canvas.style.cssText = `position:fixed;top:0;left:0;width:${size[0]}px;height:${size[1]}px`
  document.body.appendChild(canvas)
  const nv = new NiiVue({
    backend: backend as 'webgl2' | 'webgpu',
    devicePixelRatio: 1,
    isAntiAlias: false,
    backgroundColor: [0, 0, 0, 1],
    azimuth: 120,
    elevation: 15,
    crosshairWidth: 0,
    isOrientCubeVisible: false,
    isOrientationTextVisible: false,
    isColorbarVisible: false,
    isLegendVisible: false,
    is3DCrosshairVisible: false,
    ...args.options,
  })
  await nv.attachToCanvas(canvas)
  if (nv.backend !== backend)
    return { skip: `${backend} fell back to ${nv.backend}` }

  const view = () => nv.view as unknown as SceneView
  const nextFrame = () => new Promise((r) => requestAnimationFrame(r))
  // Settled: no update, chunk stream, brick fade or cinematic refinement is
  // left to draw, and a frame has been drawn since.
  const settle = async (): Promise<void> => {
    await nv.whenUpdatesSettle()
    await nv.whenChunkStreamSettles()
    for (let i = 0; ; i++) {
      await nextFrame()
      const v = view() as SceneView & {
        fontRenderer?: { isReady: boolean }
        volumeRenderer: { fadeActive?: boolean }
      }
      const refining = [...(v.cinematicRenderer?.tiles.values() ?? [])].some(
        (t) => t.frame < t.maxFrames,
      )
      const ready =
        !nv.framePending &&
        !v.isBusy &&
        !refining &&
        !v.volumeRenderer?.fadeActive &&
        v.fontRenderer?.isReady !== false
      if (ready) break
      if (i > 1200) throw new Error('render never settled')
    }
  }
  const check = (ok: unknown, message: string): void => {
    if (!ok) throw new Error(`check failed: ${message}`)
  }
  const ctx: SceneContext = { nv, view, lib, p, check, settle, canvas }

  // ---- run, capturing a settled frame after setup and after each step ----
  const pngs: string[] = []
  const capture = async (): Promise<boolean> => {
    await settle()
    view().render()
    // A software GPU that dies mid-run (seen on CI's Ubuntu SwiftShader) is
    // the environment going away, not a rendering regression.
    if ((view() as { _deviceLost?: boolean })._deviceLost) return false
    const copy = document.createElement('canvas')
    copy.width = nv.canvas?.width ?? canvas.width
    copy.height = nv.canvas?.height ?? canvas.height
    const c2d = copy.getContext('2d')
    if (!c2d) throw new Error('no 2D context')
    c2d.drawImage(nv.canvas ?? canvas, 0, 0)
    const url = copy.toDataURL('image/png')
    pngs.push(url.slice(url.indexOf(',') + 1))
    return true
  }
  await setup(ctx)
  if (!(await capture())) return { skip: 'WebGPU device lost' }
  for (const run of steps) {
    await run(ctx)
    if (!(await capture())) return { skip: 'WebGPU device lost' }
  }
  return { backend: nv.backend, pngs }
}

/** Defines one test per scene and backend in the calling spec. */
export function registerScenes(scenes: Scene[]): void {
  // SwiftShader WebGPU needs these flags; they also bring up WebGL2.
  test.use({ launchOptions: webgpuLaunchOptions })
  const names = scenes.flatMap((s) => [
    s.name,
    ...(s.steps ?? []).map((t) => `${s.name}--${t.name}`),
  ])
  const dup = names.find((n, i) => names.indexOf(n) !== i)
  if (dup) throw new Error(`duplicate capture name ${dup}`)
  for (const backend of ['webgl2', 'webgpu'] as const) {
    for (const scene of scenes) {
      test(`${scene.name} (${backend})`, async ({ page }) => {
        const steps = scene.steps ?? []
        const args = JSON.stringify({
          backend,
          size: scene.size ?? [SIZE, SIZE],
          options: scene.options ?? {},
        })
        // The functions go to the page as source text (see the top of file).
        const r: Rendered = await page.evaluate(
          `(${renderScene})(${args}, ${scene.setup}, [${steps.map((s) => s.run).join(',')}])`,
        )
        if ('skip' in r) {
          test.skip(true, r.skip)
          return
        }
        const refs = [
          scene.sameAs ?? scene.name,
          ...steps.map((s) => s.sameAs ?? `${scene.name}--${s.name}`),
        ]
        const captures = [scene.name, ...steps.map((s) => s.name)]
        expect(r.pngs.length).toBe(refs.length)
        refs.forEach((ref, i) => {
          expect
            .soft(Buffer.from(r.pngs[i], 'base64'), `capture ${captures[i]}`)
            .toMatchSnapshot(`${ref}-${backend}.png`)
        })
      })
    }
  }
}

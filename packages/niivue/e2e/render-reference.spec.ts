import { expect } from '@playwright/test'
import { webgpuLaunchOptions } from './launchOptions'
import { SCENES, type SceneContext } from './renderScenes'
import { test } from './sharedPage'

// Reference-image render tier: each scene in renderScenes.ts is drawn on both
// backends and compared with a committed PNG
// (e2e/__snapshots__/render-reference.spec.ts/<scene>-<backend>.png). There is
// ONE reference set for every platform: the same PNG must match real Metal
// (PLAYWRIGHT_CHROMIUM_CHANNEL=chromium) and SwiftShader (the default headless
// shell, as on the Ubuntu CI job). The tolerance lives in playwright.config.ts
// (`expect.toMatchSnapshot`). Update the references with
//   bunx playwright test e2e/render-reference.spec.ts --update-snapshots
// and check the new PNGs on the other renderer before committing them.

// SwiftShader WebGPU needs these flags; they also bring up WebGL2.
test.use({ launchOptions: webgpuLaunchOptions })

const SIZE = 160

type Rendered = { skip: string } | { backend: string; png: string }

/**
 * Runs in the page: mounts a SIZE x SIZE instance on `backend` with every
 * nondeterministic or text-drawing extra off, builds the phantoms, runs the
 * scene's `setup` and returns the settled frame as a PNG.
 */
async function renderScene(
  args: { backend: string; size: number },
  setup: (ctx: SceneContext) => Promise<void>,
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

  // ---- phantoms (see the Phantoms type in renderScenes.ts) ----
  const N = 32
  const nifti = (
    name: string,
    n: number,
    mm: number,
    datatype: number,
    img: Uint8Array | Float32Array,
  ): File => {
    const o = -(n * mm) / 2
    const affine = [mm, 0, 0, o, 0, mm, 0, o, 0, 0, mm, o, 0, 0, 0, 1]
    return new File(
      [createNiftiArray([n, n, n], [mm, mm, mm], affine, datatype, img)],
      name,
    )
  }
  const inEllipsoid = (x: number, y: number, z: number): boolean =>
    ((x - 15.5) / 14) ** 2 + ((y - 15.5) / 12) ** 2 + ((z - 15.5) / 10) ** 2 <=
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
  // Icosphere: an icosahedron subdivided twice, projected to radius 12.
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
  const obj = [
    ...verts.map((v) => `v ${v[0] * R} ${v[1] * R} ${v[2] * R}`),
    ...faces.map((f) => `f ${f[0] + 1} ${f[1] + 1} ${f[2] + 1}`),
  ].join('\n')
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
  const p = {
    anatomy: () => nifti('anatomy.nii', N, 1, 2, anatomyImg),
    labels: () => nifti('labels.nii', N, 1, 2, labelImg),
    stats: () => nifti('stats.nii', 16, 2, 16, statsImg),
    sphereMesh: () => new File([obj], 'sphere.obj'),
    sphereLayer: () => new File([layerGifti], 'sphere.func.gii'),
    drawingBitmap: () => new Uint8Array(drawingImg),
  }

  // ---- mount ----
  const canvas = document.createElement('canvas')
  canvas.width = size
  canvas.height = size
  canvas.style.cssText = `position:fixed;top:0;left:0;width:${size}px;height:${size}px`
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
  })
  await nv.attachToCanvas(canvas)
  if (nv.backend !== backend)
    return { skip: `${backend} fell back to ${nv.backend}` }

  await setup({ nv, lib, p } as unknown as SceneContext)

  // ---- wait for the settled frame, then read it back in the same task ----
  const view = nv.view as unknown as {
    _deviceLost?: boolean
    isBusy: boolean
    fontRenderer?: { isReady: boolean }
    render: () => void
  }
  const nextFrame = () => new Promise((r) => requestAnimationFrame(r))
  await nv.whenUpdatesSettle()
  for (let i = 0; ; i++) {
    await nextFrame()
    const ready =
      !nv.framePending && !view.isBusy && view.fontRenderer?.isReady !== false
    if (ready) break
    if (i > 600) throw new Error('render never settled')
  }
  view.render()
  // A software GPU that dies mid-run (seen on CI's Ubuntu SwiftShader) is the
  // environment going away, not a rendering regression.
  if (view._deviceLost) return { skip: 'WebGPU device lost' }
  const copy = document.createElement('canvas')
  copy.width = canvas.width
  copy.height = canvas.height
  const ctx = copy.getContext('2d')
  if (!ctx) throw new Error('no 2D context')
  ctx.drawImage(canvas, 0, 0)
  const url = copy.toDataURL('image/png')
  return { backend: nv.backend, png: url.slice(url.indexOf(',') + 1) }
}

for (const backend of ['webgl2', 'webgpu'] as const) {
  for (const scene of SCENES) {
    test(`${scene.name} (${backend})`, async ({ page }) => {
      // Both functions go to the page as source text (see renderScenes.ts).
      const args = JSON.stringify({ backend, size: SIZE })
      const r: Rendered = await page.evaluate(
        `(${renderScene})(${args}, ${scene.setup})`,
      )
      if ('skip' in r) test.skip(true, r.skip)
      else
        expect(Buffer.from(r.png, 'base64')).toMatchSnapshot(
          `${scene.name}-${backend}.png`,
        )
    })
  }
}

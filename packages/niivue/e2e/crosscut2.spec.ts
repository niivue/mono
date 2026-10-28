import { expect, test } from '@playwright/test'
import { webgpuLaunchOptions } from './launchOptions'

// crosscut2 outlines a mesh where it meets the displayed voxel plane.
// - #92: on an oblique volume, moving the crosshair within the axial slice
//   keeps the same voxel plane, so the outline must not change.
// - A surface seen exactly edge-on rasterizes to nothing, so fragment-based
//   crosscut cannot draw it; crosscut2 builds the outline as geometry.
//
// WebGPU is skipped when the runner has no adapter.

test.use({ launchOptions: webgpuLaunchOptions })

test.beforeEach(async ({ page }) => {
  await page.goto('/examples/index.html', { waitUntil: 'load' })
})

// Shared page-side setup: a NiiVue on a 256x256 canvas plus a readback that
// returns the indices of clearly green (mesh) pixels.
const setup = (backend: string) => `
  if ('${backend}' === 'webgpu') {
    if (!navigator.gpu) return { skip: 'no navigator.gpu' }
    const adapter = await navigator.gpu.requestAdapter().catch(() => null)
    if (!adapter) return { skip: 'no WebGPU adapter' }
  }
  const { default: NiiVue, SLICE_TYPE } = await import('/src/index.ts')
  const canvas = document.createElement('canvas')
  canvas.width = 256
  canvas.height = 256
  document.body.appendChild(canvas)
  const nv = new NiiVue({
    backend: '${backend}',
    backgroundColor: [0, 0, 0, 1],
    sliceType: SLICE_TYPE.AXIAL,
    crosshairWidth: 0,
    isOrientCubeVisible: false,
    isOrientationTextVisible: false,
    isColorbarVisible: false,
  })
  await nv.attachToCanvas(canvas)
  if ('${backend}' === 'webgpu' && nv.backend !== 'webgpu') {
    return { skip: 'WebGPU init fell back to ' + nv.backend }
  }
  const readback = document.createElement('canvas')
  readback.width = canvas.width
  readback.height = canvas.height
  const ctx = readback.getContext('2d', { willReadFrequently: true })
  const greenPixels = async () => {
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
    nv.view.render()
    ctx.clearRect(0, 0, readback.width, readback.height)
    ctx.drawImage(canvas, 0, 0)
    const px = ctx.getImageData(0, 0, readback.width, readback.height).data
    const hits = []
    for (let i = 0; i < px.length; i += 4) {
      if (px[i + 1] > 150 && px[i] < 90 && px[i + 2] < 90) hits.push(i / 4)
    }
    return hits
  }
`

for (const backend of ['webgl2', 'webgpu'] as const) {
  test(`crosscut2 outline is stable within an oblique slice (${backend})`, async ({
    page,
  }) => {
    test.setTimeout(120_000)
    const r = await page.evaluate(`(async () => {
      ${setup(backend)}
      await nv.loadVolumes([{ url: '/volumes/fs/T1_oblique.nii.gz' }])
      await nv.loadMeshes([{
        url: '/meshes/fs/T1_oblique.lh.mid.mz3',
        color: [0, 1, 0, 1],
        shaderType: 'crosscut2',
      }])
      const before = await greenPixels()
      nv.moveCrosshairInVox(12, -9, 0)
      const after = await greenPixels()
      const set = new Set(before)
      const shared = after.filter((i) => set.has(i)).length
      return { before: before.length, after: after.length, shared }
    })()`)
    if ((r as { skip?: string }).skip)
      test.skip(true, (r as { skip: string }).skip)
    const { before, after, shared } = r as {
      before: number
      after: number
      shared: number
    }
    expect(before).toBeGreaterThan(500)
    expect(after).toBe(before)
    expect(shared).toBe(before)
  })

  test(`crosscut2 outlines a surface seen edge-on (${backend})`, async ({
    page,
  }) => {
    test.setTimeout(60_000)
    const r = await page.evaluate(`(async () => {
      ${setup(backend)}
      // A square in the plane x = 0: edge-on in the axial view, so its
      // triangles cover no pixels. The axial cut at z = 0 is the segment
      // x = 0, y in [-40, 40].
      const obj = [
        'v 0 -40 -40', 'v 0 40 -40', 'v 0 40 40', 'v 0 -40 40',
        'f 1 2 3', 'f 1 3 4',
      ].join('\\n')
      await nv.loadMeshes([{
        url: new File([obj], 'wall.obj'),
        color: [0, 1, 0, 1],
        shaderType: 'crosscut',
      }])
      nv.setCrosshairPos([0, 0, 0])
      const crosscut = (await greenPixels()).length
      await nv.setMesh(0, { shaderType: 'crosscut2' })
      const crosscut2 = (await greenPixels()).length
      return { crosscut, crosscut2 }
    })()`)
    if ((r as { skip?: string }).skip)
      test.skip(true, (r as { skip: string }).skip)
    const { crosscut, crosscut2 } = r as { crosscut: number; crosscut2: number }
    expect(crosscut).toBe(0)
    expect(crosscut2).toBeGreaterThan(100)
  })

  test(`crosscut2 follows indices edited in place before updateGLVolume (${backend})`, async ({
    page,
  }) => {
    test.setTimeout(60_000)
    // Culling bounds are cached per mesh; the documented full rebuild must
    // refresh them after an untracked in-place index edit.
    const r = await page.evaluate(`(async () => {
      ${setup(backend)}
      // Two walls in x = 0: z in [-40, -10] (drawn) and z in [10, 40] (spare).
      const obj = [
        'v 0 -40 -40', 'v 0 40 -40', 'v 0 40 -10', 'v 0 -40 -10',
        'v 0 -40 10', 'v 0 40 10', 'v 0 40 40', 'v 0 -40 40',
        'f 1 2 3', 'f 1 3 4',
      ].join('\\n')
      await nv.loadMeshes([{
        url: new File([obj], 'walls.obj'),
        color: [0, 1, 0, 1],
        shaderType: 'crosscut2',
      }])
      nv.setCrosshairPos([0, 0, 25])
      const before = (await greenPixels()).length
      nv.meshes[0].indices.set([4, 5, 6, 4, 6, 7])
      await nv.updateGLVolume()
      const after = (await greenPixels()).length
      return { before, after }
    })()`)
    if ((r as { skip?: string }).skip)
      test.skip(true, (r as { skip: string }).skip)
    const { before, after } = r as { before: number; after: number }
    expect(before).toBe(0)
    expect(after).toBeGreaterThan(100)
  })

  test(`crosscut2 leaves a translucent 3D view unchanged (${backend})`, async ({
    page,
  }) => {
    test.setTimeout(60_000)
    // Triangle order matters to translucent blending, so crosscut2's cluster
    // order must stay in its own copy of the indices. Compares the view before
    // and after crosscut2 was the slice shader.
    const r = await page.evaluate(`(async () => {
      ${setup(backend)}
      // 2D tiles draw crosscut2 (building its cluster order); the render
      // tile keeps drawing the translucent mesh with phong.
      nv.sliceType = SLICE_TYPE.MULTIPLANAR
      nv.showRender = 1
      await nv.loadMeshes([{
        url: '/meshes/BrainMesh_ICBM152.lh.mz3',
        opacity: 0.5,
      }])
      const snapshot = async () => {
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))
        nv.view.render()
        ctx.clearRect(0, 0, readback.width, readback.height)
        ctx.drawImage(canvas, 0, 0)
        return Array.from(ctx.getImageData(0, 0, readback.width, readback.height).data)
      }
      const before = await snapshot()
      await nv.setMesh(0, { sliceShaderType: 'crosscut2' })
      await snapshot()
      await nv.setMesh(0, { sliceShaderType: '' })
      const after = await snapshot()
      let lit = 0
      let changed = 0
      for (let i = 0; i < before.length; i += 4) {
        if (before[i] + before[i + 1] + before[i + 2] > 30) lit++
        if (before[i] !== after[i] || before[i + 1] !== after[i + 1] || before[i + 2] !== after[i + 2]) changed++
      }
      return { lit, changed }
    })()`)
    if ((r as { skip?: string }).skip)
      test.skip(true, (r as { skip: string }).skip)
    const { lit, changed } = r as { lit: number; changed: number }
    expect(lit).toBeGreaterThan(1000)
    expect(changed).toBe(0)
  })
}

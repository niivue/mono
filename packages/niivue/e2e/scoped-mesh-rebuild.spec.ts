import { expect, test } from '@playwright/test'
import { webgpuLaunchOptions } from './launchOptions'

// GPU rebuilds re-upload only the meshes that changed. Each mesh's GPU entry
// (view._getMeshGpu) is a new object only when that mesh was re-uploaded, so
// identity shows which meshes a call rebuilt. Pixels confirm the result is
// still drawn: a redraw-only setMesh must show, and a recolour must not leave
// stale colours on screen.
//
// WebGPU is skipped when the runner has no adapter.

test.use({ launchOptions: webgpuLaunchOptions })

test.beforeEach(async ({ page }) => {
  await page.goto('/examples/index.html', { waitUntil: 'load' })
})

const VOLUME = '/volumes/mni152.nii.gz'
const MESH_A = '/meshes/BrainMesh_ICBM152.lh.mz3'
const MESH_B = '/meshes/cortex_5124.mz3'
const MESH_C = '/meshes/scalp.mz3'
// Curvature of MESH_A: a scalar layer whose positive half lights up.
const LAYER_A = '/meshes/BrainMesh_ICBM152.lh.curv'

for (const backend of ['webgl2', 'webgpu'] as const) {
  test(`setters re-upload only the meshes they change (${backend})`, async ({
    page,
  }) => {
    test.setTimeout(180_000)

    const result = await page.evaluate(`(async () => {
     try {
      if ('${backend}' === 'webgpu') {
        if (!navigator.gpu) return { skip: 'no navigator.gpu' }
        let adapter = null
        try {
          adapter = await navigator.gpu.requestAdapter()
        } catch (e) {
          return { skip: 'requestAdapter threw: ' + e }
        }
        if (!adapter) return { skip: 'no WebGPU adapter' }
      }
      const { default: NiiVue, SLICE_TYPE } = await import('/src/index.ts')
      const nextFrame = () => new Promise((r) =>
        requestAnimationFrame(() => requestAnimationFrame(r)))

      const canvas = document.createElement('canvas')
      canvas.width = 256
      canvas.height = 256
      document.body.appendChild(canvas)
      const nv = new NiiVue({
        backend: '${backend}',
        backgroundColor: [0, 0, 0, 1],
        sliceType: SLICE_TYPE.RENDER,
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
      if (!ctx) return { skip: 'no 2D readback context' }
      // Count lit and clearly red/green/blue pixels of a freshly rendered
      // frame, plus a checksum of every channel.
      const pixels = async () => {
        await nextFrame()
        if (nv.view) nv.view.render()
        ctx.clearRect(0, 0, readback.width, readback.height)
        ctx.drawImage(canvas, 0, 0)
        const px = ctx.getImageData(0, 0, readback.width, readback.height).data
        let lit = 0
        let red = 0
        let green = 0
        let blue = 0
        let sum = 0
        for (let i = 0; i < px.length; i += 4) {
          const [cr, cg, cb] = [px[i], px[i + 1], px[i + 2]]
          sum += cr + cg + cb
          if (cr > 30 || cg > 30 || cb > 30) lit++
          if (cr - cg > 40 && cr - cb > 40) red++
          if (cg - cr > 40 && cg - cb > 40) green++
          if (cb - cr > 40 && cb - cg > 40) blue++
        }
        return { lit, red, green, blue, sum }
      }
      // Wait (bounded) until a fire-and-forget rebuild replaced m's entry.
      const replaced = async (m, old) => {
        for (let i = 0; i < 100 && nv.view._getMeshGpu(m) === old; i++) {
          await nextFrame()
        }
        return nv.view._getMeshGpu(m) !== old
      }
      const gpus = () => nv.meshes.map((m) => nv.view._getMeshGpu(m))
      const kept = (before, after) =>
        before.length === after.length &&
        before.every((g, i) => g !== null && g === after[i])

      await nv.loadVolumes([{ url: '${VOLUME}', opacity: 0 }])
      await nv.loadMeshes([
        { url: '${MESH_A}', color: [1, 1, 1, 1] },
        { url: '${MESH_B}', opacity: 0 },
        { url: '${MESH_C}', opacity: 0 },
      ])
      const r = {}

      // Volume-only setters keep every mesh's buffers.
      let before = gpus()
      await nv.setVolume(0, { colormap: 'hot' })
      r.setVolumeKept = kept(before, gpus())
      const affine = nv.getVolumeAffine(0)
      affine[0][3] += 2
      await nv.setVolumeAffine(0, affine)
      r.setVolumeAffineKept = kept(before, gpus())

      // Remove the last mesh: the others keep their buffers.
      before = gpus()
      const removed = nv.meshes[2]
      await nv.removeMesh(2)
      r.removeKept = kept(before.slice(0, 2), gpus())
      r.removedFreed = nv.view._getMeshGpu(removed) === null
      // Add it back: only it is uploaded.
      await nv.addMesh(removed)
      const afterAdd = gpus()
      r.addKept = kept(before.slice(0, 2), afterAdd.slice(0, 2))
      r.addUploaded = afterAdd[2] !== null && afterAdd[2] !== before[2]

      // Opacity is a draw-time uniform: no re-upload, yet the redraw shows it.
      before = gpus()
      const shown = await pixels()
      await nv.setMesh(0, { opacity: 0 })
      const hidden = await pixels()
      await nv.setMesh(0, { opacity: 1 })
      r.opacityKept = kept(before, gpus())
      r.opacityShown = shown.lit
      r.opacityHidden = hidden.lit

      // A shader change keeps the buffers, records the new shader and draws
      // with it.
      const phongSum = (await pixels()).sum
      await nv.setMesh(0, { shaderType: 'toon' })
      r.shaderKept = kept(before, gpus())
      r.shaderRecorded = nv.view._getMeshGpu(nv.meshes[0]).shaderType
      r.shaderSumChange = Math.abs((await pixels()).sum - phongSum) / phongSum
      await nv.setMesh(0, { shaderType: 'phong' })

      // A colour change rewrites per-vertex colours: only that mesh re-uploads
      // and the new colour is on screen.
      const whiteRed = (await pixels()).red
      await nv.setMesh(0, { color: [1, 0, 0, 1] })
      const afterColor = gpus()
      r.colorUploaded = afterColor[0] !== before[0]
      r.colorOthersKept = kept(before.slice(1), afterColor.slice(1))
      r.redBefore = whiteRed
      r.redAfter = (await pixels()).red

      // Mesh layers are composited into the per-vertex colours: each layer
      // setter re-uploads that mesh only, and its colours reach the screen.
      await nv.setMesh(0, { color: [1, 1, 1, 1] })
      before = gpus()
      await nv.addMeshLayer(0, {
        url: '${LAYER_A}',
        colormap: 'green',
        calMin: 0,
        calMax: 0.05,
        opacity: 1,
      })
      const afterLayer = gpus()
      r.layerAddUploaded = afterLayer[0] !== before[0]
      r.layerOthersKept = kept(before.slice(1), afterLayer.slice(1))
      const withGreen = await pixels()
      r.layerGreen = withGreen.green
      await nv.setMeshLayerProperty(0, 0, { colormap: 'blue' })
      r.layerSetUploaded = gpus()[0] !== afterLayer[0]
      const withBlue = await pixels()
      r.layerBlue = withBlue.blue
      r.layerGreenAfterSet = withBlue.green
      before = gpus()
      await nv.removeMeshLayer(0, 0)
      r.layerRemoveUploaded = gpus()[0] !== before[0]
      r.layerBlueAfterRemove = (await pixels()).blue

      // updateMeshPositions falling back to a rebuild (no writable buffer, as
      // mid-rebuild) must re-upload the moved mesh, not keep its old buffer.
      const unshrunk = (await pixels()).lit
      const pts = nv.meshes[0].positions
      const c = [0, 0, 0]
      const n = pts.length / 3
      for (let i = 0; i < pts.length; i++) c[i % 3] += pts[i] / n
      const shrunk = new Float32Array(pts.length)
      for (let i = 0; i < pts.length; i++) {
        shrunk[i] = c[i % 3] + (pts[i] - c[i % 3]) * 0.25
      }
      const oldEntry = nv.view._getMeshGpu(nv.meshes[0])
      const writeVertices = nv.view.updateMeshVertices
      nv.view.updateMeshVertices = () => false
      nv.updateMeshPositions(0, shrunk)
      nv.view.updateMeshVertices = writeVertices
      r.fallbackUploaded = await replaced(nv.meshes[0], oldEntry)
      r.fallbackUnshrunk = unshrunk
      r.fallbackShrunk = (await pixels()).lit

      // The public full rebuild still re-uploads every mesh.
      before = gpus()
      await nv.updateGLVolume()
      const afterFull = gpus()
      r.fullRebuiltAll = afterFull.every((g, i) => g !== null && g !== before[i])
      return r
     } catch (e) {
      const m = String(e && e.message ? e.message : e)
      if (/no longer exists|device (is )?lost|adapter/i.test(m)) {
        return { skip: 'GPU unavailable: ' + m }
      }
      throw e
     }
    })()`)

    // biome-ignore lint/suspicious/noExplicitAny: page.evaluate returns unknown
    const r = result as any
    if (r.skip) {
      test.skip(true, r.skip)
      return
    }

    expect(r.setVolumeKept).toBe(true)
    expect(r.setVolumeAffineKept).toBe(true)
    expect(r.removeKept).toBe(true)
    expect(r.removedFreed).toBe(true)
    expect(r.addKept).toBe(true)
    expect(r.addUploaded).toBe(true)
    expect(r.opacityKept).toBe(true)
    expect(r.opacityShown).toBeGreaterThan(1000)
    expect(r.opacityHidden).toBeLessThan(r.opacityShown * 0.05)
    expect(r.shaderKept).toBe(true)
    expect(r.shaderRecorded).toBe('toon')
    expect(r.colorUploaded).toBe(true)
    expect(r.colorOthersKept).toBe(true)
    expect(r.redBefore).toBeLessThan(100)
    expect(r.redAfter).toBeGreaterThan(1000)
    expect(r.shaderSumChange).toBeGreaterThan(0.02)
    expect(r.layerAddUploaded).toBe(true)
    expect(r.layerOthersKept).toBe(true)
    expect(r.layerGreen).toBeGreaterThan(1000)
    expect(r.layerSetUploaded).toBe(true)
    expect(r.layerBlue).toBeGreaterThan(1000)
    expect(r.layerGreenAfterSet).toBeLessThan(100)
    expect(r.layerRemoveUploaded).toBe(true)
    expect(r.layerBlueAfterRemove).toBeLessThan(100)
    expect(r.fallbackUploaded).toBe(true)
    expect(r.fallbackShrunk).toBeLessThan(r.fallbackUnshrunk * 0.5)
    expect(r.fullRebuiltAll).toBe(true)
  })
}

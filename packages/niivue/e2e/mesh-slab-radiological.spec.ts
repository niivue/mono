import { expect, test } from '@playwright/test'
import { webgpuLaunchOptions } from './launchOptions'

// Meshes on a 2D slice are clipped to a meshThicknessOn2D slab around the slice
// and depth-tested against it, so only the half of the slab on the camera's
// side of the slice is drawn. Radiological convention used to mirror the view
// by moving the camera to the other side of the slice, which swapped that half:
// at the same crosshair, toggling the convention showed different tracts.
//
// The camera now stays put and only the projection mirrors, so the radiological
// tile must show the same mesh pixels as the neurological one, mirrored about
// the tile centre. That is only observable in rendered pixels (both backends),
// and the mirror also reverses triangle winding, which each backend has to
// compensate for in its culling -- a wrong front face shows tube interiors or
// nothing, and fails here too.
//
// Picking must keep landing on the clicked anatomy: a click in the mirrored
// tile has to put the crosshair on the world point drawn under the cursor.

test.use({ launchOptions: webgpuLaunchOptions })

test.beforeEach(async ({ page }) => {
  await page.goto('/examples/index.html', { waitUntil: 'load' })
})

// Both from packages/dev-images (LFS): the tractography the layout demo loads,
// over the template it is registered to.
const VOLUME = '/volumes/mni152.nii.gz'
const MESH = '/meshes/dpsv.trx'
// The crosshair the bug was reported at: neurological showed posterior tract
// segments in axial and most of the tract in coronal; radiological showed
// different, central segments in axial and almost nothing in coronal.
const CROSSHAIR = [2, -17, 7]
// Canvas pixels of a click target in the axial tile (well inside the brain,
// away from the tracts, left of centre so the mirror moves it).
const CLICK_MM = [-35, 30]

type TileScore = {
  tile: number
  neuroPx: number
  radioPx: number
  neuroInRadio: number
  radioInNeuro: number
}
type Phase = { thickness: number; scores: TileScore[] }
type Result = {
  skip?: string
  backend?: string
  phases?: Phase[]
  clicks?: { isRadiological: boolean; target: number[]; px: number[] }[]
}

for (const backend of ['webgl2', 'webgpu'] as const) {
  test(`radiological 2D mesh slab mirrors the neurological one (${backend})`, async ({
    page,
  }) => {
    test.setTimeout(180_000)

    const result: Result = await page.evaluate(`(async () => {
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
      canvas.width = 800
      canvas.height = 600
      canvas.style.cssText =
        'position:fixed;left:0;top:0;width:800px;height:600px;z-index:1000'
      document.body.appendChild(canvas)

      const nv = new NiiVue({
        backend: '${backend}',
        backgroundColor: [0, 0, 0, 1],
        sliceType: SLICE_TYPE.MULTIPLANAR,
        // Only the mesh may be coloured: no crosshair, labels, colorbar or cube.
        crosshairWidth: 0,
        isOrientCubeVisible: false,
        isOrientationTextVisible: false,
        isColorbarVisible: false,
      })
      await nv.attachToCanvas(canvas)
      if ('${backend}' === 'webgpu' && nv.backend !== 'webgpu') {
        return { skip: 'WebGPU init fell back to ' + nv.backend }
      }
      await nv.loadVolumes([{ url: '${VOLUME}' }])
      await nv.loadMeshes([{ url: '${MESH}' }])
      await nextFrame()

      const readback = document.createElement('canvas')
      readback.width = canvas.width
      readback.height = canvas.height
      const ctx = readback.getContext('2d', { willReadFrequently: true })
      if (!ctx) return { skip: 'no 2D readback context' }
      const W = canvas.width
      const H = canvas.height

      // Mesh pixels: the volume is grayscale, the tract is direction-coloured.
      const meshMask = () => {
        if (nv.view) nv.view.render()
        ctx.clearRect(0, 0, W, H)
        ctx.drawImage(canvas, 0, 0)
        const px = ctx.getImageData(0, 0, W, H).data
        const mask = new Uint8Array(W * H)
        for (let i = 0; i < W * H; i++) {
          const r = px[4 * i], g = px[4 * i + 1], b = px[4 * i + 2]
          if (Math.max(r, g, b) - Math.min(r, g, b) > 40) mask[i] = 1
        }
        return mask
      }
      const render = async (isRadiological) => {
        nv.isRadiological = isRadiological
        nv.setCrosshairPos(${JSON.stringify(CROSSHAIR)})
        await nextFrame()
        await nextFrame()
        return meshMask()
      }
      // Fraction of a's pixels with a b pixel within 1 px once b is mirrored
      // about the tile's vertical centre line.
      const overlap = (a, b, ltwh, mirrorB) => {
        const [l, t, w, h] = ltwh
        let n = 0, hit = 0
        for (let y = Math.ceil(t); y < Math.floor(t + h); y++) {
          for (let x = Math.ceil(l); x < Math.floor(l + w); x++) {
            if (!a[y * W + x]) continue
            n++
            const xm = mirrorB ? Math.round(2 * l + w - 1 - x) : x
            let found = false
            for (let dy = -1; dy <= 1 && !found; dy++)
              for (let dx = -1; dx <= 1 && !found; dx++) {
                const xx = xm + dx, yy = y + dy
                if (xx >= 0 && yy >= 0 && xx < W && yy < H && b[yy * W + xx])
                  found = true
              }
            if (found) hit++
          }
        }
        return { n, frac: n ? hit / n : 1 }
      }

      const phases = []
      for (const thickness of [Infinity, 5]) {
        nv.meshThicknessOn2D = thickness
        const neuro = await render(false)
        const radio = await render(true)
        const scores = []
        nv.view.screenSlices.forEach((tile, i) => {
          if (tile.axCorSag > 2) return
          const a = overlap(neuro, radio, tile.leftTopWidthHeight, true)
          const b = overlap(radio, neuro, tile.leftTopWidthHeight, true)
          scores.push({ tile: tile.axCorSag, neuroPx: a.n, radioPx: b.n,
            neuroInRadio: a.frac, radioInNeuro: b.frac })
        })
        phases.push({ thickness, scores })
      }

      // Where a world point is drawn on the axial tile, in canvas pixels.
      const toCanvas = (mm) => {
        const tile = nv.view.screenSlices.find((t) => t.axCorSag === 0)
        const m = tile.mvpMatrix
        const v = [mm[0], mm[1], mm[2], 1]
        const c = [0, 1, 3].map((r) =>
          m[r] * v[0] + m[4 + r] * v[1] + m[8 + r] * v[2] + m[12 + r] * v[3])
        const [l, t, w, h] = tile.leftTopWidthHeight
        return [l + ((c[0] / c[2] + 1) / 2) * w, t + ((1 - c[1] / c[2]) / 2) * h]
      }
      const targets = []
      for (const isRadiological of [false, true]) {
        nv.isRadiological = isRadiological
        nv.setCrosshairPos(${JSON.stringify(CROSSHAIR)})
        await nextFrame()
        nv.view.render()
        const target = [${CLICK_MM[0]}, ${CLICK_MM[1]}, ${CROSSHAIR[2]}]
        targets.push({ isRadiological, target, px: toCanvas(target) })
      }
      window.__nvMeshSlab = nv
      return { backend: nv.backend, phases, clicks: targets }
     } catch (e) {
      return { skip: 'threw: ' + (e && e.message ? e.message : e) }
     }
    })()`)

    test.skip(!!result.skip, result.skip ?? '')
    expect(result.backend).toBe(backend)

    for (const phase of result.phases ?? []) {
      expect(phase.scores.length).toBe(3)
      for (const s of phase.scores) {
        const where = `thickness ${phase.thickness}, tile ${s.tile}`
        // Without the fix the coronal tile drops to a few stray pixels and
        // the axial tile shows other tracts: overlap falls far below this.
        expect(s.radioPx, where).toBeGreaterThan(0.8 * s.neuroPx)
        expect(s.neuroPx, where).toBeGreaterThan(0.8 * s.radioPx)
        if (s.neuroPx < 20) continue
        expect(s.neuroInRadio, where).toBeGreaterThan(0.9)
        expect(s.radioInNeuro, where).toBeGreaterThan(0.9)
      }
      // The reported crosshair has tract on every tile at Infinity thickness.
      if (phase.thickness === Number.POSITIVE_INFINITY) {
        for (const s of phase.scores) expect(s.neuroPx).toBeGreaterThan(200)
      }
    }

    // Click the canvas pixel each convention draws the target at: the
    // crosshair must land on the target either way.
    const clicks = result.clicks ?? []
    expect(clicks.length).toBe(2)
    expect(clicks[0].px[0]).not.toBeCloseTo(clicks[1].px[0], 0)
    const reset = (isRadiological: boolean) =>
      page.evaluate(
        `(async () => {
          const nv = window.__nvMeshSlab
          nv.isRadiological = ${isRadiological}
          nv.setCrosshairPos(${JSON.stringify(CROSSHAIR)})
          nv.view.render()
        })()`,
      )
    const crosshairMM = async () =>
      (await page.evaluate(
        `(() => {
          const nv = window.__nvMeshSlab
          return Array.from(nv.model.scene2mm(nv.model.scene.crosshairPos))
        })()`,
      )) as number[]
    // A double-click depth-picks along the view ray through back-face culled
    // proxy geometry, which the mirror's winding flip must not break. The
    // camera no longer depends on the convention, so both must pick the same
    // point.
    const depthPicked: number[][] = []
    for (const c of clicks) {
      const where = c.isRadiological ? 'radiological' : 'neurological'
      await reset(c.isRadiological)
      await page.mouse.click(c.px[0], c.px[1])
      const mm = await crosshairMM()
      expect(Math.abs(mm[0] - c.target[0]), where).toBeLessThan(1.5)
      expect(Math.abs(mm[1] - c.target[1]), where).toBeLessThan(1.5)
      expect(Math.abs(mm[2] - c.target[2]), where).toBeLessThan(1.5)

      await reset(c.isRadiological)
      await page.mouse.dblclick(c.px[0], c.px[1])
      // The depth pick is async; give it time to settle before reading.
      await page.waitForTimeout(500)
      depthPicked.push(await crosshairMM())
    }
    for (let k = 0; k < 3; k++) {
      expect(Math.abs(depthPicked[1][k] - depthPicked[0][k])).toBeLessThan(1.5)
    }
  })
}

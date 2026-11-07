import { expect } from '@playwright/test'
import { webgpuLaunchOptions } from './launchOptions'
import { test } from './sharedPage'

// getCanvasImage() must return the current scene synchronously on both
// backends: WebGPU discards the canvas texture after compositing, so a read
// that is not rendered and copied in the same task comes back blank.

test.use({ launchOptions: webgpuLaunchOptions })

const VOLUME = '/volumes/mni152.nii.gz'

type Px = [number, number, number, number]
type Result = {
  skip?: string
  backend?: string
  detached?: boolean
  full?: { width: number; height: number; corner: Px; centre: Px }
  recoloured?: Px
  bounded?: { width: number; height: number }
  panned?: { width: number; height: number }
  offCanvas?: boolean
  busy?: { during: boolean; centre: Px }
  topHalf?: { width: number; height: number; corner: Px }
  overlay?: { calls: number; corner: Px }
  detachedLater?: boolean
}

for (const backend of ['webgl2', 'webgpu'] as const) {
  test(`getCanvasImage reads the current frame (${backend})`, async ({
    page,
  }) => {
    test.setTimeout(60_000)

    const result: Result = await page.evaluate(`(async () => {
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
      const pixel = (img, x, y) => {
        const i = 4 * (y * img.width + x)
        return Array.from(img.data.slice(i, i + 4))
      }
      const makeCanvas = () => {
        const canvas = document.createElement('canvas')
        canvas.width = 256
        canvas.height = 256
        document.body.appendChild(canvas)
        return canvas
      }
      const opts = {
        backend: '${backend}',
        backgroundColor: [0, 0, 1, 1],
        sliceType: SLICE_TYPE.AXIAL,
        isOrientCubeVisible: false,
        isOrientationTextVisible: false,
        isColorbarVisible: false,
      }

      const nv = new NiiVue(opts)
      const detached = nv.getCanvasImage() === null
      await nv.attachToCanvas(makeCanvas())
      if ('${backend}' === 'webgpu' && nv.backend !== 'webgpu') {
        return { skip: 'WebGPU init fell back to ' + nv.backend }
      }
      await nv.loadVolumes([{ url: '${VOLUME}' }])
      await nextFrame()

      const img = nv.getCanvasImage()
      const full = {
        width: img.width,
        height: img.height,
        corner: pixel(img, 1, 1),
        centre: pixel(img, 128, 128),
      }

      // No frame between the setter and the read: the capture renders itself.
      nv.backgroundColor = [1, 0, 0, 1]
      const recoloured = pixel(nv.getCanvasImage(), 1, 1)

      // A colormap change rebuilds GPU resources: no frame can be drawn until
      // it settles, so the read is null rather than the old colours.
      const recolour = nv.setVolume(0, { colormap: 'red' })
      const during = nv.getCanvasImage() === null
      await recolour
      await nv.whenUpdatesSettle()
      const busy = { during, centre: pixel(nv.getCanvasImage(), 128, 128) }

      // Left half of its canvas: the read is cropped to the bounds.
      const half = new NiiVue({ ...opts, bounds: [[0, 0], [0.5, 1]] })
      await half.attachToCanvas(makeCanvas())
      await nextFrame()
      const part = half.getCanvasImage()
      const bounded = { width: part.width, height: part.height }
      // The canvas viewport moves the drawn rect: pan it half off the right
      // edge (64 px left), then right off it.
      half.setViewport({ pan: [0.75, 0], zoom: 1 })
      const moved = half.getCanvasImage()
      const panned = { width: moved.width, height: moved.height }
      half.setViewport({ pan: [2, 0], zoom: 1 })
      const offCanvas = half.getCanvasImage() === null

      // Two instances stacked on one canvas (bounds have a bottom-left
      // origin): the top one must read red, not its green neighbour.
      const stacked = makeCanvas()
      const top = new NiiVue({ ...opts, backgroundColor: [1, 0, 0, 1],
        bounds: [[0, 0.5], [1, 1]] })
      const bottom = new NiiVue({ ...opts, backgroundColor: [0, 1, 0, 1],
        bounds: [[0, 0], [1, 0.5]] })
      await top.attachToCanvas(stacked)
      await bottom.attachToCanvas(stacked)
      await nextFrame()
      bottom.getCanvasImage()
      const topImg = top.getCanvasImage()
      const topHalf = {
        width: topImg.width,
        height: topImg.height,
        corner: pixel(topImg, 1, 1),
      }

      // A just-registered overlay is drawn by the capture itself, not only
      // by the next animation frame.
      let calls = 0
      nv.registerOverlayRenderer({
        drawOverlay({ handle }) {
          calls++
          if (handle.backend === 'webgl2') {
            handle.gl.clearColor(0, 1, 0, 1)
            handle.gl.clear(handle.gl.COLOR_BUFFER_BIT)
          }
        },
      })
      const corner = pixel(nv.getCanvasImage(), 1, 1)
      const overlay = { calls, corner }

      // A detached canvas is not drawn (WebGPU), so it must not return the
      // frame it last held.
      nv.canvas.remove()
      const detachedLater = nv.getCanvasImage() === null

      return {
        backend: nv.backend,
        detached,
        full,
        recoloured,
        bounded,
        panned,
        offCanvas,
        busy,
        topHalf,
        overlay,
        detachedLater,
      }
    })()`)

    test.skip(!!result.skip, result.skip ?? '')
    expect(result.backend).toBe(backend)
    expect(result.detached).toBe(true)

    const full = result.full
    if (!full) throw new Error('no full-canvas read')
    expect([full.width, full.height]).toEqual([256, 256])
    expect(full.corner).toEqual([0, 0, 255, 255])
    // The brain at the centre is gray, not the blue background.
    expect(full.centre[0]).toBeGreaterThan(20)
    expect(full.centre[0]).toBe(full.centre[2])

    expect(result.recoloured).toEqual([255, 0, 0, 255])
    expect(result.bounded).toEqual({ width: 128, height: 256 })
    expect(result.panned).toEqual({ width: 64, height: 256 })
    expect(result.offCanvas).toBe(true)

    expect(result.busy?.during).toBe(true)
    // Grey brain under the red colormap: red channel above blue.
    const centre = result.busy?.centre ?? [0, 0, 0, 0]
    expect(centre[0]).toBeGreaterThan(centre[2])

    expect(result.topHalf).toEqual({
      width: 256,
      height: 128,
      corner: [255, 0, 0, 255],
    })

    expect(result.overlay?.calls).toBeGreaterThan(0)
    if (backend === 'webgl2') {
      expect(result.overlay?.corner).toEqual([0, 255, 0, 255])
    }
    // WebGL2 can still draw into a detached canvas; WebGPU cannot.
    if (backend === 'webgpu') expect(result.detachedLater).toBe(true)
  })
}

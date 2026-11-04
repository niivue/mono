import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  mock,
  spyOn,
} from 'bun:test'
import type { UIKitOverlayFrame } from '@niivue/niivue'
import { buildRect } from './rect'
import { UIKitRectOverlay } from './rectOverlay'
import { GlRectRenderer } from './render/glRectRenderer'
import { WgpuRectRenderer } from './render/wgpuRectRenderer'

// Spies on the renderer prototypes: restored after this file so other overlay
// tests draw through the real renderers.
let glDraw: ReturnType<typeof spyOn>
let wgpuDraw: ReturnType<typeof spyOn>
beforeAll(() => {
  glDraw = spyOn(GlRectRenderer.prototype, 'draw').mockImplementation(() => {})
  wgpuDraw = spyOn(WgpuRectRenderer.prototype, 'draw').mockImplementation(
    () => {},
  )
})
afterAll(() => mock.restore())
afterEach(() => {
  glDraw.mockClear()
  wgpuDraw.mockClear()
})

const bounds = { x: 0, y: 0, width: 640, height: 480 }
const glFrame = {
  handle: { backend: 'webgl2', gl: {} },
  bounds,
} as unknown as UIKitOverlayFrame
const gpuFrame = {
  handle: {
    backend: 'webgpu',
    device: {},
    pass: {},
    colorFormat: 'bgra8unorm',
    sampleCount: 4,
    depthFormat: 'depth24plus',
  },
  bounds,
} as unknown as UIKitOverlayFrame

const rects = [buildRect({ x: 1, y: 2, width: 3, height: 4 })]

describe('UIKitRectOverlay', () => {
  it('draws nothing without rects', () => {
    const o = new UIKitRectOverlay()
    o.drawOverlay(glFrame)
    o.drawOverlay(gpuFrame)
    expect(glDraw).not.toHaveBeenCalled()
    expect(wgpuDraw).not.toHaveBeenCalled()
  })

  it('draws on the live backend only, at the frame size', () => {
    const o = new UIKitRectOverlay(rects)
    o.drawOverlay(glFrame)
    expect(glDraw).toHaveBeenCalledWith({}, rects, 640, 480)
    expect(wgpuDraw).not.toHaveBeenCalled()

    o.drawOverlay(gpuFrame)
    expect(wgpuDraw).toHaveBeenCalledWith(
      {},
      {},
      'bgra8unorm',
      4,
      'depth24plus',
      rects,
      640,
      480,
    )
    expect(glDraw).toHaveBeenCalledTimes(1)
  })

  it('draws the rects last given to setRects', () => {
    const o = new UIKitRectOverlay(rects)
    const next = [buildRect({ x: 5, y: 5, width: 1, height: 1 })]
    o.setRects(next)
    o.drawOverlay(glFrame)
    expect(glDraw.mock.calls[0][1]).toBe(next)
    o.setRects([])
    o.drawOverlay(glFrame)
    expect(glDraw).toHaveBeenCalledTimes(1)
  })

  it('releases both backends on destroy', () => {
    const gl = spyOn(GlRectRenderer.prototype, 'destroy')
    const gpu = spyOn(WgpuRectRenderer.prototype, 'destroy')
    new UIKitRectOverlay().destroy()
    expect(gl).toHaveBeenCalledTimes(1)
    expect(gpu).toHaveBeenCalledTimes(1)
  })
})

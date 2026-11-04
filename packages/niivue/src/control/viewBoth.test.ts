import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test'
import type NiiVue from '@/NVControlBase'

globalThis.HTMLCanvasElement ??= class {} as unknown as typeof HTMLCanvasElement
// Spy on the real views rather than mock.module, which would leak stubs into
// every later test file in the same bun run.
const { default: NVViewGL } = await import('@/gl/NVViewGL')
const { default: NVViewGPU } = await import('@/wgpu/NVViewGPU')
const glCanvases: unknown[] = []
beforeEach(() => {
  spyOn(NVViewGL.prototype, 'init').mockImplementation(async function (
    this: InstanceType<typeof NVViewGL>,
  ) {
    glCanvases.push(this.canvas)
  })
  spyOn(NVViewGL.prototype, 'resize').mockImplementation(() => {})
  spyOn(NVViewGL.prototype, 'destroy').mockImplementation(() => {})
  spyOn(NVViewGPU.prototype, 'init').mockRejectedValue(
    new Error('requestAdapter returned null'),
  )
  spyOn(NVViewGPU.prototype, 'destroy').mockImplementation(() => {})
})
afterEach(() => mock.restore())
globalThis.ResizeObserver ??= class {
  observe() {}
  disconnect() {}
} as unknown as typeof ResizeObserver
const { attachToCanvas } = await import('./viewBoth')

test('a webgpu to webgl2 fallback on a detached canvas keeps the caller canvas', async () => {
  // attachToCanvas checks instanceof, so build on the real prototype.
  const userCanvas = Object.assign(Object.create(HTMLCanvasElement.prototype), {
    parentNode: null,
    style: {},
    cloneNode: () => ({ parentNode: null, style: {} }),
    addEventListener() {},
    removeEventListener() {},
  }) as HTMLCanvasElement
  const ctrl = {
    canvas: null,
    view: null,
    opts: { backend: 'webgpu', isInteractionEnabled: false },
    model: { ui: {} },
    _wireViewHooks() {},
    emit() {},
  } as unknown as NiiVue
  await attachToCanvas(ctrl, userCanvas)
  expect(ctrl.opts.backend).toBe('webgl2')
  expect(glCanvases.at(-1)).toBe(userCanvas)
  expect(ctrl.canvas).toBe(userCanvas)
})

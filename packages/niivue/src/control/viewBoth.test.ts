import { expect, mock, test } from 'bun:test'
import type NiiVue from '@/NVControlBase'

const glCanvases: unknown[] = []
mock.module('@/gl/NVViewGL', () => ({
  default: class {
    constructor(canvas: unknown) {
      glCanvases.push(canvas)
    }
    async init() {}
    resize() {}
    destroy() {}
  },
}))
mock.module('@/wgpu/NVViewGPU', () => ({
  default: class {
    async init() {
      throw new Error('requestAdapter returned null')
    }
    destroy() {}
  },
}))
globalThis.ResizeObserver ??= class {
  observe() {}
  disconnect() {}
} as unknown as typeof ResizeObserver
globalThis.HTMLCanvasElement ??= class {} as unknown as typeof HTMLCanvasElement
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

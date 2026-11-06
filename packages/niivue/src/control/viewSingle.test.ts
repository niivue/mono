import { expect, test } from 'bun:test'
import type NVViewGL from '@/gl/NVViewGL'
import type NiiVue from '@/NVControlBase'
import {
  getCanvasInstances,
  getCanvasViewport,
  registerCanvasInstance,
  setCanvasViewport,
} from './canvasRegistry'
import { singleBackendLifecycle } from './viewSingle'

globalThis.HTMLCanvasElement ??= class {} as unknown as typeof HTMLCanvasElement

class FakeView {
  async init() {}
  resize() {}
  destroy() {}
}
const { attachToCanvas, recreateView } = singleBackendLifecycle(
  'webgl2',
  FakeView as unknown as typeof NVViewGL,
)

globalThis.ResizeObserver ??= class {
  observe() {}
  disconnect() {}
} as unknown as typeof ResizeObserver

function fakeCanvas(attached = true): HTMLCanvasElement {
  const parent = { replaceChild() {} }
  const canvas = {
    parentNode: attached ? parent : null,
    style: {},
    cloneNode: () => fakeCanvas(),
    addEventListener() {},
    removeEventListener() {},
  }
  return canvas as unknown as HTMLCanvasElement
}

function fakeCtrl(canvas: HTMLCanvasElement, bounds?: number[][]): NiiVue {
  return {
    canvas,
    view: null,
    opts: { isInteractionEnabled: false, bounds },
    model: { clearAllGPUResources() {}, ui: {} },
    _eventListeners: {},
    _wireViewHooks() {},
    async _rebuildViewResources() {},
    restoreSlidePlaneView() {},
    drawScene() {},
    emit() {},
  } as unknown as NiiVue
}

test('recreateView keeps the canvas viewport and registry', async () => {
  const viewport = { pan: [0.25, 0.1] as [number, number], zoom: 2 }
  const shared = fakeCanvas()
  const left = fakeCtrl(shared, [
    [0, 0],
    [0.5, 1],
  ])
  const right = fakeCtrl(shared, [
    [0.5, 0],
    [1, 1],
  ])
  registerCanvasInstance(left, shared)
  registerCanvasInstance(right, shared)
  setCanvasViewport(shared, viewport)
  await recreateView(left)
  expect(left.canvas).toBe(shared)
  expect(getCanvasInstances(shared)).toEqual(new Set([left, right]))

  const old = fakeCanvas()
  const ctrl = fakeCtrl(old)
  registerCanvasInstance(ctrl, old)
  setCanvasViewport(old, viewport)
  await recreateView(ctrl)
  expect(ctrl.canvas).not.toBe(old)
  expect(getCanvasViewport(ctrl.canvas)).toEqual(viewport)
  expect(getCanvasInstances(ctrl.canvas)).toEqual(new Set([ctrl]))
  expect(getCanvasInstances(old)).toBeNull()

  // A detached canvas stays the caller's: they may attach it later.
  const detached = fakeCanvas(false)
  const lone = fakeCtrl(detached)
  await recreateView(lone)
  expect(lone.canvas).toBe(detached)
})

test('recreateView restores the drawing and reports the view swap', async () => {
  const ctrl = fakeCtrl(fakeCanvas())
  const events: string[] = []
  let refreshes = 0
  Object.assign(ctrl, {
    emit: (name: string) => events.push(name),
    refreshDrawing: () => refreshes++,
  })
  Object.assign(ctrl.model, { drawingVolume: {} })
  await recreateView(ctrl)
  expect(refreshes).toBe(1)
  expect(events).toEqual(['viewDestroyed', 'viewAttached'])
})

test('attachToCanvas reports the attached view', async () => {
  const canvas = Object.assign(
    Object.create(HTMLCanvasElement.prototype),
    fakeCanvas(),
  ) as HTMLCanvasElement
  const ctrl = fakeCtrl(canvas)
  const events: unknown[] = []
  Object.assign(ctrl, {
    emit: (...args: unknown[]) => events.push(args),
  })
  await attachToCanvas(ctrl, canvas)
  expect(events).toEqual([['viewAttached', { canvas, backend: 'webgl2' }]])
})

test('a failing thumbnail reload still finishes the rebuild', async () => {
  class BadThumbnailView extends FakeView {
    async loadThumbnail() {
      throw new Error('thumbnail 404')
    }
  }
  const lifecycle = singleBackendLifecycle(
    'webgl2',
    BadThumbnailView as unknown as typeof NVViewGL,
  )
  const ctrl = fakeCtrl(fakeCanvas())
  const events: string[] = []
  let rebuilt = false
  Object.assign(ctrl, {
    emit: (name: string) => events.push(name),
    _rebuildViewResources: async () => {
      rebuilt = true
    },
  })
  Object.assign(ctrl.opts, { thumbnail: 'bad.png' })
  Object.assign(ctrl.model.ui, { isThumbnailVisible: true })
  await lifecycle.recreateView(ctrl)
  expect(rebuilt).toBe(true)
  expect(events).toEqual(['viewDestroyed', 'viewAttached'])
})

test('WebGPU changes antialias per view, even on a shared canvas', async () => {
  const gpu = singleBackendLifecycle(
    'webgpu',
    FakeView as unknown as typeof NVViewGL,
  )
  const ctrlFor = (canvas: HTMLCanvasElement) => {
    const ctrl = fakeCtrl(canvas)
    ctrl.opts.isAntiAlias = false
    Object.defineProperty(ctrl, 'isAntiAlias', {
      get: () => ctrl.opts.isAntiAlias,
    })
    return ctrl
  }
  const options = { backend: 'webgpu', isAntiAlias: true } as const
  const shared = fakeCanvas()
  const [a, b] = [ctrlFor(shared), ctrlFor(shared)]
  registerCanvasInstance(a, shared)
  registerCanvasInstance(b, shared)
  expect(await gpu.reinitializeView(a, options)).toBe(true)
  expect(a.opts.isAntiAlias).toBe(true)
  expect(a.canvas).toBe(shared)

  const detached = fakeCanvas(false)
  const solo = ctrlFor(detached)
  expect(await gpu.reinitializeView(solo, options)).toBe(true)
  expect(solo.canvas).toBe(detached)
})

test('a failed attach leaves the canvas unregistered', async () => {
  class FailingView extends FakeView {
    async init() {
      throw new Error('no context')
    }
  }
  const failing = singleBackendLifecycle(
    'webgl2',
    FailingView as unknown as typeof NVViewGL,
  )
  // Not laid out, so the failure message has nothing to cover.
  const canvas = Object.assign(
    Object.create(HTMLCanvasElement.prototype),
    fakeCanvas(),
    { getBoundingClientRect: () => ({ width: 0, height: 0 }) },
  ) as HTMLCanvasElement
  const hadDocument = 'document' in globalThis
  globalThis.document ??= {
    createElement: () => ({ setAttribute() {}, style: {} }),
  } as unknown as Document
  await expect(
    failing.attachToCanvas(fakeCtrl(canvas), canvas),
  ).rejects.toThrow('no context')
  if (!hadDocument) Reflect.deleteProperty(globalThis, 'document')
  expect(getCanvasInstances(canvas)?.size ?? 0).toBe(0)
})

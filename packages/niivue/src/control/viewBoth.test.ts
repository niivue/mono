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
const { attachToCanvas, recreateView } = await import('./viewBoth')
const { initInteraction, setupDragAndDrop } = await import('./interactions')
const { getCanvasInstances, registerCanvasInstance } = await import(
  './canvasRegistry'
)

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

test('a backend switch on a shared canvas moves every sibling view to the new canvas', async () => {
  const fakeCanvas = (): HTMLCanvasElement =>
    Object.assign(Object.create(HTMLCanvasElement.prototype), {
      parentNode: { replaceChild() {} },
      style: {},
      cloneNode: () => fakeCanvas(),
      addEventListener() {},
      removeEventListener() {},
    }) as HTMLCanvasElement
  const fakeCtrl = (canvas: HTMLCanvasElement) =>
    ({
      canvas,
      view: { destroy() {} },
      opts: { backend: 'webgpu', isInteractionEnabled: false },
      model: { clearAllGPUResources() {}, ui: {} },
      _eventListeners: {},
      _wireViewHooks() {},
      async _rebuildViewResources() {},
      restoreSlidePlaneView() {},
      drawScene() {},
      emit() {},
    }) as unknown as NiiVue
  const old = fakeCanvas()
  const left = fakeCtrl(old)
  const right = fakeCtrl(old)
  registerCanvasInstance(left, old)
  registerCanvasInstance(right, old)
  left.opts.backend = 'webgl2'
  await recreateView(left, true)
  expect(left.canvas).not.toBe(old)
  expect(right.canvas).toBe(left.canvas)
  expect(right.opts.backend).toBe('webgl2')
  // Both live views draw to the new canvas, not the detached old one.
  expect(glCanvases.slice(-2)).toEqual([left.canvas, left.canvas])
  expect(getCanvasInstances(left.canvas)).toEqual(new Set([left, right]))
})

test('a detached canvas is cloned on a backend switch, kept on a same-backend recreate', async () => {
  const fakeCanvas = (): HTMLCanvasElement =>
    Object.assign(Object.create(HTMLCanvasElement.prototype), {
      parentNode: null,
      style: {},
      cloneNode: () => fakeCanvas(),
      addEventListener() {},
      removeEventListener() {},
    }) as HTMLCanvasElement
  const userCanvas = fakeCanvas()
  const ctrl = {
    canvas: userCanvas,
    view: { destroy() {} },
    opts: { backend: 'webgl2', isInteractionEnabled: false },
    model: { clearAllGPUResources() {}, ui: {} },
    _eventListeners: {},
    _wireViewHooks() {},
    async _rebuildViewResources() {},
    restoreSlidePlaneView() {},
    drawScene() {},
    emit() {},
  } as unknown as NiiVue
  registerCanvasInstance(ctrl, userCanvas)
  await recreateView(ctrl)
  expect(ctrl.canvas).toBe(userCanvas)
  // A webgpu-locked canvas cannot hand out a webgl2 context.
  await recreateView(ctrl, true)
  expect(ctrl.canvas).not.toBe(userCanvas)
  expect(glCanvases.at(-1)).toBe(ctrl.canvas)
})

test('a canvas made by a backend switch is still cloned on a later same-backend recreate', async () => {
  const clones: HTMLCanvasElement[] = []
  const fakeCanvas = (): HTMLCanvasElement =>
    Object.assign(Object.create(HTMLCanvasElement.prototype), {
      parentNode: { replaceChild() {} },
      style: {},
      cloneNode: () => {
        const c = fakeCanvas()
        clones.push(c)
        return c
      },
      addEventListener() {},
      removeEventListener() {},
    }) as HTMLCanvasElement
  const ctrl = {
    canvas: fakeCanvas(),
    view: { destroy() {} },
    opts: { backend: 'webgl2', isInteractionEnabled: false },
    model: { clearAllGPUResources() {}, ui: {} },
    _eventListeners: {},
    _wireViewHooks() {},
    async _rebuildViewResources() {},
    restoreSlidePlaneView() {},
    drawScene() {},
    emit() {},
  } as unknown as NiiVue
  registerCanvasInstance(ctrl, ctrl.canvas as HTMLCanvasElement)
  await recreateView(ctrl, true)
  // An antialias change needs a fresh context on the same backend too.
  await recreateView(ctrl)
  expect(clones.length).toBe(2)
  expect(ctrl.canvas).toBe(clones[1])
})

test('a fallback clones a detached canvas once webgpu has locked it', async () => {
  spyOn(NVViewGPU.prototype, 'init').mockImplementation(async function (
    this: InstanceType<typeof NVViewGPU>,
  ) {
    ;(this as { context: unknown }).context = {}
    throw new Error('device lost during init')
  })
  const clone = Object.assign(Object.create(HTMLCanvasElement.prototype), {
    parentNode: null,
    style: {},
    addEventListener() {},
    removeEventListener() {},
  }) as HTMLCanvasElement
  const userCanvas = Object.assign(Object.create(HTMLCanvasElement.prototype), {
    parentNode: null,
    style: {},
    cloneNode: () => clone,
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
  expect(glCanvases.at(-1)).toBe(clone)
  expect(ctrl.canvas as unknown).toBe(clone)
})

test('a backend switch takes sibling handlers off the old shared canvas', async () => {
  const listeners = new Set<unknown>()
  const old = Object.assign(Object.create(HTMLCanvasElement.prototype), {
    parentNode: { replaceChild() {} },
    style: {},
    cloneNode: () =>
      Object.assign(Object.create(HTMLCanvasElement.prototype), {
        parentNode: { replaceChild() {} },
        style: {},
        addEventListener() {},
        removeEventListener() {},
      }),
    addEventListener(_t: string, f: unknown) {
      listeners.add(f)
    },
    removeEventListener(_t: string, f: unknown) {
      listeners.delete(f)
    },
  }) as HTMLCanvasElement
  const onDown = () => {}
  const fakeCtrl = (eventListeners: object) =>
    ({
      canvas: old,
      view: { destroy() {} },
      opts: { backend: 'webgpu', isInteractionEnabled: false },
      model: { clearAllGPUResources() {}, ui: {} },
      _eventListeners: eventListeners,
      _wireViewHooks() {},
      async _rebuildViewResources() {},
      restoreSlidePlaneView() {},
      drawScene() {},
      emit() {},
    }) as unknown as NiiVue
  const left = fakeCtrl({})
  const right = fakeCtrl({ pointerdown: onDown })
  old.addEventListener('pointerdown', onDown)
  registerCanvasInstance(left, old)
  registerCanvasInstance(right, old)
  left.opts.backend = 'webgl2'
  await recreateView(left, true)
  expect(listeners.size).toBe(0)
})

test('a failed backend switch leaves siblings on the old shared canvas', async () => {
  spyOn(NVViewGL.prototype, 'init').mockRejectedValue(
    new Error('WebGL2 context unavailable'),
  )
  const listeners = new Set<unknown>()
  const parent = {
    child: null as unknown,
    replaceChild(next: unknown) {
      this.child = next
    },
  }
  const canvas = (): HTMLCanvasElement =>
    Object.assign(Object.create(HTMLCanvasElement.prototype), {
      parentNode: parent,
      style: {},
      cloneNode: canvas,
      addEventListener(_t: string, f: unknown) {
        listeners.add(f)
      },
      removeEventListener(_t: string, f: unknown) {
        listeners.delete(f)
      },
    }) as HTMLCanvasElement
  const old = canvas()
  parent.child = old
  const fakeCtrl = () =>
    ({
      canvas: old,
      view: { destroy() {} },
      opts: { backend: 'webgpu' },
      model: { clearAllGPUResources() {}, ui: {} },
      _eventListeners: {},
      emit() {},
    }) as unknown as NiiVue
  const left = fakeCtrl()
  const right = fakeCtrl()
  registerCanvasInstance(left, old)
  registerCanvasInstance(right, old)
  // initInteraction also binds keydown on window, which bun lacks.
  const g = globalThis as { window?: unknown }
  const hadWindow = 'window' in g
  g.window ??= { addEventListener() {}, removeEventListener() {} }
  try {
    initInteraction(right)
    setupDragAndDrop(right)
    const installed = listeners.size
    expect(installed).toBeGreaterThan(0)
    left.opts.backend = 'webgl2'
    await expect(recreateView(left, true)).rejects.toThrow('WebGL2')
    expect(right.canvas).toBe(old)
    expect(left.canvas).toBe(old)
    expect(parent.child).toBe(old)
    expect(listeners.size).toBe(installed)
  } finally {
    if (!hadWindow) delete g.window
  }
})

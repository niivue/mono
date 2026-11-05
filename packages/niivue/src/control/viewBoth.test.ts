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
const { attachToCanvas, recreateView, reinitializeView } = await import(
  './viewBoth'
)
const { initInteraction, removeInteractionListeners, setupDragAndDrop } =
  await import('./interactions')
const { getCanvasInstances, registerCanvasInstance, unregister } = await import(
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
    // The restored canvas is still WebGPU's, so a retry must target that.
    expect(left.opts.backend as string).toBe('webgpu')
  } finally {
    if (!hadWindow) delete g.window
  }
})

test('a sibling that fails to rebuild does not strand the siblings after it', async () => {
  let calls = 0
  spyOn(NVViewGL.prototype, 'init').mockImplementation(async () => {
    calls++
    if (calls === 2) throw new Error('second context unavailable')
  })
  const parent = { replaceChild() {} }
  const canvas = (): HTMLCanvasElement =>
    Object.assign(Object.create(HTMLCanvasElement.prototype), {
      parentNode: parent,
      style: {},
      cloneNode: canvas,
      addEventListener() {},
      removeEventListener() {},
    }) as HTMLCanvasElement
  const old = canvas()
  const fakeCtrl = () =>
    ({
      canvas: old,
      view: { destroy() {} },
      opts: { backend: 'webgpu', isInteractionEnabled: false },
      model: { clearAllGPUResources() {}, ui: {} },
      _eventListeners: {},
      emit() {},
      resize() {},
      _wireViewHooks() {},
      async _rebuildViewResources() {},
      restoreSlidePlaneView() {},
      drawScene() {},
    }) as unknown as NiiVue
  const [a, b, c] = [fakeCtrl(), fakeCtrl(), fakeCtrl()]
  for (const n of [a, b, c]) registerCanvasInstance(n, old)
  const g = globalThis as { window?: unknown }
  const hadWindow = 'window' in g
  g.window ??= {
    addEventListener() {},
    removeEventListener() {},
    devicePixelRatio: 1,
    matchMedia: () => ({ addEventListener() {}, removeEventListener() {} }),
  }
  try {
    a.opts.backend = 'webgl2'
    await expect(recreateView(a, true)).rejects.toThrow('second context')
    expect(a.view).not.toBeNull()
    expect(b.view).toBeNull()
    expect(c.view).not.toBeNull()
    expect(c.canvas).toBe(a.canvas)
    expect(b.opts.backend).toBe('webgl2')
    expect(c.opts.backend).toBe('webgl2')
    // The failed sibling retries on its own, on the already switched canvas.
    await recreateView(b)
    expect(b.view).not.toBeNull()
    expect(b.canvas).toBe(a.canvas)
  } finally {
    if (!hadWindow) delete g.window
  }
})

test('siblings still move when the switching controller fails after init', async () => {
  const parent = { replaceChild() {} }
  const canvas = (): HTMLCanvasElement =>
    Object.assign(Object.create(HTMLCanvasElement.prototype), {
      parentNode: parent,
      style: {},
      cloneNode: canvas,
      addEventListener() {},
      removeEventListener() {},
    }) as HTMLCanvasElement
  const old = canvas()
  const fakeCtrl = () =>
    ({
      canvas: old,
      view: { destroy() {} },
      opts: { backend: 'webgpu', isInteractionEnabled: false },
      model: { clearAllGPUResources() {}, ui: {} },
      _eventListeners: {},
      emit() {},
      resize() {},
      _wireViewHooks() {},
      async _rebuildViewResources() {},
      restoreSlidePlaneView() {},
      drawScene() {},
    }) as unknown as NiiVue
  const [a, b] = [fakeCtrl(), fakeCtrl()]
  a._rebuildViewResources = async () => {
    throw new Error('resource rebuild failed')
  }
  for (const n of [a, b]) registerCanvasInstance(n, old)
  const g = globalThis as { window?: unknown }
  const hadWindow = 'window' in g
  g.window ??= {
    addEventListener() {},
    removeEventListener() {},
    devicePixelRatio: 1,
    matchMedia: () => ({ addEventListener() {}, removeEventListener() {} }),
  }
  try {
    a.opts.backend = 'webgl2'
    await expect(recreateView(a, true)).rejects.toThrow('resource rebuild')
    expect(a.canvas).not.toBe(old)
    expect(b.canvas).toBe(a.canvas)
    expect(b.opts.backend).toBe('webgl2')
    expect(glCanvases.at(-1)).toBe(a.canvas)
    expect(b.view).toBeInstanceOf(NVViewGL)
  } finally {
    if (!hadWindow) delete g.window
  }
})

test('a failing thumbnail reload still finishes the rebuild', async () => {
  spyOn(NVViewGL.prototype, 'loadThumbnail').mockRejectedValue(
    new Error('thumbnail 404'),
  )
  const fake = (): HTMLCanvasElement =>
    Object.assign(Object.create(HTMLCanvasElement.prototype), {
      parentNode: { replaceChild() {} },
      style: {},
      cloneNode: fake,
      addEventListener() {},
      removeEventListener() {},
    }) as HTMLCanvasElement
  const canvas = fake()
  const events: string[] = []
  let rebuilt = false
  const ctrl = {
    canvas,
    view: { destroy() {} },
    opts: { backend: 'webgl2', thumbnail: 'bad.png' },
    model: { clearAllGPUResources() {}, ui: { isThumbnailVisible: true } },
    _eventListeners: {},
    _wireViewHooks() {},
    async _rebuildViewResources() {
      rebuilt = true
    },
    restoreSlidePlaneView() {},
    drawScene() {},
    emit(name: string) {
      events.push(name)
    },
  } as unknown as NiiVue
  registerCanvasInstance(ctrl, canvas)
  const g = globalThis as { window?: unknown }
  const hadWindow = 'window' in g
  g.window ??= {
    addEventListener() {},
    removeEventListener() {},
    devicePixelRatio: 1,
    matchMedia: () => ({ addEventListener() {}, removeEventListener() {} }),
  }
  try {
    await recreateView(ctrl)
    expect(rebuilt).toBe(true)
    expect(events).toContain('viewAttached')
    expect(ctrl.view).toBeInstanceOf(NVViewGL)
  } finally {
    if (!hadWindow) delete g.window
  }
})

test('a failing thumbnail does not abort attach', async () => {
  spyOn(NVViewGL.prototype, 'loadThumbnail').mockRejectedValue(
    new Error('thumbnail 404'),
  )
  const canvas = Object.assign(Object.create(HTMLCanvasElement.prototype), {
    parentNode: null,
    style: {},
    addEventListener() {},
    removeEventListener() {},
  }) as HTMLCanvasElement
  const events: string[] = []
  const ctrl = {
    canvas: null,
    view: null,
    opts: { backend: 'webgl2', thumbnail: 'bad.png' },
    model: { ui: {} },
    _eventListeners: {},
    _wireViewHooks() {},
    emit(name: string) {
      events.push(name)
    },
  } as unknown as NiiVue
  const g = globalThis as { window?: unknown }
  const hadWindow = 'window' in g
  g.window ??= {
    addEventListener() {},
    removeEventListener() {},
    devicePixelRatio: 1,
    matchMedia: () => ({ addEventListener() {}, removeEventListener() {} }),
  }
  try {
    await attachToCanvas(ctrl, canvas)
    expect(ctrl.view).toBeInstanceOf(NVViewGL)
    expect(events).toEqual(['viewAttached'])
  } finally {
    if (!hadWindow) delete g.window
  }
})

test('an antialias change clones a detached canvas and publishes the clone', async () => {
  const fake = (parentNode: unknown): HTMLCanvasElement =>
    Object.assign(Object.create(HTMLCanvasElement.prototype), {
      parentNode,
      style: {},
      cloneNode: () => fake(null),
      addEventListener() {},
      removeEventListener() {},
    }) as HTMLCanvasElement
  const detached = fake(null)
  const attached: unknown[] = []
  const ctrl = {
    canvas: detached,
    view: { destroy() {} },
    opts: {
      backend: 'webgl2',
      isAntiAlias: false,
      isInteractionEnabled: false,
    },
    model: { clearAllGPUResources() {}, ui: {} },
    _eventListeners: {},
    _wireViewHooks() {},
    async _rebuildViewResources() {},
    restoreSlidePlaneView() {},
    drawScene() {},
    emit(name: string, detail?: { canvas: unknown }) {
      if (name === 'viewAttached') attached.push(detail?.canvas)
    },
  } as unknown as NiiVue
  Object.defineProperty(ctrl, 'isAntiAlias', {
    get: () => ctrl.opts.isAntiAlias,
  })
  const g = globalThis as { window?: unknown }
  const hadWindow = 'window' in g
  g.window ??= {
    addEventListener() {},
    removeEventListener() {},
    devicePixelRatio: 1,
    matchMedia: () => ({ addEventListener() {}, removeEventListener() {} }),
  }
  try {
    expect(
      await reinitializeView(ctrl, { isAntiAlias: true, forceRestart: false }),
    ).toBe(true)
    expect(ctrl.canvas).not.toBe(detached)
    expect(glCanvases.at(-1)).toBe(ctrl.canvas)
    expect(attached).toEqual([ctrl.canvas])

    // Shared canvas: siblings hold the context, so the change is refused.
    const shared = fake({ replaceChild() {} })
    const sib = { ...ctrl, canvas: shared } as unknown as NiiVue
    ctrl.canvas = shared
    registerCanvasInstance(ctrl, shared)
    registerCanvasInstance(sib, shared)
    expect(await reinitializeView(ctrl, { isAntiAlias: false })).toBe(false)
    expect(ctrl.opts.isAntiAlias).toBe(true)
    expect(ctrl.canvas).toBe(shared)

    // WebGPU sets MSAA per view, so a shared WebGPU canvas allows it.
    spyOn(NVViewGPU.prototype, 'init').mockImplementation(async () => {})
    spyOn(NVViewGPU.prototype, 'resize').mockImplementation(() => {})
    ctrl.opts.backend = 'webgpu'
    expect(await reinitializeView(ctrl, { isAntiAlias: false })).toBe(true)
    expect(ctrl.opts.isAntiAlias).toBe(false)
    expect(ctrl.canvas).toBe(shared)
    expect(ctrl.view).toBeInstanceOf(NVViewGPU)
  } finally {
    if (!hadWindow) delete g.window
  }
})

test('a sibling destroyed during a backend switch is left alone', async () => {
  const listeners = new Set<unknown>()
  const parent = { replaceChild() {} }
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
  const fakeCtrl = (c: HTMLCanvasElement, events: string[]) =>
    ({
      canvas: c,
      view: { destroy() {} },
      opts: { backend: 'webgpu', isAntiAlias: false },
      model: { clearAllGPUResources() {}, ui: {} },
      _eventListeners: {},
      _wireViewHooks() {},
      async _rebuildViewResources() {},
      restoreSlidePlaneView() {},
      drawScene() {},
      emit(name: string) {
        events.push(name)
      },
    }) as unknown as NiiVue
  const g = globalThis as { window?: unknown }
  const hadWindow = 'window' in g
  g.window ??= { addEventListener() {}, removeEventListener() {} }
  try {
    for (const fails of [false, true]) {
      let settle: ((error?: Error) => void) | undefined
      // Only the switching view's init waits; sibling rebuilds resolve.
      spyOn(NVViewGL.prototype, 'init').mockImplementation(() =>
        settle
          ? Promise.resolve()
          : new Promise<void>((resolve, reject) => {
              settle = (error) => (error ? reject(error) : resolve())
            }),
      )
      listeners.clear()
      const old = canvas()
      const events: string[] = []
      const ctrl = fakeCtrl(old, [])
      const gone = fakeCtrl(old, events)
      const live = fakeCtrl(old, [])
      // A sibling whose own rebuild failed earlier: no view, still registered.
      const idle = fakeCtrl(old, [])
      idle.view = null
      for (const c of [ctrl, gone, live, idle]) registerCanvasInstance(c, old)
      const goneView = gone.view
      ctrl.opts.backend = 'webgl2'
      ctrl.opts.isAntiAlias = true
      const switching = recreateView(ctrl, true)
      await Promise.resolve()
      unregister(gone)
      if (fails) {
        settle?.(new Error('WebGL2 context unavailable'))
        await expect(switching).rejects.toThrow('WebGL2')
        // Only the registered siblings' handlers go back on the old canvas.
        expect(listeners.size).toBeGreaterThan(0)
        removeInteractionListeners(live)
        removeInteractionListeners(idle)
        expect(listeners.size).toBe(0)
      } else {
        settle?.()
        await switching
        expect(live.view).toBeInstanceOf(NVViewGL)
        // One WebGL2 context, so siblings take its antialias setting.
        expect(live.opts.isAntiAlias).toBe(true)
        // It still takes the new backend, so a retry is not a switch.
        expect(idle.opts.backend as string).toBe('webgl2')
      }
      expect(gone.view).toBe(goneView)
      expect(events).toEqual([])
      for (const c of [ctrl, live, idle]) unregister(c)
    }
  } finally {
    if (!hadWindow) delete g.window
  }
})

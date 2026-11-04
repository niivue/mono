import { afterEach, beforeEach, expect, mock, spyOn, test } from 'bun:test'
import type NiiVue from '@/NVControlBase'
import {
  getCanvasInstances,
  getCanvasViewport,
  registerCanvasInstance,
  setCanvasViewport,
} from './canvasRegistry'

globalThis.HTMLCanvasElement ??= class {} as unknown as typeof HTMLCanvasElement
// Spy on the real view rather than mock.module, which would leak a stub into
// every later test file in the same bun run.
const { default: NVViewGL } = await import('@/gl/NVViewGL')
const viewCanvases: unknown[] = []
beforeEach(() => {
  spyOn(NVViewGL.prototype, 'init').mockImplementation(async function (
    this: InstanceType<typeof NVViewGL>,
  ) {
    viewCanvases.push(this.canvas)
  })
  spyOn(NVViewGL.prototype, 'resize').mockImplementation(() => {})
  spyOn(NVViewGL.prototype, 'destroy').mockImplementation(() => {})
})
afterEach(() => mock.restore())
const { recreateView } = await import('./viewWebGL2')

globalThis.ResizeObserver ??= class {
  observe() {}
  disconnect() {}
} as unknown as typeof ResizeObserver

function fakeCanvas(attached = true): HTMLCanvasElement {
  const parent = { replaceChild() {} }
  // NVViewGL checks instanceof, so build on the real prototype.
  return Object.assign(Object.create(HTMLCanvasElement.prototype), {
    parentNode: attached ? parent : null,
    style: {},
    cloneNode: () => fakeCanvas(),
    addEventListener() {},
    removeEventListener() {},
  }) as HTMLCanvasElement
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

  // A detached canvas is cloned too, so a new antialias setting takes effect.
  const detached = fakeCanvas(false)
  const lone = fakeCtrl(detached)
  await recreateView(lone)
  expect(lone.canvas).not.toBe(detached)
})

test('recreateView keeps a full-frame canvas shared with a bounded sibling', async () => {
  const shared = fakeCanvas()
  const full = fakeCtrl(shared)
  const inset = fakeCtrl(shared, [
    [0.6, 0.6],
    [1, 1],
  ])
  registerCanvasInstance(full, shared)
  registerCanvasInstance(inset, shared)
  await recreateView(full)
  // Cloning would move the inset onto a canvas its live view never drew to.
  expect(full.canvas).toBe(shared)
  expect(inset.canvas).toBe(shared)
  expect(viewCanvases.at(-1)).toBe(shared)
})

test('recreateView clones a lone bounded canvas so antialias can change', async () => {
  const old = fakeCanvas()
  const lone = fakeCtrl(old, [
    [0, 0],
    [0.5, 1],
  ])
  registerCanvasInstance(lone, old)
  await recreateView(lone)
  expect(lone.canvas).not.toBe(old)
  expect(viewCanvases.at(-1)).toBe(lone.canvas)
})

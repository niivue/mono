import { mock } from 'bun:test'

// Real enum values from @niivue/niivue
export const SLICE_TYPE = {
  AXIAL: 0,
  CORONAL: 1,
  SAGITTAL: 2,
  MULTIPLANAR: 3,
  RENDER: 4,
} as const

export const DRAG_MODE = {
  none: 0,
  contrast: 1,
  measurement: 2,
  pan: 3,
  slicer3D: 4,
  callbackOnly: 5,
  roiSelection: 6,
  angle: 7,
  crosshair: 8,
  windowing: 9,
} as const

export const SHOW_RENDER = {
  NEVER: 0,
  ALWAYS: 1,
  AUTO: 2,
} as const

export interface MockNiiVueGPU {
  attachToCanvas: ReturnType<typeof mock>
  addVolume: ReturnType<typeof mock>
  broadcastTo: ReturnType<typeof mock>
  setVolume: ReturnType<typeof mock>
  resize: ReturnType<typeof mock>
  updateGLVolume: ReturnType<typeof mock>
  destroy: ReturnType<typeof mock>
  addEventListener: ReturnType<typeof mock>
  removeEventListener: ReturnType<typeof mock>
  /** Emit a mock event — triggers handlers registered via addEventListener */
  emitEvent: (name: string, detail: unknown) => void
  volumes: unknown[]
  meshes: unknown[]
  model: {
    removeVolume: ReturnType<typeof mock>
  }
  customLayout: unknown[] | null
  sliceType: number
  showRender: number
  primaryDragMode: number
  secondaryDragMode: number
  canvas: HTMLCanvasElement | null
  /** Internal handler registry (event name → callbacks) */
  _handlers: Map<string, Set<(evt: unknown) => void>>
}

/** Create a fresh MockNiiVueGPU instance with all methods stubbed */
export function createMockNiiVueGPU(): MockNiiVueGPU {
  const handlers = new Map<string, Set<(evt: unknown) => void>>()

  const instance: MockNiiVueGPU = {
    _handlers: handlers,
    attachToCanvas: mock(
      () => attachToCanvasResults.shift() ?? Promise.resolve(),
    ),
    addVolume: null as unknown as ReturnType<typeof mock>,
    broadcastTo: mock(() => {}),
    setVolume: mock(() => Promise.resolve()),
    resize: mock(() => {}),
    updateGLVolume: mock(() => Promise.resolve()),
    destroy: mock(() => {}),
    addEventListener: mock((name: string, cb: (evt: unknown) => void) => {
      if (!handlers.has(name)) handlers.set(name, new Set())
      handlers.get(name)?.add(cb)
    }),
    removeEventListener: mock((name: string, cb: (evt: unknown) => void) => {
      handlers.get(name)?.delete(cb)
    }),
    emitEvent(name: string, detail: unknown) {
      const cbs = handlers.get(name)
      if (cbs) {
        for (const cb of cbs) cb({ detail })
      }
    },
    volumes: [],
    meshes: [],
    model: {
      removeVolume: mock(() => {}),
    },
    customLayout: null,
    sliceType: SLICE_TYPE.AXIAL,
    showRender: SHOW_RENDER.AUTO,
    primaryDragMode: DRAG_MODE.crosshair,
    secondaryDragMode: DRAG_MODE.pan,
    canvas: null,
  }

  instance.addVolume = mock((opts: { url: string }) => {
    const vol = { url: opts.url, name: opts.url }
    instance.volumes.push(vol)
    return Promise.resolve(vol)
  })

  return instance
}

/** Track all created instances so tests can inspect them */
export const mockInstances: MockNiiVueGPU[] = []
export const attachToCanvasResults: Promise<void>[] = []

/** Clear tracked instances between tests */
export function clearMockInstances(): void {
  mockInstances.length = 0
  attachToCanvasResults.length = 0
}

/**
 * The mock NiiVueGPU constructor (default export).
 * Captures constructor options and returns a mock instance.
 * We push `this` (the actual instance) so tests can mutate it directly.
 */
export class NiiVueGPU {
  [key: string]: unknown

  constructor(_opts?: unknown) {
    const instance = createMockNiiVueGPU()
    Object.assign(this, instance)
    mockInstances.push(this as unknown as MockNiiVueGPU)
  }
}

// Default export to match `import NiiVueGPU from "@niivue/niivue"`
export default NiiVueGPU

// NVImage is just a type, export a placeholder for value-level usage
export class NVImage {}

/**
 * Register the module mock. Call this at the top of test files
 * that import modules depending on @niivue/niivue.
 */
export function registerNiivueMock(): void {
  mock.module('@niivue/niivue', () => ({
    default: NiiVueGPU,
    NiiVueGPU,
    NVImage,
    SLICE_TYPE,
    DRAG_MODE,
    SHOW_RENDER,
  }))
}

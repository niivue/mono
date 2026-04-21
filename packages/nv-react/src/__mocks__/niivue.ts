import { mock } from "bun:test";

// Real enum values from @niivue/niivue
export const SLICE_TYPE = {
  AXIAL: 0,
  CORONAL: 1,
  SAGITTAL: 2,
  MULTIPLANAR: 3,
  RENDER: 4,
} as const;

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
} as const;

export const SHOW_RENDER = {
  NEVER: 0,
  ALWAYS: 1,
  AUTO: 2,
} as const;

export interface MockNiiVueGPU {
  attachToCanvas: ReturnType<typeof mock>;
  addVolume: ReturnType<typeof mock>;
  broadcastTo: ReturnType<typeof mock>;
  setVolume: ReturnType<typeof mock>;
  resize: ReturnType<typeof mock>;
  updateGLVolume: ReturnType<typeof mock>;
  destroy: ReturnType<typeof mock>;
  addEventListener: ReturnType<typeof mock>;
  removeEventListener: ReturnType<typeof mock>;
  volumes: unknown[];
  meshes: unknown[];
  model: {
    removeVolume: ReturnType<typeof mock>;
  };
  sliceType: number;
  showRender: number;
  primaryDragMode: number;
  secondaryDragMode: number;
  canvas: HTMLCanvasElement | null;
}

/** Create a fresh MockNiiVueGPU instance with all methods stubbed */
export function createMockNiiVueGPU(): MockNiiVueGPU {
  return {
    attachToCanvas: mock(() => Promise.resolve()),
    addVolume: mock((opts: { url: string }) =>
      Promise.resolve({ url: opts.url, name: opts.url }),
    ),
    broadcastTo: mock(() => {}),
    setVolume: mock(() => Promise.resolve()),
    resize: mock(() => {}),
    updateGLVolume: mock(() => Promise.resolve()),
    destroy: mock(() => {}),
    addEventListener: mock(() => {}),
    removeEventListener: mock(() => {}),
    volumes: [],
    meshes: [],
    model: {
      removeVolume: mock(() => {}),
    },
    sliceType: SLICE_TYPE.AXIAL,
    showRender: SHOW_RENDER.AUTO,
    primaryDragMode: DRAG_MODE.crosshair,
    secondaryDragMode: DRAG_MODE.pan,
    canvas: null,
  };
}

/** Track all created instances so tests can inspect them */
export const mockInstances: MockNiiVueGPU[] = [];

/** Clear tracked instances between tests */
export function clearMockInstances(): void {
  mockInstances.length = 0;
}

/**
 * The mock NiiVueGPU constructor (default export).
 * Captures constructor options and returns a mock instance.
 * We push `this` (the actual instance) so tests can mutate it directly.
 */
export class NiiVueGPU {
  [key: string]: unknown;

  constructor(_opts?: unknown) {
    const instance = createMockNiiVueGPU();
    Object.assign(this, instance);
    mockInstances.push(this as unknown as MockNiiVueGPU);
  }
}

// Default export to match `import NiiVueGPU from "@niivue/niivue"`
export default NiiVueGPU;

// NVImage is just a type, export a placeholder for value-level usage
export class NVImage {}

/**
 * Register the module mock. Call this at the top of test files
 * that import modules depending on @niivue/niivue.
 */
export function registerNiivueMock(): void {
  mock.module("@niivue/niivue", () => ({
    default: NiiVueGPU,
    NiiVueGPU,
    NVImage,
    SLICE_TYPE,
    DRAG_MODE,
    SHOW_RENDER,
  }));
}

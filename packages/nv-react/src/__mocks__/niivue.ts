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

export interface MockNiivue {
  attachToCanvas: ReturnType<typeof mock>;
  addVolumeFromUrl: ReturnType<typeof mock>;
  broadcastTo: ReturnType<typeof mock>;
  setSliceType: ReturnType<typeof mock>;
  setCustomLayout: ReturnType<typeof mock>;
  clearCustomLayout: ReturnType<typeof mock>;
  setMouseEventConfig: ReturnType<typeof mock>;
  resizeListener: ReturnType<typeof mock>;
  removeVolume: ReturnType<typeof mock>;
  updateGLVolume: ReturnType<typeof mock>;
  setOpacity: ReturnType<typeof mock>;
  onLocationChange: ((data: unknown) => void) | null;
  onImageLoaded: ((vol: unknown) => void) | null;
  onMeshLoaded: ((mesh: unknown) => void) | null;
  volumes: unknown[];
  meshes: unknown[];
  opts: Record<string, unknown>;
  _gl: { getExtension: ReturnType<typeof mock> } | null;
  canvas: HTMLCanvasElement | null;
}

/** Create a fresh MockNiivue instance with all methods stubbed */
export function createMockNiivue(): MockNiivue {
  return {
    attachToCanvas: mock(() => Promise.resolve()),
    addVolumeFromUrl: mock((opts: { url: string }) =>
      Promise.resolve({ url: opts.url, name: opts.url }),
    ),
    broadcastTo: mock(() => {}),
    setSliceType: mock(() => ({})),
    setCustomLayout: mock(() => {}),
    clearCustomLayout: mock(() => {}),
    setMouseEventConfig: mock(() => {}),
    resizeListener: mock(() => {}),
    removeVolume: mock(() => {}),
    updateGLVolume: mock(() => {}),
    setOpacity: mock(() => {}),
    onLocationChange: null,
    onImageLoaded: null,
    onMeshLoaded: null,
    volumes: [],
    meshes: [],
    opts: { multiplanarShowRender: SHOW_RENDER.AUTO },
    _gl: {
      getExtension: mock(() => ({ loseContext: mock(() => {}) })),
    },
    canvas: null,
  };
}

/** Track all created instances so tests can inspect them */
export const mockInstances: MockNiivue[] = [];

/** Clear tracked instances between tests */
export function clearMockInstances(): void {
  mockInstances.length = 0;
}

/**
 * The mock Niivue constructor.
 * Captures constructor options and returns a mock instance.
 * We push `this` (the actual instance) so tests can mutate it directly.
 */
export class Niivue {
  [key: string]: unknown;

  constructor(_opts?: unknown) {
    const instance = createMockNiivue();
    Object.assign(this, instance);
    mockInstances.push(this as unknown as MockNiivue);
  }
}

// NVImage is just a type, export a placeholder for value-level usage
export class NVImage {}

/**
 * Register the module mock. Call this at the top of test files
 * that import modules depending on @niivue/niivue.
 */
export function registerNiivueMock(): void {
  mock.module("@niivue/niivue", () => ({
    Niivue,
    NVImage,
    SLICE_TYPE,
    DRAG_MODE,
    SHOW_RENDER,
  }));
}

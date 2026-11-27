/// <reference types="@webgpu/types" />
// NiiVue's overlay lifecycle hook, as uikit draws into it. These are uikit's own
// copies of the types (core names them OverlayFrame and so on): structural, so
// a uikit overlay registers on NiiVue unchanged, and uikit needs no niivue
// dependency to compile or to draw on a bare canvas (attachToCanvas).
// GPUDevice and friends come from the ambient @webgpu/types.

/**
 * The live backend handle for the current frame. A WebGL2 overlay draws directly
 * against the immediate-mode context (viewport + scissor already set to the view's
 * bounds rect). A WebGPU overlay appends draws to the frame's single open render
 * pass — it must NOT call `pass.end()` (NiiVue owns that) and must draw before it.
 */
export type UIKitBackendHandle =
  | { readonly backend: 'webgl2'; readonly gl: WebGL2RenderingContext }
  | {
      readonly backend: 'webgpu'
      readonly device: GPUDevice
      readonly pass: GPURenderPassEncoder
      /** Color attachment format of the open pass — match it in your pipeline. */
      readonly colorFormat: GPUTextureFormat
      /** MSAA sample count of the open pass (1 = no multisampling). */
      readonly sampleCount: number
      /**
       * Depth-stencil attachment format of the open pass, or undefined when the
       * pass has no depth attachment (e.g. the standalone slide viewer). An
       * overlay pipeline must omit its depth-stencil state when this is undefined.
       */
      readonly depthFormat?: GPUTextureFormat
      /**
       * A copy of the frame drawn so far (scene and core overlays), at the
       * pass's attachment size, for an overlay that samples it (a magnifier).
       * The first call ends the pass and continues in a new one, single-sample
       * without depth, so read `pass`, `sampleCount` and `depthFormat` again
       * after it. Later calls in the frame return the same copy.
       */
      readonly captureScene?: () => GPUTexture
    }

/** The drawable rectangle for this frame, in device pixels. */
export interface UIKitOverlayBounds {
  /** Bounds origin x within the canvas backing store (0 for a full-canvas view). */
  readonly x: number
  /** Bounds origin y within the canvas backing store (0 for a full-canvas view). */
  readonly y: number
  /** Drawable width in device pixels (== canvas.width for a full-canvas view). */
  readonly width: number
  /** Drawable height in device pixels (== canvas.height for a full-canvas view). */
  readonly height: number
}

/** Everything an overlay renderer needs to draw one frame. */
export interface UIKitOverlayFrame {
  readonly handle: UIKitBackendHandle
  readonly bounds: UIKitOverlayBounds
  /** Effective device pixel ratio in force for this view. */
  readonly dpr: number
  /**
   * True when the scene has settled: not busy uploading, not mid-drag, no
   * cross-fade animating, and no chunk-streaming work outstanding — i.e. NiiVue is
   * not about to schedule another frame on its own. Cheap widgets ignore this and
   * draw every frame; expensive widgets can defer heavy work until it is true.
   */
  readonly settled: boolean
}

/** A privileged overlay renderer registered on a NiiVue controller. */
export interface UIKitOverlayRenderer {
  /** Draw this frame's overlay. Called at the end of every frame, per backend. */
  drawOverlay(frame: UIKitOverlayFrame): void
}

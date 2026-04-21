/**
 * NiiVue Extension API — shared type definitions.
 *
 * Small standalone types used by the extension context and by extensions.
 * The context class itself lives in `./context.ts`.
 */

import type { NVEventMap } from '@/NVEvents'
import type { NIFTI1, NIFTI2, TypedVoxelArray } from '@/NVTypes'

// ============================================================
// Shared geometry types
// ============================================================

/**
 * Volume dimensions in RAS voxel space.
 * Extracted from `NVImage.dimsRAS` (indices 1–3).
 */
export interface DrawingDims {
  dimX: number
  dimY: number
  dimZ: number
}

// ============================================================
// Slice pointer events (high-level, pre-computed)
// ============================================================

/**
 * High-level event emitted when the pointer interacts with a 2D slice.
 * NiiVue pre-computes the voxel and mm coordinates from the hit test.
 */
export interface SlicePointerEvent {
  /** RAS voxel coordinate under the cursor (rounded to nearest integer). */
  voxel: [number, number, number]
  /** World mm coordinate of the intersection point. */
  mm: [number, number, number]
  /** Which slice orientation was hit (0=axial, 1=coronal, 2=sagittal). */
  sliceType: number
  /** Canvas pixel X (device-pixel-ratio adjusted). */
  canvasX: number
  /** Canvas pixel Y (device-pixel-ratio adjusted). */
  canvasY: number
  /** The original DOM PointerEvent (for button / modifier key checks). */
  pointerEvent: PointerEvent
}

/**
 * Extension-specific event map, extending NiiVue's built-in events.
 */
export interface NVExtensionEventMap extends NVEventMap {
  slicePointerMove: SlicePointerEvent
  slicePointerUp: SlicePointerEvent
  slicePointerLeave: undefined
}

// ============================================================
// Data access interfaces
// ============================================================

/**
 * Read-only live access to the background volume's data.
 * All properties are getters — always reflect the current state.
 */
export interface BackgroundVolumeAccess {
  /** Raw image data in header voxel order. */
  readonly img: TypedVoxelArray
  /** NIFTI header. */
  readonly hdr: NIFTI1 | NIFTI2
  /** Volume dimensions in RAS space. */
  readonly dims: DrawingDims
  /** Voxel size in mm `[sx, sy, sz]`. */
  readonly voxelSizeMM: [number, number, number]
  /** Display min intensity (may change via contrast drag). */
  readonly calMin: number
  /** Display max intensity (may change via contrast drag). */
  readonly calMax: number
  /** Robust 2nd-percentile intensity. */
  readonly robustMin: number
  /** Robust 98th-percentile intensity. */
  readonly robustMax: number
  /** Absolute minimum intensity in the volume. */
  readonly globalMin: number
  /** Absolute maximum intensity in the volume. */
  readonly globalMax: number

  /**
   * Image intensity data in RAS voxel order as Float32Array.
   *
   * Indexed as `data[rx + ry * dimX + rz * dimX * dimY]` — same coordinate
   * space as the drawing bitmap. When the volume is already in RAS order,
   * this is a zero-copy view of the original data. Otherwise a reordered
   * copy is created and cached.
   *
   * Values are **raw** (not scaled by scl_slope / scl_inter).
   * Returns null if no image data is available.
   */
  readonly imgRAS: Float32Array | null
}

/** Handle returned by `acquireSharedBuffer()`. */
export interface SharedBufferHandle {
  /** Uint8Array view over the SharedArrayBuffer — both threads can access. */
  readonly view: Uint8Array
  /** Restore the original drawing buffer. Must be called when done. */
  release(): void
}

/**
 * Live access to the drawing layer's data and write-back actions.
 */
export interface DrawingAccess {
  /** Current drawing bitmap (Uint8Array in RAS voxel order). Live reference. */
  readonly bitmap: Uint8Array
  /** Volume dimensions in RAS space. */
  readonly dims: DrawingDims
  /** Voxel size in mm `[sx, sy, sz]`. */
  readonly voxelSizeMM: [number, number, number]

  /**
   * Copy a new bitmap into the drawing volume and refresh the display.
   * Equivalent to `drawVol.img.set(bitmap); nv.refreshDrawing()`.
   */
  update(bitmap: Uint8Array): void

  /**
   * Refresh the drawing display without changing data.
   * Use after in-place modifications (e.g., SharedArrayBuffer writes).
   */
  refresh(): void

  /**
   * Replace the drawing volume's backing buffer with a SharedArrayBuffer
   * for zero-copy worker communication.
   *
   * Returns a handle whose `.view` is a Uint8Array over the SharedArrayBuffer.
   * Call `.release()` to restore the original buffer.
   *
   * Requires cross-origin isolation (COOP+COEP) for SharedArrayBuffer.
   */
  acquireSharedBuffer(): SharedBufferHandle
}

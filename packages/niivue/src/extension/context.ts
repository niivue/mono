/**
 * NiiVue Extension Context — implementation.
 *
 * Created via `nv.createExtensionContext()`. Provides a stable interface for
 * extensions to interact with the NiiVue controller without reaching into
 * its internals.
 *
 * All data access properties are live getters — they read from the controller
 * at access time, so they always reflect the current state. Extensions use
 * events only when they need to _react_ to state transitions, not to keep
 * a local copy in sync.
 */

import * as NVTransforms from '@/math/NVTransforms'
import type NiiVueGPU from '@/NVControlBase'
import type { NVImage, TypedVoxelArray } from '@/NVTypes'
import * as NVSliceLayout from '@/view/NVSliceLayout'
import { buildDerivedScalarVolume } from '@/volume/mrsi'
import { nii2volume } from '@/volume/NVVolume'
import type { TransformOptions, VolumeTransform } from '@/volume/transforms'
import { getImageDataRAS } from '@/volume/utils'
import type {
  BackgroundVolumeAccess,
  DrawingAccess,
  DrawingDims,
  MrsVolumeAccess,
  NVExtensionEventMap,
  SharedBufferHandle,
  SlicePointerEvent,
} from './types'

// ============================================================
// Internal event names used for high-level slice pointer events
// ============================================================

const _SLICE_EVENTS = new Set<string>([
  'slicePointerMove',
  'slicePointerUp',
  'slicePointerLeave',
])

type AnyListener = (...args: unknown[]) => void

// ============================================================
// Context implementation
// ============================================================

/**
 * The extension context is the primary interface between an extension and NiiVue.
 * Created via `nv.createExtensionContext()`.
 *
 * - **Data access**: Live getters (always current, no staleness).
 * - **Events**: Subscribe to NiiVue events + high-level slice pointer events.
 * - **Actions**: Safe write-back methods for volumes and drawing.
 * - **Coordinates**: Utility transforms (vox↔mm).
 * - **Lifecycle**: `dispose()` removes all subscriptions registered through this context.
 */
export class NVExtensionContext {
  /** Tracked subscriptions for auto-cleanup on dispose. */
  private _subs: Array<{ type: string; listener: AnyListener }> = []
  /** Whether this context has been disposed. */
  private _disposed = false
  /** Saved original drawing img reference for SharedArrayBuffer release. */
  private _savedDrawingImg: Uint8Array | null = null
  /** Cached RAS-ordered intensity data (invalidated on volume load). */
  private _cachedImgRAS: Float32Array | null = null
  /** Volume that _cachedImgRAS was computed from (identity check). */
  private _cachedImgRASVol: NVImage | null = null

  constructor(private readonly nv: NiiVueGPU) {}

  // ── Data access ───────────────────────────────────────────

  get backgroundVolume(): BackgroundVolumeAccess | null {
    const vol = this.nv.volumes[0]
    if (!vol?.dimsRAS || !vol.img || !vol.hdr) return null
    const self = this
    return {
      get img(): TypedVoxelArray {
        return vol.img as TypedVoxelArray
      },
      get hdr() {
        return vol.hdr
      },
      get dims(): DrawingDims {
        return {
          dimX: vol.dimsRAS?.[1] ?? 0,
          dimY: vol.dimsRAS?.[2] ?? 0,
          dimZ: vol.dimsRAS?.[3] ?? 0,
        }
      },
      get voxelSizeMM(): [number, number, number] {
        const p = vol.pixDimsRAS
        return p ? [p[1], p[2], p[3]] : [1, 1, 1]
      },
      get calMin() {
        return vol.calMin
      },
      get calMax() {
        return vol.calMax
      },
      get robustMin() {
        return vol.robustMin
      },
      get robustMax() {
        return vol.robustMax
      },
      get globalMin() {
        return vol.globalMin
      },
      get globalMax() {
        return vol.globalMax
      },
      get imgRAS(): Float32Array | null {
        // Return cached copy if the volume hasn't changed
        if (self._cachedImgRASVol === vol && self._cachedImgRAS) {
          return self._cachedImgRAS
        }
        const data = getImageDataRAS(vol)
        self._cachedImgRAS = data
        self._cachedImgRASVol = vol
        return data
      },
    }
  }

  get drawing(): DrawingAccess | null {
    const drawVol = this.nv.drawingVolume
    if (!drawVol?.img) return null
    const bg = this.backgroundVolume
    if (!bg) return null
    const nv = this.nv
    const self = this
    return {
      get bitmap(): Uint8Array {
        return drawVol.img as Uint8Array
      },
      get dims(): DrawingDims {
        return bg.dims
      },
      get voxelSizeMM(): [number, number, number] {
        return bg.voxelSizeMM
      },

      update(bitmap: Uint8Array): void {
        ;(drawVol.img as Uint8Array).set(bitmap)
        nv.refreshDrawing()
      },

      refresh(): void {
        nv.refreshDrawing()
      },

      acquireSharedBuffer(): SharedBufferHandle {
        const dims = bg.dims
        const nVox = dims.dimX * dims.dimY * dims.dimZ
        const sab = new SharedArrayBuffer(nVox)
        const view = new Uint8Array(sab)
        // Copy current bitmap into the shared buffer
        if (drawVol.img) {
          view.set(drawVol.img as Uint8Array)
        }
        // Save original and swap
        self._savedDrawingImg = drawVol.img as Uint8Array
        drawVol.img = view
        return {
          view,
          release(): void {
            if (self._savedDrawingImg) {
              // Copy shared data back to a regular buffer
              const restored = new Uint8Array(nVox)
              restored.set(view)
              drawVol.img = restored
              self._savedDrawingImg = null
            }
          },
        }
      },
    }
  }

  get volumes(): readonly NVImage[] {
    return this.nv.volumes
  }

  /** Build a read-only MRS access object for a volume, or null if not MRSI. */
  private mrsAccessFor(vol: NVImage | undefined): MrsVolumeAccess | null {
    if (!vol?.complexFID || !vol.mrsMeta) return null
    return {
      id: vol.id ?? vol.name,
      complexData: vol.complexFID,
      meta: vol.mrsMeta,
      dims: {
        dimX: vol.dimsRAS?.[1] ?? 0,
        dimY: vol.dimsRAS?.[2] ?? 0,
        dimZ: vol.dimsRAS?.[3] ?? 0,
      },
      makeScalarOverlay(data: Float32Array, name: string): NVImage {
        return buildDerivedScalarVolume(vol, data, name, nii2volume)
      },
      voxelCenterMm(
        mm: [number, number, number],
      ): [number, number, number] | null {
        const d = vol.dimsRAS
        if (!vol.matRAS || !d) return null
        // mm -> nearest MRSI voxel (rounded). Outside the grid -> null (so a
        // caller leaves the crosshair free over the anatomy, only snapping
        // within the spectroscopy slab).
        const v = NVTransforms.mm2vox(vol, mm)
        const ix = Math.round(v[0])
        const iy = Math.round(v[1])
        const iz = Math.round(v[2])
        if (
          ix < 0 ||
          ix >= d[1] ||
          iy < 0 ||
          iy >= d[2] ||
          iz < 0 ||
          iz >= d[3]
        )
          return null
        const c = NVTransforms.vox2mm(null, [ix, iy, iz], vol.matRAS)
        return [c[0], c[1], c[2]]
      },
    }
  }

  /**
   * Read-only access to the first loaded complex MRSI volume (one that retained
   * a `complexFID` + `mrsMeta` on the volume path), or null if none is loaded.
   * Exposes the raw FID buffer + spectral metadata for the range-integration
   * tool and a helper to build derived scalar overlays on the same grid. When
   * several MRSI volumes may be loaded, prefer {@link mrsById}.
   */
  get mrs(): MrsVolumeAccess | null {
    return this.mrsAccessFor(
      this.nv.volumes.find((v) => v.complexFID && v.mrsMeta),
    )
  }

  /** Read-only MRS access bound to a specific volume id (multi-MRSI safe). */
  mrsById(id: string): MrsVolumeAccess | null {
    return this.mrsAccessFor(this.nv.volumes.find((v) => v.id === id))
  }

  // ── Events ────────────────────────────────────────────────

  on<K extends keyof NVExtensionEventMap>(
    type: K,
    listener: NVExtensionEventMap[K] extends undefined
      ? () => void
      : (event: CustomEvent<NVExtensionEventMap[K]>) => void,
  ): void {
    if (this._disposed) return
    // All events (both NiiVue-native and slice pointer) are dispatched
    // on the NiiVue EventTarget. Just subscribe and track.
    this.nv.addEventListener(
      type as string,
      listener as EventListenerOrEventListenerObject,
    )
    this._subs.push({ type, listener: listener as AnyListener })
  }

  off<K extends keyof NVExtensionEventMap>(
    type: K,
    listener: NVExtensionEventMap[K] extends undefined
      ? () => void
      : (event: CustomEvent<NVExtensionEventMap[K]>) => void,
  ): void {
    this.nv.removeEventListener(
      type as string,
      listener as EventListenerOrEventListenerObject,
    )
    const idx = this._subs.findIndex(
      (s) => s.type === type && s.listener === listener,
    )
    if (idx >= 0) this._subs.splice(idx, 1)
  }

  // ── Actions ───────────────────────────────────────────────

  async addVolume(vol: NVImage): Promise<void> {
    await this.nv.addVolume(vol)
  }

  async removeAllVolumes(): Promise<void> {
    await this.nv.removeAllVolumes()
  }

  createEmptyDrawing(): void {
    this.nv.createEmptyDrawing()
  }

  closeDrawing(): void {
    this.nv.closeDrawing()
  }

  drawUndo(): void {
    this.nv.drawUndo()
  }

  refreshDrawing(): void {
    this.nv.refreshDrawing()
  }

  registerVolumeTransform(transform: VolumeTransform): void {
    this.nv.registerVolumeTransform(transform)
  }

  async applyVolumeTransform(
    name: string,
    volume: NVImage,
    options?: TransformOptions,
  ): Promise<NVImage> {
    const transform = this.nv.volumeTransform[name]
    if (!transform) throw new Error(`Unknown volume transform: ${name}`)
    return transform(volume, options)
  }

  // ── Coordinate transforms ─────────────────────────────────

  vox2mm(vox: [number, number, number]): [number, number, number] {
    const vol = this.nv.volumes[0]
    if (!vol?.matRAS) throw new Error('No background volume with matRAS loaded')
    const mm = NVTransforms.vox2mm(null, vox, vol.matRAS)
    return [mm[0], mm[1], mm[2]]
  }

  mm2vox(mm: [number, number, number]): [number, number, number] {
    const vol = this.nv.volumes[0]
    if (!vol?.matRAS) throw new Error('No background volume with matRAS loaded')
    const result = NVTransforms.mm2vox(vol, mm)
    return [result[0], result[1], result[2]]
  }

  // ── Lifecycle ─────────────────────────────────────────────

  dispose(): void {
    if (this._disposed) return
    this._disposed = true
    // Remove all tracked subscriptions
    for (const sub of this._subs) {
      this.nv.removeEventListener(
        sub.type,
        sub.listener as EventListenerOrEventListenerObject,
      )
    }
    this._subs = []
    // Release shared buffer if still acquired
    if (this._savedDrawingImg) {
      const drawVol = this.nv.drawingVolume
      if (drawVol) {
        drawVol.img = this._savedDrawingImg
      }
      this._savedDrawingImg = null
    }
    // Clear cached data
    this._cachedImgRAS = null
    this._cachedImgRASVol = null
  }
}

// ============================================================
// Slice pointer event emission helpers
// ============================================================

/**
 * Compute a SlicePointerEvent from a DOM PointerEvent by doing the
 * standard hitTest → screenSlicePick → mm2vox pipeline.
 *
 * Returns null if the pointer is not over a 2D slice.
 */
export function computeSlicePointerEvent(
  nv: NiiVueGPU,
  evt: PointerEvent,
): SlicePointerEvent | null {
  if (!nv.canvas || !nv.view) return null
  const vol = nv.volumes[0]
  if (!vol?.matRAS || !vol.dimsRAS) return null

  const rect = nv.canvas.getBoundingClientRect()
  let dpr = window.devicePixelRatio || 1
  const forcedDpr = nv.opts?.forceDevicePixelRatio ?? -1
  if (forcedDpr > 0) dpr = forcedDpr
  const canvasX = (evt.clientX - rect.left) * dpr
  const canvasY = (evt.clientY - rect.top) * dpr

  const hit = nv.view.hitTest(canvasX, canvasY)
  if (!hit || hit.isRender) return null

  const mm = NVSliceLayout.screenSlicePick(
    nv.view.screenSlices,
    (
      nv as unknown as {
        model: Parameters<typeof NVSliceLayout.screenSlicePick>[1]
      }
    ).model,
    canvasX,
    canvasY,
    hit,
  )
  if (!mm) return null

  const vox = NVTransforms.mm2vox(vol, mm)

  // Bounds check
  const rx = Math.round(vox[0])
  const ry = Math.round(vox[1])
  const rz = Math.round(vox[2])
  if (
    rx < 0 ||
    ry < 0 ||
    rz < 0 ||
    rx >= vol.dimsRAS[1] ||
    ry >= vol.dimsRAS[2] ||
    rz >= vol.dimsRAS[3]
  ) {
    return null
  }

  return {
    voxel: [rx, ry, rz],
    mm: [mm[0], mm[1], mm[2]],
    sliceType: hit.sliceType,
    canvasX,
    canvasY,
    pointerEvent: evt,
  }
}

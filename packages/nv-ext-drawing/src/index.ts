/**
 * @niivue/nv-ext-drawing
 *
 * Drawing interpolation and segmentation tools for NiiVue.
 * Operations run in a Web Worker to keep the main thread responsive.
 *
 * All public functions expect image data in RAS voxel order — use
 * `ctx.backgroundVolume.imgRAS` from the NiiVue extension context.
 */

import { NVWorker } from '@niivue/niivue'
import type {
  DrawingDims,
  InterpolationOptions,
  SliceType,
} from './processing/drawing'
import type {
  Connectivity,
  MagicWandOptions,
  MagicWandResult,
  ThresholdMode,
} from './processing/magicWand'
// @ts-expect-error — Vite worker import with inline bundling
import DrawingWorker from './worker?worker&inline'

export type {
  Connectivity,
  DrawingDims,
  InterpolationOptions,
  MagicWandOptions,
  MagicWandResult,
  SliceType,
  ThresholdMode,
}

/** Convert any ArrayLike<number> to Float32Array, returning the input if already Float32. */
function toFloat32(data: ArrayLike<number>): Float32Array {
  if (data instanceof Float32Array) return data
  const f32 = new Float32Array(data.length)
  for (let i = 0; i < data.length; i++) f32[i] = data[i]
  return f32
}

// ---------------------------------------------------------------------------
// Shared worker (lazy singleton)
// ---------------------------------------------------------------------------

let bridge: NVWorker | null = null

function getBridge(): NVWorker {
  if (!bridge) bridge = new NVWorker(() => new DrawingWorker())
  return bridge
}

// ---------------------------------------------------------------------------
// Async (worker-based) API
// ---------------------------------------------------------------------------

/**
 * Find the first and last slices containing drawing data along a given axis.
 * Runs in a Web Worker.
 */
export async function findDrawingBoundarySlices(
  sliceType: SliceType,
  drawBitmap: Uint8Array,
  dims: DrawingDims,
): Promise<{ first: number; last: number } | null> {
  const buf = drawBitmap.buffer.slice(
    drawBitmap.byteOffset,
    drawBitmap.byteOffset + drawBitmap.byteLength,
  )
  const res = await getBridge().execute<{
    result: { first: number; last: number } | null
  }>(
    {
      name: 'findBoundarySlices',
      sliceType,
      drawBitmap: buf,
      dims,
    },
    [buf],
  )
  return res.result
}

/**
 * Interpolate between drawn slices to fill gaps in the drawing bitmap.
 * Runs in a Web Worker. Returns a new Uint8Array with the interpolated bitmap.
 *
 * Image data (`imageData`) must be in RAS voxel order. Use
 * `ctx.backgroundVolume.imgRAS` from the extension context.
 */
export async function interpolateMaskSlices(
  drawBitmap: Uint8Array,
  dims: DrawingDims,
  imageData: ArrayLike<number> | null,
  maxVal: number,
  sliceIndexLow: number | undefined,
  sliceIndexHigh: number | undefined,
  options?: InterpolationOptions,
): Promise<Uint8Array> {
  const bitmapBuf = drawBitmap.buffer.slice(
    drawBitmap.byteOffset,
    drawBitmap.byteOffset + drawBitmap.byteLength,
  )

  const transfers: Transferable[] = [bitmapBuf]
  let imgBuf: ArrayBuffer | null = null

  if (imageData) {
    const f32 = toFloat32(imageData)
    imgBuf = f32.buffer.slice(
      f32.byteOffset,
      f32.byteOffset + f32.byteLength,
    ) as ArrayBuffer
    transfers.push(imgBuf as ArrayBuffer)
  }

  const res = await getBridge().execute<{ drawBitmap: ArrayBuffer }>(
    {
      name: 'interpolateMaskSlices',
      drawBitmap: bitmapBuf,
      dims,
      imageData: imgBuf,
      maxVal,
      sliceIndexLow,
      sliceIndexHigh,
      options: options ?? {},
      rasMap: null,
    },
    transfers,
  )

  return new Uint8Array(res.drawBitmap)
}

// ---------------------------------------------------------------------------
// Magic Wand (click-to-segment) — async worker API
// ---------------------------------------------------------------------------

/**
 * Intensity-based flood fill (magic wand / click-to-segment).
 * Runs in a Web Worker. Returns the updated drawing bitmap **and** a
 * result summary (filled voxel count, thresholds used, seed intensity).
 *
 * Image data (`imageData`) must be in RAS voxel order. Use
 * `ctx.backgroundVolume.imgRAS` from the extension context.
 *
 * @param seed        - `[x, y, z]` RAS-voxel coordinate of the seed.
 * @param drawBitmap  - Drawing bitmap in RAS voxel order.
 * @param dims        - Volume dimensions in RAS space.
 * @param imageData   - Background intensity volume in RAS voxel order.
 * @param options     - See {@link MagicWandOptions}.
 * @param voxelSizeMM - Voxel size in mm `[sx, sy, sz]` for distance constraint.
 */
export async function magicWand(
  seed: [number, number, number],
  drawBitmap: Uint8Array,
  dims: DrawingDims,
  imageData: ArrayLike<number>,
  options?: MagicWandOptions,
  voxelSizeMM?: [number, number, number],
): Promise<{ bitmap: Uint8Array; result: MagicWandResult }> {
  const bitmapBuf = drawBitmap.buffer.slice(
    drawBitmap.byteOffset,
    drawBitmap.byteOffset + drawBitmap.byteLength,
  )

  const f32 = toFloat32(imageData)
  const imgBuf = f32.buffer.slice(
    f32.byteOffset,
    f32.byteOffset + f32.byteLength,
  ) as ArrayBuffer

  const transfers: Transferable[] = [bitmapBuf, imgBuf]

  const res = await getBridge().execute<{
    drawBitmap: ArrayBuffer
    result: MagicWandResult
  }>(
    {
      name: 'magicWand',
      seed,
      drawBitmap: bitmapBuf,
      dims,
      imageData: imgBuf,
      options: options ?? {},
      rasMap: null,
      voxelSizeMM: voxelSizeMM ?? null,
    },
    transfers,
  )

  return { bitmap: new Uint8Array(res.drawBitmap), result: res.result }
}

/**
 * Flood-fill a connected cluster of identically-coloured voxels in the
 * drawing bitmap (erase / recolour). Runs in a Web Worker.
 *
 * @param seed       - `[x, y, z]` RAS-voxel coordinate of the seed.
 * @param drawBitmap - Drawing bitmap in RAS voxel order.
 * @param dims       - Volume dimensions in RAS space.
 * @param newColor   - Colour to apply (0 = erase).
 * @param connectivity - Neighbour connectivity (default 6).
 */
export async function magicWandFromBitmap(
  seed: [number, number, number],
  drawBitmap: Uint8Array,
  dims: DrawingDims,
  newColor: number,
  connectivity: Connectivity = 6,
): Promise<{ bitmap: Uint8Array; count: number }> {
  const bitmapBuf = drawBitmap.buffer.slice(
    drawBitmap.byteOffset,
    drawBitmap.byteOffset + drawBitmap.byteLength,
  )

  const res = await getBridge().execute<{
    drawBitmap: ArrayBuffer
    count: number
  }>(
    {
      name: 'magicWandFromBitmap',
      seed,
      drawBitmap: bitmapBuf,
      dims,
      newColor,
      connectivity,
    },
    [bitmapBuf],
  )

  return { bitmap: new Uint8Array(res.drawBitmap), count: res.count }
}

// ---------------------------------------------------------------------------
// MagicWandShared — zero-copy SharedArrayBuffer preview
// ---------------------------------------------------------------------------

/**
 * High-performance magic wand preview using SharedArrayBuffer.
 *
 * The working bitmap lives in shared memory. The worker restores the
 * committed state, runs the flood fill in-place, and posts back only
 * the result summary. The main thread reads the updated bitmap
 * directly — zero copies on the hot path.
 *
 * **Requires** cross-origin isolation headers (COOP + COEP) for
 * `SharedArrayBuffer` to be available.
 *
 * Image data must be in RAS voxel order. Use `ctx.backgroundVolume.imgRAS`
 * from the extension context.
 *
 * Usage with the extension context:
 * ```ts
 * const ctx = nv.createExtensionContext();
 * const dr = ctx.drawing;
 * const bg = ctx.backgroundVolume;
 * const wand = new MagicWandShared(dr.dims, bg.imgRAS, committed, dr.voxelSizeMM);
 * await wand.ready;
 * ```
 */
export class MagicWandShared {
  /** Uint8Array view over the SharedArrayBuffer — assign to `drawingVolume.img`. */
  readonly bitmap: Uint8Array
  /** Resolves when the worker is initialized and ready for preview calls. */
  readonly ready: Promise<void>

  private _worker: Worker
  private _gen = 0

  constructor(
    dims: DrawingDims,
    imageData: ArrayLike<number>,
    committedBitmap: Uint8Array,
    voxelSizeMM?: [number, number, number],
  ) {
    const nVox = dims.dimX * dims.dimY * dims.dimZ

    // Working bitmap: SharedArrayBuffer — both threads access this
    const workingSAB = new SharedArrayBuffer(nVox)
    this.bitmap = new Uint8Array(workingSAB)
    this.bitmap.set(committedBitmap)

    // Image data: SharedArrayBuffer — immutable after init, both threads read
    const f32 = toFloat32(imageData)
    const imageSAB = new SharedArrayBuffer(f32.byteLength)
    new Float32Array(imageSAB).set(f32)

    // Committed bitmap: transferred to worker (worker owns the copy)
    const committedCopy = committedBitmap.slice()

    // Spawn a dedicated worker (separate from the NVWorker singleton)
    this._worker = new DrawingWorker()

    this.ready = new Promise<void>((resolve) => {
      const h = (ev: MessageEvent) => {
        if (ev.data.type === 'initSharedDone') {
          this._worker.removeEventListener('message', h)
          resolve()
        }
      }
      this._worker.addEventListener('message', h)
    })

    this._worker.postMessage(
      {
        type: 'initShared',
        workingBuffer: workingSAB,
        imageBuffer: imageSAB,
        committedBuffer: committedCopy.buffer,
        dims,
        rasMap: null,
        voxelSizeMM: voxelSizeMM ?? null,
      },
      [committedCopy.buffer],
    )
  }

  /**
   * Send a new committed bitmap to the worker.
   * Call after commit, undo, or clear.
   */
  updateCommitted(committed: Uint8Array): void {
    const copy = committed.slice()
    this._worker.postMessage(
      { type: 'updateCommitted', committed: copy.buffer },
      [copy.buffer],
    )
  }

  /**
   * Run a magic wand preview. The worker restores the committed bitmap
   * into the shared working buffer, runs the flood fill, and returns
   * the result summary. By the time the promise resolves, `this.bitmap`
   * already contains the updated drawing.
   *
   * Returns `null` if a newer preview superseded this one.
   */
  preview(
    seed: [number, number, number],
    options?: MagicWandOptions,
  ): Promise<MagicWandResult | null> {
    const gen = ++this._gen
    return new Promise((resolve) => {
      const h = (ev: MessageEvent) => {
        if (ev.data.type !== 'magicWandSharedResult') return
        this._worker.removeEventListener('message', h)
        if (ev.data.gen !== gen) {
          resolve(null)
          return
        }
        resolve(ev.data.result as MagicWandResult)
      }
      this._worker.addEventListener('message', h)
      this._worker.postMessage({
        type: 'magicWandShared',
        seed,
        options: options ?? {},
        gen,
      })
    })
  }

  /** Terminate the worker and release resources. */
  dispose(): void {
    this._worker.terminate()
  }
}

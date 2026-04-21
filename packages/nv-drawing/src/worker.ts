/**
 * Web Worker for nv-drawing operations.
 *
 * Protocol (NVWorker bridge):
 *   Request:  { _wbId, name, ...payload }
 *   Response: { _wbId, ...result }
 *   Error:    { _wbId, _wbError: string }
 */

const post = (
  self as unknown as {
    postMessage: (msg: unknown, transfer?: Transferable[]) => void
  }
).postMessage.bind(self)

import type {
  DrawingDims,
  InterpolationOptions,
  RASIndexMap,
  SliceType,
} from "./processing/drawing"
import { findBoundarySlices, interpolateMaskSlices } from "./processing/drawing"
import type { Connectivity, MagicWandOptions } from "./processing/magicWand"
import { magicWand, magicWandFromBitmap } from "./processing/magicWand"

interface HandlerResult {
  [key: string]: unknown
}

type Handler = (data: Record<string, unknown>) => HandlerResult

const handlers: Record<string, Handler> = {
  findBoundarySlices(data) {
    const sliceType = data.sliceType as SliceType
    const drawBitmap = new Uint8Array(data.drawBitmap as ArrayBuffer)
    const dims = data.dims as DrawingDims

    const result = findBoundarySlices(sliceType, drawBitmap, dims)
    return { result }
  },

  interpolateMaskSlices(data) {
    const drawBitmap = new Uint8Array(data.drawBitmap as ArrayBuffer)
    const dims = data.dims as DrawingDims
    const imageData = data.imageData
      ? new Float32Array(data.imageData as ArrayBuffer)
      : null
    const maxVal = (data.maxVal as number) ?? 1
    const sliceIndexLow = data.sliceIndexLow as number | undefined
    const sliceIndexHigh = data.sliceIndexHigh as number | undefined
    const options = (data.options as InterpolationOptions) ?? {}
    const rasMap = (data.rasMap as RASIndexMap) ?? undefined

    const result = interpolateMaskSlices(
      drawBitmap,
      dims,
      imageData,
      maxVal,
      sliceIndexLow,
      sliceIndexHigh,
      options,
      rasMap,
    )

    return { drawBitmap: result.buffer }
  },

  magicWand(data) {
    const seed = data.seed as [number, number, number]
    const drawBitmap = new Uint8Array(data.drawBitmap as ArrayBuffer)
    const dims = data.dims as DrawingDims
    const imageData = new Float32Array(data.imageData as ArrayBuffer)
    const options = (data.options as MagicWandOptions) ?? {}
    const rasMap = (data.rasMap as RASIndexMap) ?? undefined
    const voxelSizeMM =
      (data.voxelSizeMM as [number, number, number]) ?? undefined

    const result = magicWand(
      seed,
      drawBitmap,
      dims,
      imageData,
      options,
      rasMap,
      voxelSizeMM,
    )

    return { drawBitmap: drawBitmap.buffer, result }
  },

  magicWandFromBitmap(data) {
    const seed = data.seed as [number, number, number]
    const drawBitmap = new Uint8Array(data.drawBitmap as ArrayBuffer)
    const dims = data.dims as DrawingDims
    const newColor = (data.newColor as number) ?? 0
    const connectivity = (data.connectivity as Connectivity) ?? 6

    const count = magicWandFromBitmap(
      seed,
      drawBitmap,
      dims,
      newColor,
      connectivity,
    )

    return { drawBitmap: drawBitmap.buffer, count }
  },
}

// ---------------------------------------------------------------------------
// SharedArrayBuffer state (for zero-copy preview)
// ---------------------------------------------------------------------------

let sharedWorkingView: Uint8Array | null = null
let sharedImageView: Float32Array | null = null
let sharedCommitted: Uint8Array | null = null
let sharedDims: DrawingDims | null = null
let sharedRasMap: RASIndexMap | undefined
let sharedVoxelSizeMM: [number, number, number] | undefined

// ---------------------------------------------------------------------------

self.onmessage = (e: MessageEvent) => {
  const data = e.data

  // --- SharedArrayBuffer protocol (type-based, no _wbId) ---

  if (data.type === "initShared") {
    sharedWorkingView = new Uint8Array(data.workingBuffer as SharedArrayBuffer)
    sharedImageView = new Float32Array(data.imageBuffer as SharedArrayBuffer)
    sharedCommitted = new Uint8Array(data.committedBuffer as ArrayBuffer)
    sharedDims = data.dims as DrawingDims
    sharedRasMap = (data.rasMap as RASIndexMap) ?? undefined
    sharedVoxelSizeMM =
      (data.voxelSizeMM as [number, number, number]) ?? undefined
    post({ type: "initSharedDone" })
    return
  }

  if (data.type === "updateCommitted") {
    sharedCommitted = new Uint8Array(data.committed as ArrayBuffer)
    return
  }

  if (data.type === "magicWandShared") {
    if (
      !sharedWorkingView ||
      !sharedImageView ||
      !sharedCommitted ||
      !sharedDims
    ) {
      post({
        type: "magicWandSharedResult",
        error: "Not initialized",
        gen: data.gen,
      })
      return
    }
    // Restore committed state into the working buffer
    sharedWorkingView.set(sharedCommitted)
    // Run magic wand in-place on the shared working buffer
    const result = magicWand(
      data.seed as [number, number, number],
      sharedWorkingView,
      sharedDims,
      sharedImageView,
      (data.options as MagicWandOptions) ?? {},
      sharedRasMap,
      sharedVoxelSizeMM,
    )
    post({ type: "magicWandSharedResult", result, gen: data.gen })
    return
  }

  // --- NVWorker protocol (_wbId-based) ---

  const { _wbId: id, name, ...payload } = data
  const handler = handlers[name]
  if (!handler) {
    post({ _wbId: id, _wbError: `Unknown operation: ${name}` })
    return
  }
  try {
    const result = handler(payload)
    // Transfer ArrayBuffers for zero-copy
    const transfers: Transferable[] = []
    for (const v of Object.values(result)) {
      if (v instanceof ArrayBuffer) transfers.push(v)
    }
    post({ _wbId: id, ...result }, transfers)
  } catch (err: unknown) {
    post({
      _wbId: id,
      _wbError: err instanceof Error ? err.message : String(err),
    })
  }
}

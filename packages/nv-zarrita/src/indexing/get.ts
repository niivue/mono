import type { Readable } from '@zarrita/storage'
import type { Array } from '../hierarchy.js'
import { getContext, Array as ZarrArray } from '../hierarchy.js'
import type { Chunk, DataType, Scalar, TypedArray } from '../metadata.js'
import {
  assertSharedArrayBufferAvailable,
  createBuffer,
  resolveSignal,
} from '../util.js'
import {
  isSharedBuffer,
  sharedOutputByDefault,
  WasmDecodeError,
  wasmDecodeInto,
} from '../wasm/pool.js'
import { BasicIndexer } from './indexer.js'
import type {
  GetOptions,
  Prepare,
  SetFromChunk,
  SetScalar,
  Slice,
} from './types.js'
import { createQueue } from './util.js'

function unwrap<D extends DataType>(
  arr: TypedArray<D>,
  idx: number,
): Scalar<D> {
  return ('get' in arr ? arr.get(idx) : arr[idx]) as Scalar<D>
}

export async function get<
  D extends DataType,
  Store extends Readable,
  Arr extends Chunk<D>,
  Sel extends (null | Slice | number)[],
>(
  arr: Array<D, Store>,
  selection: null | Sel,
  opts: GetOptions,
  setter: {
    prepare: Prepare<D, Arr>
    setScalar: SetScalar<D, Arr>
    setFromChunk: SetFromChunk<D, Arr>
  },
): Promise<
  null extends Sel[number] ? Arr : Slice extends Sel[number] ? Arr : Scalar<D>
> {
  if (opts.useSharedArrayBuffer) {
    assertSharedArrayBufferAvailable()
  }

  const signal = resolveSignal(opts)
  const context = getContext(arr)
  const indexer = new BasicIndexer({
    selection,
    shape: arr.shape,
    chunkShape: arr.chunks,
  })

  // Handle scalar arrays (shape=[]) directly, since the indexer yields nothing
  // for zero-dimensional arrays.
  if (arr.shape.length === 0) {
    const { data } = await arr.getChunk(
      [],
      { signal },
      { useSharedArrayBuffer: opts.useSharedArrayBuffer },
    )
    // @ts-expect-error - TS can't narrow this conditional type
    return unwrap(data, 0)
  }

  const size = indexer.shape.reduce((a, b) => a * b, 1)
  // zarrita-wasm: with shared output, workers decode straight into `out`.
  // Sharded arrays qualify too: their context reads and decodes inner chunks.
  const plan =
    (setter as { directWrite?: boolean }).directWrite === true &&
    arr.getChunk === ZarrArray.prototype.getChunk
      ? context.codec.wasmPlan()
      : undefined
  const sharedOutput =
    opts.useSharedArrayBuffer ||
    (plan !== undefined && plan.elemSize > 0 && sharedOutputByDefault())
  let data: TypedArray<D>
  if (sharedOutput) {
    const sample = new context.TypedArray(0)
    if (!('BYTES_PER_ELEMENT' in sample)) {
      console.warn(
        'zarrita: useSharedArrayBuffer is not supported for non-buffer-backed data types.',
      )
      data = new context.TypedArray(size)
    } else {
      const buffer = createBuffer(size * sample.BYTES_PER_ELEMENT, true)
      data = new context.TypedArray(buffer, 0, size)
    }
  } else {
    data = new context.TypedArray(size)
  }
  const out = setter.prepare(
    data,
    indexer.shape,
    context.getStrides(indexer.shape, indexer.outputAxes),
  )

  const queue = opts.createQueue?.() ?? createQueue()
  const direct =
    plan !== undefined &&
    ArrayBuffer.isView(out.data) &&
    isSharedBuffer(out.data.buffer)
  if (direct && plan) {
    const wasm = plan
    const target = out.data as unknown as ArrayBufferView
    for (const { chunkCoords, mapping } of indexer) {
      queue.add(async () => {
        signal?.throwIfAborted()
        const bytes = await context.getChunkBytes(chunkCoords, { signal })
        signal?.throwIfAborted()
        if (bytes) {
          try {
            await wasmDecodeInto(wasm.spec, bytes, wasm.decodedSize, {
              buffer: target.buffer,
              byteOffset: target.byteOffset,
              elemSize: wasm.elemSize,
              stride: out.stride,
              mapping,
            })
            return
          } catch (err) {
            if (!(err instanceof WasmDecodeError)) throw err
            // Let the regular pipeline fall back to JS or raise a
            // proper CodecPipelineError.
          }
        }
        const chunk = bytes
          ? await context.codec.decode(bytes)
          : fillChunk(context)
        setter.setFromChunk(
          out,
          setter.prepare(chunk.data, chunk.shape, chunk.stride),
          mapping,
        )
      })
    }
    await queue.onIdle()
    // @ts-expect-error - TS can't narrow this conditional type
    return indexer.shape.length === 0 ? unwrap(out.data, 0) : out
  }

  for (const { chunkCoords, mapping } of indexer) {
    queue.add(async () => {
      signal?.throwIfAborted()
      const { data, shape, stride } = await arr.getChunk(
        chunkCoords,
        { signal },
        { useSharedArrayBuffer: opts.useSharedArrayBuffer },
      )
      const chunk = setter.prepare(data, shape, stride)
      setter.setFromChunk(out, chunk, mapping)
    })
  }

  await queue.onIdle()

  // If the final out shape is empty (point selection), return a scalar.
  // @ts-expect-error - TS can't narrow this conditional type
  return indexer.shape.length === 0 ? unwrap(out.data, 0) : out
}

/** A chunk of fill values, as `Array.getChunk` makes for a missing key. */
function fillChunk<D extends DataType>(context: {
  TypedArray: new (n: number) => TypedArray<D>
  chunkShape: number[]
  fillValue: Scalar<D> | null
  getStrides(shape: number[]): number[]
}): Chunk<D> {
  const size = context.chunkShape.reduce((a, b) => a * b, 1)
  const data = new context.TypedArray(size)
  // @ts-expect-error: fillValue's union type collapses to never here
  data.fill(context.fillValue)
  return {
    data,
    shape: context.chunkShape,
    stride: context.getStrides(context.chunkShape),
  }
}

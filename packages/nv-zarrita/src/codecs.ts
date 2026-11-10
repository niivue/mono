import type { Codec as _Codec } from 'numcodecs'
import { BitroundCodec } from './codecs/bitround.js'
import { BytesCodec } from './codecs/bytes.js'
import { CastValueCodec } from './codecs/cast_value.js'
import { Crc32cCodec } from './codecs/crc32c.js'
import { DeltaCodec } from './codecs/delta.js'
import * as fallback from './codecs/fallback.js'
import { GzipCodec } from './codecs/gzip.js'
import { JsonCodec } from './codecs/json2.js'
import { ScaleOffsetCodec } from './codecs/scale_offset.js'
import { ShuffleCodec } from './codecs/shuffle.js'
import { TransposeCodec } from './codecs/transpose.js'
import { VLenUTF8 } from './codecs/vlen-utf8.js'
import { ZlibCodec } from './codecs/zlib.js'
import {
  CodecPipelineError,
  InvalidMetadataError,
  UnknownCodecError,
} from './errors.js'
import type { Chunk, CodecMetadata, DataType, Scalar } from './metadata.js'
import { getCtr, getStrides } from './util.js'
import {
  useWasmForGzip,
  WasmDecodeError,
  wasmDecode,
  wasmEnabled,
} from './wasm/pool.js'

type ChunkMetadata<D extends DataType> = {
  dataType: D
  shape: number[]
  codecs: CodecMetadata[]
  fillValue: Scalar<D> | null
}

type CodecEntry = {
  fromConfig: (config: unknown, meta: ChunkMetadata<DataType>) => Codec
  kind?: 'array_to_array' | 'array_to_bytes' | 'bytes_to_bytes'
}

type Codec = _Codec & {
  kind: CodecEntry['kind']
  // Array-to-array codecs that change the data type (e.g. cast_value) must
  // implement this to describe the metadata after encoding. The pipeline
  // calls it so that subsequent codecs (especially bytes) see the correct type.
  getEncodedMeta?: (meta: ChunkMetadata<DataType>) => ChunkMetadata<DataType>
  // Maps a decoded byte size to the encoded byte size when that's a
  // deterministic function of the input. Used by sharding to compute the
  // shard-index suffix length without fetching the index first.
  computeEncodedSize?: (decodedSize: number) => number
}

function createDefaultRegistry(): Map<string, () => Promise<CodecEntry>> {
  // zarrita-wasm: numcodecs loaders live in their own module (see fallback.ts).
  const { blosc, lz4, zstd } = fallback
  const gzip = () => GzipCodec
  const zlib = () => ZlibCodec
  return (
    new Map()
      // v3 codecs
      .set('blosc', blosc)
      .set('lz4', lz4)
      .set('zstd', zstd)
      .set('gzip', gzip)
      .set('zlib', zlib)
      .set('transpose', () => TransposeCodec)
      .set('bytes', () => BytesCodec)
      .set('crc32c', () => Crc32cCodec)
      .set('vlen-utf8', () => VLenUTF8)
      .set('json2', () => JsonCodec)
      .set('bitround', () => BitroundCodec)
      .set('cast_value', () => CastValueCodec)
      .set('scale_offset', () => ScaleOffsetCodec)
      // numcodecs (v2 compat)
      .set('numcodecs.blosc', blosc)
      .set('numcodecs.lz4', lz4)
      .set('numcodecs.zstd', zstd)
      .set('numcodecs.gzip', gzip)
      .set('numcodecs.zlib', zlib)
      .set('numcodecs.vlen-utf8', () => VLenUTF8)
      .set('numcodecs.shuffle', () => ShuffleCodec)
      .set('numcodecs.delta', () => DeltaCodec)
      .set('numcodecs.bitround', () => BitroundCodec)
      .set('numcodecs.json2', () => JsonCodec)
  )
}

export const registry: Map<string, () => Promise<CodecEntry>> =
  createDefaultRegistry()

// Snapshot of the built-in codecs. The wasm path is only used for codecs whose
// registry entry is still the default, so user overrides keep working.
const DEFAULT_ENTRIES = new Map(registry)

/** Codecs the wasm core decodes, and the subset that does real work (compression). */
const WASM_CODECS = new Set([
  'bytes',
  'transpose',
  'crc32c',
  'numcodecs.shuffle',
  'numcodecs.delta',
  'gzip',
  'numcodecs.gzip',
  'zlib',
  'numcodecs.zlib',
  'zstd',
  'numcodecs.zstd',
  'blosc',
  'numcodecs.blosc',
])
const WASM_COMPRESSORS = new Set([
  'gzip',
  'numcodecs.gzip',
  'zlib',
  'numcodecs.zlib',
  'zstd',
  'numcodecs.zstd',
  'blosc',
  'numcodecs.blosc',
])
const WASM_DTYPES = new Set([
  'bool',
  'int8',
  'int16',
  'int32',
  'int64',
  'uint8',
  'uint16',
  'uint32',
  'uint64',
  'float16',
  'float32',
  'float64',
])

/**
 * If this pipeline can be decoded by the wasm core, return what it needs.
 * Pipelines without a compressor stay in JS: `bytes` alone is zero-copy there.
 */
export type WasmPlan<D extends DataType> = {
  TypedArray: ReturnType<typeof getCtr<D>>
  elemSize: number
  decodedSize: number
  spec: string
  /** Only gzip/zlib compression: the browser could decode it natively. */
  gzipOnly: boolean
}

const GZIP_CODECS = new Set([
  'gzip',
  'numcodecs.gzip',
  'zlib',
  'numcodecs.zlib',
])

const staticPlans = new WeakMap<object, WasmPlan<DataType> | null>()

function wasmPlan<D extends DataType>(
  meta: ChunkMetadata<D>,
): WasmPlan<D> | undefined {
  if (!wasmEnabled()) return undefined
  let cached = staticPlans.get(meta)
  if (cached === undefined) {
    cached = computeStaticPlan(meta) ?? null
    staticPlans.set(meta, cached)
  }
  if (cached === null) return undefined
  if (cached.gzipOnly && !useWasmForGzip()) return undefined
  // Checked on every call: a codec overridden in the registry wins.
  for (const c of meta.codecs) {
    if (registry.get(c.name) !== DEFAULT_ENTRIES.get(c.name)) return undefined
  }
  return cached as WasmPlan<D>
}

function computeStaticPlan<D extends DataType>(
  meta: ChunkMetadata<D>,
): WasmPlan<DataType> | undefined {
  if (!WASM_DTYPES.has(meta.dataType)) return undefined
  if (!meta.codecs.some((c) => WASM_COMPRESSORS.has(c.name))) return undefined
  if (!meta.codecs.every((c) => WASM_CODECS.has(c.name))) return undefined
  let TypedArray: ReturnType<typeof getCtr<D>>
  try {
    TypedArray = getCtr(meta.dataType)
  } catch {
    return undefined // e.g. float16 without Float16Array
  }
  if (!TypedArray) return undefined
  const size = meta.shape.reduce((a, b) => a * b, 1)
  const elemSize =
    'BYTES_PER_ELEMENT' in TypedArray
      ? (TypedArray.BYTES_PER_ELEMENT as number)
      : 1 // BoolArray
  return {
    TypedArray: TypedArray as unknown as WasmPlan<DataType>['TypedArray'],
    elemSize,
    decodedSize: size * elemSize,
    gzipOnly: meta.codecs
      .filter((c) => WASM_COMPRESSORS.has(c.name))
      .every((c) => GZIP_CODECS.has(c.name)),
    spec: JSON.stringify({
      data_type: meta.dataType,
      chunk_shape: meta.shape,
      codecs: meta.codecs,
    }),
  }
}

export function createCodecPipeline<Dtype extends DataType>(
  chunkMetadata: ChunkMetadata<Dtype>,
): {
  wasmPlan(): WasmPlan<Dtype> | undefined
  encode(chunk: Chunk<Dtype>): Promise<Uint8Array>
  decode(bytes: Uint8Array): Promise<Chunk<Dtype>>
  computeEncodedSize(decodedSize: number): Promise<number>
} {
  // Lazily load codecs on first use. The promise is shared by all methods.
  let codecsPromise: ReturnType<typeof loadCodecs<Dtype>> | undefined
  function getCodecs() {
    if (!codecsPromise) codecsPromise = loadCodecs(chunkMetadata)
    return codecsPromise
  }
  async function runStep<T>(
    direction: 'encode' | 'decode',
    codec: string,
    fn: () => Promise<T> | T,
  ): Promise<T> {
    try {
      return await fn()
    } catch (cause) {
      throw new CodecPipelineError({ direction, codec, cause })
    }
  }
  return {
    /** zarrita-wasm: the wasm decode plan for this pipeline, if it applies. */
    wasmPlan(): WasmPlan<Dtype> | undefined {
      return wasmPlan(chunkMetadata)
    },
    async encode(chunk: Chunk<Dtype>): Promise<Uint8Array> {
      const codecs = await getCodecs()
      for (const { name, codec } of codecs.arrayToArray) {
        chunk = await runStep('encode', name, () => codec.encode(chunk))
      }
      let bytes = await runStep('encode', codecs.arrayToBytes.name, () =>
        codecs.arrayToBytes.codec.encode(chunk),
      )
      for (const { name, codec } of codecs.bytesToBytes) {
        bytes = await runStep('encode', name, () => codec.encode(bytes))
      }
      return bytes
    },
    async decode(bytes: Uint8Array): Promise<Chunk<Dtype>> {
      const plan = wasmPlan(chunkMetadata)
      if (plan) {
        try {
          const { buffer, stride } = await wasmDecode(
            plan.spec,
            bytes,
            plan.decodedSize,
          )
          return {
            data: new plan.TypedArray(buffer) as Chunk<Dtype>['data'],
            shape: chunkMetadata.shape,
            stride: stride.length
              ? stride
              : getStrides(chunkMetadata.shape, 'C'),
          }
        } catch (err) {
          if (!(err instanceof WasmDecodeError)) throw err
          // A codec option the wasm core can't handle (e.g. blosc+snappy):
          // fall back to the JS codecs below.
          if (!/not supported|unsupported/i.test(err.message)) {
            const codec = err.message.match(/via codec "([^"]+)"/)?.[1]
            throw new CodecPipelineError({
              direction: 'decode',
              codec,
              cause: err,
            })
          }
        }
      }
      const codecs = await getCodecs()
      for (let i = codecs.bytesToBytes.length - 1; i >= 0; i--) {
        const { name, codec } = codecs.bytesToBytes[i]
        bytes = await runStep('decode', name, () => codec.decode(bytes))
      }
      let chunk = await runStep('decode', codecs.arrayToBytes.name, () =>
        codecs.arrayToBytes.codec.decode(bytes),
      )
      for (let i = codecs.arrayToArray.length - 1; i >= 0; i--) {
        const { name, codec } = codecs.arrayToArray[i]
        chunk = await runStep('decode', name, () => codec.decode(chunk))
      }
      return chunk
    },
    async computeEncodedSize(decodedSize: number): Promise<number> {
      const codecs = await getCodecs()
      let size = applyEncodedSize(
        codecs.arrayToBytes.name,
        codecs.arrayToBytes.codec,
        decodedSize,
      )
      for (const { name, codec } of codecs.bytesToBytes) {
        size = applyEncodedSize(name, codec, size)
      }
      return size
    },
  }
}

function applyEncodedSize(
  name: string,
  codec: { computeEncodedSize?: (n: number) => number },
  size: number,
): number {
  if (!codec.computeEncodedSize) {
    throw new InvalidMetadataError(
      `Codec "${name}" cannot compute its encoded size; it is not a fixed-size codec and cannot be used in a sharding index pipeline`,
    )
  }
  return codec.computeEncodedSize(size)
}

type ArrayToArrayCodec<D extends DataType> = {
  encode: (data: Chunk<D>) => Promise<Chunk<D>> | Chunk<D>
  decode: (data: Chunk<D>) => Promise<Chunk<D>> | Chunk<D>
}

type ArrayToBytesCodec<D extends DataType> = {
  encode: (data: Chunk<D>) => Promise<Uint8Array> | Uint8Array
  decode: (data: Uint8Array) => Promise<Chunk<D>> | Chunk<D>
  computeEncodedSize?: (decodedSize: number) => number
}

type BytesToBytesCodec = {
  encode: (data: Uint8Array) => Promise<Uint8Array>
  decode: (data: Uint8Array) => Promise<Uint8Array>
  computeEncodedSize?: (decodedSize: number) => number
}

type Named<T> = { name: string; codec: T }

async function loadCodecs<D extends DataType>(chunkMeta: ChunkMetadata<D>) {
  const promises = chunkMeta.codecs.map(async (meta) => {
    const Codec = await registry.get(meta.name)?.()
    if (!Codec) {
      throw new UnknownCodecError(meta.name)
    }
    return { Codec, meta }
  })
  const arrayToArray: Named<ArrayToArrayCodec<D>>[] = []
  let arrayToBytes: Named<ArrayToBytesCodec<D>> | undefined
  const bytesToBytes: Named<BytesToBytesCodec>[] = []
  // Track the "current" data type through the codec chain. Array-to-array
  // codecs like cast_value may change the type, and subsequent codecs
  // (especially bytes) need to see the updated type.
  let currentMeta = { ...chunkMeta }
  for await (const { Codec, meta } of promises) {
    const codec = Codec.fromConfig(meta.configuration, currentMeta)
    switch (codec.kind) {
      case 'array_to_array':
        arrayToArray.push({
          name: meta.name,
          codec: codec as unknown as ArrayToArrayCodec<D>,
        })
        // Array-to-array codecs like cast_value may change the data type
        // (and derived metadata like fill_value) between the array's
        // declared type and what's stored on disk. We call getEncodedMeta
        // so that subsequent codecs in the chain — especially the bytes
        // codec — see the correct on-disk type and fill value.
        if (codec.getEncodedMeta) {
          currentMeta = codec.getEncodedMeta(currentMeta) as ChunkMetadata<D>
        }
        break
      case 'array_to_bytes':
        arrayToBytes = {
          name: meta.name,
          codec: codec as unknown as ArrayToBytesCodec<D>,
        }
        break
      default:
        bytesToBytes.push({
          name: meta.name,
          codec: codec as unknown as BytesToBytesCodec,
        })
    }
  }
  if (!arrayToBytes) {
    if (!isTypedArrayLikeMeta(currentMeta)) {
      throw new InvalidMetadataError(
        `Cannot encode ${currentMeta.dataType} to bytes without a codec`,
      )
    }
    arrayToBytes = {
      name: 'bytes',
      codec: BytesCodec.fromConfig(
        { endian: 'little' },
        currentMeta,
      ) as unknown as ArrayToBytesCodec<D>,
    }
  }
  return {
    arrayToArray,
    arrayToBytes,
    bytesToBytes,
  }
}

function isTypedArrayLikeMeta<D extends DataType>(
  meta: ChunkMetadata<D>,
): meta is ChunkMetadata<Exclude<D, 'v2:object' | 'string'>> {
  return meta.dataType !== 'v2:object' && meta.dataType !== 'string'
}

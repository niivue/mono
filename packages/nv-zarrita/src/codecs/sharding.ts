import type { GetOptions, Readable } from '@zarrita/storage'
import { createCodecPipeline } from '../codecs.js'
import { UnsupportedError } from '../errors.js'
import type { Location } from '../hierarchy.js'
import type { Chunk } from '../metadata.js'
import type { ShardingCodecMetadata } from '../util.js'

const MAX_BIG_UINT = 18446744073709551615n

export function createShardedChunkGetter(
  location: Location<Readable>,
  shardShape: number[],
  encodeShardKey: (coord: number[]) => string,
  shardingConfig: ShardingCodecMetadata['configuration'],
) {
  if (!location.store.getRange) {
    throw new UnsupportedError('sharding requires a store with getRange')
  }
  const getRange = location.store.getRange.bind(location.store)
  const indexShape = shardShape.map((d, i) => d / shardingConfig.chunk_shape[i])
  const indexCodec = createCodecPipeline({
    dataType: 'uint64',
    shape: [...indexShape, 2],
    codecs: shardingConfig.index_codecs,
    fillValue: null,
  })

  // The shard index is a uint64 array with shape [...indexShape, 2]
  // (offset, length) per inner chunk. Its on-disk size depends on the
  // index_codecs pipeline — e.g. crc32c appends 4 bytes — so we ask the
  // pipeline rather than hardcoding any constant.
  const rawIndexSize = 16 * indexShape.reduce((a, b) => a * b, 1)
  const cache: Record<string, Promise<Chunk<'uint64'> | null>> = {}
  return async (chunkCoord: number[], options?: GetOptions) => {
    const shardCoord = chunkCoord.map((d, i) => Math.floor(d / indexShape[i]))
    const shardPath = location.resolve(encodeShardKey(shardCoord)).path

    if (!(shardPath in cache)) {
      cache[shardPath] = (async () => {
        const suffixLength = await indexCodec.computeEncodedSize(rawIndexSize)
        const bytes = await getRange(shardPath, { suffixLength }, options)
        return bytes ? await indexCodec.decode(bytes) : null
      })().catch((err) => {
        delete cache[shardPath]
        throw err
      })
    }
    const index = await cache[shardPath]

    if (index === null) {
      return undefined
    }

    const { data, shape, stride } = index
    const linearOffset = chunkCoord
      .map((d, i) => d % shape[i])
      .reduce((acc, sel, idx) => acc + sel * stride[idx], 0)

    const offset = data[linearOffset]
    const length = data[linearOffset + 1]
    // write null chunk when 2^64-1 indicates fill value
    if (offset === MAX_BIG_UINT && length === MAX_BIG_UINT) {
      return undefined
    }
    return getRange(
      shardPath,
      {
        offset: Number(offset),
        length: Number(length),
      },
      options,
    )
  }
}

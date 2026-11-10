// `zarrita-wasm/inline`: no numcodecs. When a blosc or zstd stage cannot go
// through the wasm fast path as a whole pipeline (for example compressed
// string arrays, whose vlen-utf8 stage runs in JS), these entries decode just
// that byte stage in wasm. Writing these codecs needs the main entry.
import { UnsupportedError } from '../errors.js'
import { wasmDecode } from '../wasm/pool.js'

function wasmBytesCodec(name) {
  return async () => ({
    fromConfig(configuration) {
      // A uint8 pipeline whose only real stage is this codec: the decoded
      // "chunk" is the decompressed bytes, whatever their length.
      const spec = JSON.stringify({
        data_type: 'uint8',
        chunk_shape: [1],
        codecs: [{ name, configuration: configuration ?? {} }],
      })
      return {
        kind: 'bytes_to_bytes',
        async decode(bytes) {
          const { buffer } = await wasmDecode(spec, bytes, 0)
          return new Uint8Array(buffer)
        },
        encode() {
          throw new UnsupportedError(
            `${name} encode (zarrita-wasm/inline decodes only; use the main zarrita-wasm entry to write)`,
          )
        },
      }
    },
  })
}

function unavailable(name) {
  return async () => {
    throw new UnsupportedError(`${name} codec (not in zarrita-wasm/inline)`)
  }
}

export const blosc = wasmBytesCodec('blosc')
export const zstd = wasmBytesCodec('zstd')
export const lz4 = unavailable('lz4')

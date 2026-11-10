// Thin wrapper over the zarrita-wasm decode core (crates/zarrita-wasm).
// Plain JS (no TypeScript) so the same file runs on the main thread and inside
// workers, from src/ or dist/, in browsers and in Node.

import { defaultWasmSource } from './assets.js'
import { planCopy, runCopy } from './copy.js'

const NODE_FS = 'node:fs/promises'
const textEncoder = new TextEncoder()
const textDecoder = new TextDecoder()

/** @type {Promise<WebAssembly.Module> | undefined} */
let modulePromise
/** True once the module has compiled (it may then be reused for free). */
let moduleReady = false

export function isModuleLoaded() {
  return moduleReady
}
/** @type {string | URL | undefined} */
let wasmUrlOverride

export function setWasmUrl(url) {
  wasmUrlOverride = url
  modulePromise = undefined
  moduleReady = false
}

/** Compile the wasm module once (it is then shared with every worker). */
export function loadModule() {
  if (!modulePromise) {
    modulePromise = (async () => {
      const src = wasmUrlOverride ?? (await defaultWasmSource())
      if (ArrayBuffer.isView(src) || src instanceof ArrayBuffer) {
        return WebAssembly.compile(src)
      }
      // Relative strings resolve against the page, like fetch() would.
      const u =
        typeof src === 'string' ? new URL(src, globalThis.location?.href) : src
      if (u.protocol === 'file:') {
        const fs = await import(/* @vite-ignore */ NODE_FS)
        return WebAssembly.compile(await fs.readFile(u))
      }
      const res = await fetch(u)
      if (!res.ok)
        throw new Error(`zarrita-wasm: failed to fetch ${u} (${res.status})`)
      if (
        WebAssembly.compileStreaming &&
        res.headers.get('content-type')?.includes('application/wasm')
      ) {
        return WebAssembly.compileStreaming(res)
      }
      const buf = await res.arrayBuffer()
      const magic = new Uint8Array(buf, 0, Math.min(4, buf.byteLength))
      if (magic.join() !== '0,97,115,109') {
        throw new Error(
          `zarrita-wasm: ${u} did not return a WebAssembly module ` +
            `(got ${res.headers.get('content-type') ?? 'unknown content'}). ` +
            "If you use Vite's dev server, add " +
            '`optimizeDeps: { exclude: ["zarrita-wasm"] }` to vite.config, ' +
            'or pass `configureWasm({ wasmUrl })`.',
        )
      }
      return WebAssembly.compile(buf)
    })()
    modulePromise.then(
      () => {
        moduleReady = true
      },
      () => {}, // the caller sees the error
    )
    modulePromise.catch(() => {
      modulePromise = undefined
    })
  }
  return modulePromise
}

export class WasmDecodeError extends Error {
  constructor(message) {
    super(message)
    this.name = 'WasmDecodeError'
  }
}

/** One wasm instance plus its cache of codec pipelines. Not thread-safe; one per thread. */
export class Decoder {
  /** @param {WebAssembly.Instance} instance */
  constructor(instance) {
    this.x = instance.exports
    /** @type {Map<string, number>} */
    this.handles = new Map()
  }

  static async create(module) {
    return new Decoder(
      await WebAssembly.instantiate(module ?? (await loadModule()), {}),
    )
  }

  #bytes() {
    return new Uint8Array(this.x.memory.buffer)
  }

  #error() {
    const p = this.x.zw_error_ptr()
    const n = this.x.zw_error_len()
    return textDecoder.decode(this.#bytes().slice(p, p + n))
  }

  #copyIn(src) {
    const ptr = this.x.zw_alloc(src.length)
    this.#bytes().set(src, ptr)
    return ptr
  }

  /** @param {string} spec JSON `{data_type, chunk_shape, codecs}` */
  #pipeline(spec) {
    let h = this.handles.get(spec)
    if (h === undefined) {
      const json = textEncoder.encode(spec)
      h = this.x.zw_pipeline_new(this.#copyIn(json), json.length)
      if (h === 0) throw new WasmDecodeError(this.#error())
      this.handles.set(spec, h)
    }
    return h
  }

  /**
   * Decode one chunk. Returns a fresh ArrayBuffer (safe to transfer) and the
   * chunk's element strides.
   * @param {string} spec
   * @param {Uint8Array} bytes
   * @returns {{ buffer: ArrayBuffer, stride: number[] }}
   */
  decode(spec, bytes) {
    const h = this.#pipeline(spec)
    const ptr = this.#copyIn(bytes)
    if (this.x.zw_decode(h, ptr, bytes.length) !== 1) {
      throw new WasmDecodeError(this.#error())
    }
    const rp = this.x.zw_result_ptr()
    const rn = this.x.zw_result_len()
    const sp = this.x.zw_stride_ptr()
    const sn = this.x.zw_stride_len()
    const mem = this.x.memory.buffer
    const buffer = mem.slice(rp, rp + rn)
    const stride = Array.from(new Uint32Array(mem, sp, sn))
    this.x.zw_result_clear()
    return { buffer, stride }
  }

  /**
   * Decode one chunk and copy the projected region straight from wasm memory
   * into `target.buffer` (typically a SharedArrayBuffer), skipping the
   * intermediate ArrayBuffer.
   * @param {string} spec
   * @param {Uint8Array} bytes
   * @param {{ buffer: ArrayBufferLike, byteOffset: number, elemSize: number, stride: number[], mapping: Array<{from: unknown, to: unknown}> }} target
   */
  decodeInto(spec, bytes, target) {
    const h = this.#pipeline(spec)
    const ptr = this.#copyIn(bytes)
    if (this.x.zw_decode(h, ptr, bytes.length) !== 1) {
      throw new WasmDecodeError(this.#error())
    }
    try {
      const rp = this.x.zw_result_ptr()
      const rn = this.x.zw_result_len()
      const sp = this.x.zw_stride_ptr()
      const sn = this.x.zw_stride_len()
      const mem = this.x.memory.buffer
      const stride = Array.from(new Uint32Array(mem, sp, sn))
      const plan = planCopy(target.stride, stride, target.mapping)
      if (plan === null) throw new WasmDecodeError('unsupported projection')
      runCopy(
        target.buffer,
        target.byteOffset,
        mem,
        rp,
        rn,
        target.elemSize,
        plan,
      )
    } finally {
      this.x.zw_result_clear()
    }
  }
}

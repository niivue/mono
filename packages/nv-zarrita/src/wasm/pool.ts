// Main-thread side of the wasm decode path: a lazily created pool of decode
// workers, plus a main-thread wasm instance for small chunks and for
// environments without workers.

import { defaultWorkerUrl } from './assets.js'
import {
  Decoder,
  type DecodeTarget,
  isModuleLoaded,
  loadModule,
  setWasmUrl,
  WasmDecodeError,
} from './core.js'

export { WasmDecodeError }

/** Options for the wasm decode path (an addition to the zarrita.js API). */
export interface WasmOptions {
  /** Turn the wasm path off entirely; zarrita.js's own codecs are used. Default true. */
  enabled?: boolean
  /** Decode workers. 0 decodes on the calling thread. Default: hardware threads, max 8. */
  workers?: number
  /** Chunks whose decoded size is below this many bytes decode on the calling thread. Default 64 KiB. */
  minWorkerBytes?: number
  /**
   * Return results backed by a SharedArrayBuffer by default (as if every
   * `get` passed `useSharedArrayBuffer: true`), so decode workers write
   * straight into the output. Needs a cross-origin isolated page in
   * browsers; ignored otherwise. Default false.
   */
  sharedOutput?: boolean
  /**
   * How to decode arrays whose only compressor is gzip or zlib, which the
   * browser can decode natively without downloading `zarrita.wasm`:
   * - `"auto"` (default): use wasm only if the module is already loaded
   *   (because another array needed it); otherwise use the built-in decoder.
   * - `"wasm"`: always use wasm (parallel decoding, needs the download).
   * - `"native"`: always use the built-in decoder, as zarrita.js does.
   */
  gzip?: 'auto' | 'wasm' | 'native'
  /**
   * Where to load `zarrita.wasm` from (e.g. a CDN), or the module's bytes.
   * Defaults to the file next to this module (embedded in `zarrita-wasm/inline`).
   */
  wasmUrl?: string | URL | Uint8Array | ArrayBuffer
  /** Where to load the worker script from. Defaults to next to this module. */
  workerUrl?: string | URL
}

type Job = {
  // biome-ignore lint/suspicious/noExplicitAny: decode and decodeInto share the job table
  resolve: (r: any) => void
  reject: (e: unknown) => void
}

interface PortLike {
  postMessage(msg: unknown, transfer?: Transferable[]): void
  terminate(): unknown
  // Node worker_threads only: whether this worker keeps the process alive.
  ref?(): void
  unref?(): void
}

const config: Required<Omit<WasmOptions, 'wasmUrl' | 'workerUrl'>> & {
  workerUrl?: string | URL
} = {
  enabled: true,
  sharedOutput: false,
  gzip: 'auto',
  workers: defaultWorkers(),
  minWorkerBytes: 64 * 1024,
}

function defaultWorkers(): number {
  let n = 4
  if (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) {
    n = navigator.hardwareConcurrency
  }
  return Math.max(1, Math.min(8, n))
}

const isNode =
  typeof process !== 'undefined' &&
  typeof (process as { versions?: { node?: string } }).versions?.node ===
    'string'

export function configureWasm(opts: WasmOptions): void {
  if (opts.wasmUrl !== undefined) {
    setWasmUrl(opts.wasmUrl)
    mainDecoder = undefined
    terminateWorkers()
  }
  if (opts.workerUrl !== undefined) config.workerUrl = opts.workerUrl
  if (opts.enabled !== undefined) config.enabled = opts.enabled
  if (opts.sharedOutput !== undefined) config.sharedOutput = opts.sharedOutput
  if (opts.gzip !== undefined) config.gzip = opts.gzip
  if (opts.minWorkerBytes !== undefined)
    config.minWorkerBytes = opts.minWorkerBytes
  if (opts.workers !== undefined && opts.workers !== config.workers) {
    config.workers = Math.max(0, opts.workers)
    terminateWorkers()
  }
}

export function wasmEnabled(): boolean {
  return config.enabled
}

/**
 * `x instanceof SharedArrayBuffer`, safe where SharedArrayBuffer is undefined
 * (browsers without cross-origin isolation).
 */
export function isSharedBuffer(x: unknown): x is SharedArrayBuffer {
  return (
    typeof SharedArrayBuffer !== 'undefined' && x instanceof SharedArrayBuffer
  )
}

/** Whether a gzip/zlib-only pipeline should use wasm right now. */
export function useWasmForGzip(): boolean {
  if (config.gzip === 'wasm') return true
  if (config.gzip === 'native') return false
  return isModuleLoaded()
}

/** SharedArrayBuffer usable here (Node, or a cross-origin isolated page). */
export function sharedMemoryAvailable(): boolean {
  if (typeof SharedArrayBuffer === 'undefined') return false
  if (isNode) return true
  return (
    (globalThis as { crossOriginIsolated?: boolean }).crossOriginIsolated ===
    true
  )
}

/** Whether `get` should default to shared output (configureWasm({ sharedOutput })). */
export function sharedOutputByDefault(): boolean {
  return config.enabled && config.sharedOutput && sharedMemoryAvailable()
}

// ---------------------------------------------------------------- main-thread decoder

let mainDecoder: Promise<Decoder> | undefined
function getMainDecoder(): Promise<Decoder> {
  if (!mainDecoder) {
    mainDecoder = Decoder.create()
    mainDecoder.catch(() => {
      mainDecoder = undefined
    })
  }
  return mainDecoder
}

// ---------------------------------------------------------------- worker pool

interface PoolWorker {
  port: PortLike
  inflight: number
}

let pool: Promise<PoolWorker[]> | undefined
let nextId = 1
const jobs = new Map<number, Job>()

function onMessage(
  w: PoolWorker,
  msg: {
    id: number
    ok: boolean
    buffer?: ArrayBuffer
    stride?: number[]
    error?: string
  },
) {
  w.inflight--
  if (w.inflight === 0) w.port.unref?.() // idle workers never keep Node alive
  const job = jobs.get(msg.id)
  if (!job) return
  jobs.delete(msg.id)
  if (msg.ok)
    job.resolve({
      buffer: msg.buffer as ArrayBuffer,
      stride: msg.stride as number[],
    })
  else job.reject(new WasmDecodeError(msg.error ?? 'unknown error'))
}

async function spawn(module: WebAssembly.Module): Promise<PoolWorker> {
  const url = config.workerUrl ?? defaultWorkerUrl()
  if (!url) throw new Error('zarrita-wasm: no worker script in this build')
  let w: PoolWorker
  if (isNode) {
    const spec = 'node:worker_threads'
    const { Worker } = await import(/* @vite-ignore */ spec)
    const nw = new Worker(url)
    w = { port: nw, inflight: 0 }
    nw.on('message', (m: Parameters<typeof onMessage>[1]) => onMessage(w, m))
    nw.on('error', (e: unknown) => failAll(e))
    nw.unref() // after the listeners, which would otherwise re-ref it
  } else {
    const bw = new Worker(url, { type: 'module' })
    w = { port: bw, inflight: 0 }
    bw.onmessage = (e) => onMessage(w, e.data)
    bw.onerror = (e) => failAll(e)
  }
  w.port.postMessage({ type: 'init', module })
  return w
}

function failAll(e: unknown) {
  for (const job of jobs.values()) job.reject(e)
  jobs.clear()
  terminateWorkers()
}

function getPool(): Promise<PoolWorker[]> {
  if (!pool) {
    const n = config.workers
    pool = loadModule().then((m) =>
      Promise.all(Array.from({ length: n }, () => spawn(m))),
    )
    pool.catch(() => {
      pool = undefined
    })
  }
  return pool
}

function terminateWorkers() {
  const p = pool
  pool = undefined
  p?.then((ws) => {
    for (const w of ws) w.port.terminate()
  }).catch(() => {})
}

const canUseWorkers = (): boolean =>
  config.workers > 0 &&
  (config.workerUrl !== undefined || defaultWorkerUrl() !== undefined) &&
  (isNode || typeof Worker !== 'undefined')

/**
 * Decode one chunk with the wasm codec pipeline described by `spec`.
 * Large chunks go to the worker pool; small ones decode on this thread.
 */
export async function wasmDecode(
  spec: string,
  bytes: Uint8Array,
  decodedSize: number,
): Promise<{ buffer: ArrayBuffer; stride: number[] }> {
  if (decodedSize < config.minWorkerBytes || !canUseWorkers()) {
    return (await getMainDecoder()).decode(spec, bytes)
  }
  const workers = await getPool()
  let w = workers[0]
  for (const c of workers) if (c.inflight < w.inflight) w = c
  // Copy so the caller's buffer (which a cache may hold) is never detached.
  const copy = bytes.slice()
  const id = nextId++
  if (w.inflight++ === 0) w.port.ref?.() // busy workers keep Node alive until done
  return new Promise((resolve, reject) => {
    jobs.set(id, { resolve, reject })
    w.port.postMessage({ type: 'decode', id, spec, bytes: copy.buffer }, [
      copy.buffer,
    ])
  })
}

/**
 * Decode one chunk and write its projected region directly into
 * `target.buffer` (a SharedArrayBuffer for worker decodes).
 */
export async function wasmDecodeInto(
  spec: string,
  bytes: Uint8Array,
  decodedSize: number,
  target: DecodeTarget,
): Promise<void> {
  if (
    decodedSize < config.minWorkerBytes ||
    !canUseWorkers() ||
    !isSharedBuffer(target.buffer)
  ) {
    ;(await getMainDecoder()).decodeInto(spec, bytes, target)
    return
  }
  const workers = await getPool()
  let w = workers[0]
  for (const c of workers) if (c.inflight < w.inflight) w = c
  const copy = bytes.slice()
  const id = nextId++
  if (w.inflight++ === 0) w.port.ref?.()
  return new Promise((resolve, reject) => {
    jobs.set(id, { resolve, reject })
    w.port.postMessage(
      { type: 'decodeInto', id, spec, bytes: copy.buffer, target },
      [copy.buffer],
    )
  })
}

/** Stop all decode workers (they restart on demand). */
export function terminateWasmWorkers(): void {
  terminateWorkers()
}

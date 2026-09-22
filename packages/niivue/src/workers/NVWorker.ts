/**
 * Generic Web Worker bridge.
 *
 * Wraps a single Worker instance with a promise-based API, automatic
 * message-ID tracking, transferable support, and graceful teardown.
 *
 * Usage:
 *   import { NVWorker } from '@/workers/NVWorker'
 *   import MyWorker from '@/workers/myOp.worker?worker'
 *
 *   const worker = new NVWorker(() => new MyWorker())
 *   const result = await worker.execute<ResultType>({ key: 'value' }, [buf])
 *   worker.terminate()
 */

/** Internal message-ID key injected into every outgoing payload. */
const ID_KEY = '_wbId'
/** Internal error key returned by workers on failure. */
const ERR_KEY = '_wbError'
/**
 * Set by a worker that ran correctly but whose *payload* failed — a bad file, a
 * 404, an unparsable header. Callers use it to tell "this worker is unusable"
 * (retry elsewhere) from "this input is bad" (retrying changes nothing).
 */
const ERR_NAME_KEY = '_wbErrorName'

interface Pending<T> {
  resolve: (value: T) => void
  reject: (reason: Error) => void
}

export class NVWorker {
  private worker: Worker | null = null
  private readonly pending = new Map<number, Pending<unknown>>()
  private nextId = 0

  /**
   * @param createWorker Factory that returns a new Worker instance.
   *   Called lazily on the first `execute()`.
   */
  constructor(private readonly createWorker: () => Worker) {}

  /** Whether the current environment supports Web Workers. */
  static isSupported(): boolean {
    return typeof Worker !== 'undefined'
  }

  /**
   * Send a task to the worker and return a promise for the result.
   *
   * @param payload  Arbitrary data forwarded to the worker via `postMessage`.
   *                 A unique `_wbId` is injected automatically.
   * @param transfer Optional list of `Transferable` objects (e.g. ArrayBuffers)
   *                 for zero-copy transfer.
   */
  execute<T>(
    payload: Record<string, unknown>,
    transfer: Transferable[] = [],
  ): Promise<T> {
    const worker = this.getOrCreate()
    const id = this.nextId++
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: resolve as (v: unknown) => void,
        reject,
      })
      worker.postMessage({ ...payload, [ID_KEY]: id }, transfer)
    })
  }

  /**
   * Send a message that expects no reply. Use it for out-of-band signals about
   * work already in flight — a cancellation, say — where waiting for a
   * response would defeat the point. The worker is created if it does not
   * exist yet, so a notify that arrives before any `execute` is not lost.
   */
  notify(payload: Record<string, unknown>): void {
    this.getOrCreate().postMessage(payload)
  }

  /** Terminate the worker and reject all outstanding promises. */
  terminate(): void {
    if (this.worker) {
      this.worker.terminate()
      this.worker = null
    }
    for (const { reject } of this.pending.values()) {
      reject(new Error('Worker terminated'))
    }
    this.pending.clear()
  }

  // ---------------------------------------------------------------------------
  // Internal
  // ---------------------------------------------------------------------------

  private getOrCreate(): Worker {
    if (!this.worker) {
      this.worker = this.createWorker()
      this.worker.onmessage = (e: MessageEvent) => this.onMessage(e)
      this.worker.onerror = (e: ErrorEvent) => this.onError(e)
    }
    return this.worker
  }

  private onMessage(e: MessageEvent): void {
    const {
      [ID_KEY]: id,
      [ERR_KEY]: error,
      [ERR_NAME_KEY]: errorName,
      ...result
    } = e.data
    const entry = this.pending.get(id)
    if (!entry) return
    this.pending.delete(id)
    if (error) {
      const err = new Error(error)
      // Preserved so a caller can decide whether a retry is worth anything.
      if (typeof errorName === 'string') err.name = errorName
      entry.reject(err)
    } else {
      entry.resolve(result)
    }
  }

  private onError(e: ErrorEvent): void {
    // Unhandled worker error — reject all pending promises
    const err = new Error(e.message ?? 'Worker error')
    for (const { reject } of this.pending.values()) {
      reject(err)
    }
    this.pending.clear()
  }
}

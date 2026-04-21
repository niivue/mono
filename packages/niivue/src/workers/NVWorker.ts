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
const ID_KEY = "_wbId"
/** Internal error key returned by workers on failure. */
const ERR_KEY = "_wbError"

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
    return typeof Worker !== "undefined"
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

  /** Terminate the worker and reject all outstanding promises. */
  terminate(): void {
    if (this.worker) {
      this.worker.terminate()
      this.worker = null
    }
    for (const { reject } of this.pending.values()) {
      reject(new Error("Worker terminated"))
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
    const { [ID_KEY]: id, [ERR_KEY]: error, ...result } = e.data
    const entry = this.pending.get(id)
    if (!entry) return
    this.pending.delete(id)
    if (error) {
      entry.reject(new Error(error))
    } else {
      entry.resolve(result)
    }
  }

  private onError(e: ErrorEvent): void {
    // Unhandled worker error — reject all pending promises
    const err = new Error(e.message ?? "Worker error")
    for (const { reject } of this.pending.values()) {
      reject(err)
    }
    this.pending.clear()
  }
}

import { NVWorker } from './NVWorker'

// Page-wide workers (volume load, transforms) are shared by every NiiVue. Each
// ends once no attached instance holds it and it has no task in flight, so a
// host that tears every viewer down (an OHIF mode exit) frees them; the next
// task recreates it.
let holders = 0
const pageWorkers = new Set<PageWorker>()

export class PageWorker {
  private bridge: NVWorker | null = null
  private inFlight = 0

  constructor(private readonly createWorker: () => Worker) {
    pageWorkers.add(this)
  }

  async execute<T>(
    payload: Record<string, unknown>,
    transfer: Transferable[] = [],
  ): Promise<T> {
    this.bridge ??= new NVWorker(this.createWorker)
    this.inFlight++
    try {
      return await this.bridge.execute<T>(payload, transfer)
    } finally {
      this.inFlight--
      this.terminateIfUnused()
    }
  }

  terminateIfUnused(): void {
    if (holders > 0 || this.inFlight > 0 || !this.bridge) return
    this.bridge.terminate()
    this.bridge = null
  }
}

export function retainPageWorkers(): void {
  holders++
}

export function releasePageWorkers(): void {
  holders--
  for (const worker of pageWorkers) worker.terminateIfUnused()
}

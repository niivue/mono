/** What a benchmark run needs from either backend's view. */
export interface BenchView {
  boundsWidth: number
  boundsHeight: number
  resize(): void
}

/** How long a bench run waits for a busy view before giving up. */
const MAX_WAIT_FRAMES = 300

/**
 * Single-flight run shared by the WebGL2 (`gl/bench.ts`) and WebGPU
 * (`wgpu/bench.ts`) bench harnesses: refuses a concurrent call, sizes an
 * unsized view and waits until it is ready before rendering.
 */
export class BenchGuard {
  private inProgress = false
  // Set by the harness's destroy(). Checked after the wait so a bench call
  // that was mid-await when the view tore down its bench exits cleanly rather
  // than allocating orphan GPU resources on a disposed view.
  disposed = false

  constructor(
    private view: BenchView,
    private isReady: () => boolean,
    private notReadyMessage: string,
  ) {}

  async run(name: string, render: () => void | Promise<void>): Promise<void> {
    if (this.disposed) return
    if (this.inProgress) {
      throw new Error(`${name}: concurrent call not allowed`)
    }
    this.inProgress = true
    try {
      const view = this.view
      if (view.boundsWidth === 0 || view.boundsHeight === 0) view.resize()
      for (let i = 0; !this.isReady() && i < MAX_WAIT_FRAMES; i++) {
        await new Promise<void>((r) => requestAnimationFrame(() => r()))
      }
      if (!this.isReady()) throw new Error(this.notReadyMessage)
      if (this.disposed) return
      await render()
    } finally {
      this.inProgress = false
    }
  }
}

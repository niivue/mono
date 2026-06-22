// Preview tiles and the selected volume share one HTTP/1.1 origin, so the
// browser's ~6-connection-per-origin limit is split between them. A gridful of
// eager preview <img> loads can fill every connection and stall the volume
// fetch (priority hints only reorder the queue; they can't preempt in-flight
// connections). This limiter caps how many preview requests are in flight at
// once, leaving connections free for the high-priority volume fetch and its
// refinement levels. Previews still all load — just a few at a time.

const MAX_CONCURRENT_PREVIEW_LOADS = 3

let activeLoads = 0
const waiters: Array<() => void> = []

/**
 * Acquire a preview-load slot. Resolves with a release function once a slot is
 * free. The caller MUST call release exactly once when its load settles (load,
 * error, replacement, or unmount); calling it more than once is a safe no-op.
 */
export function acquirePreviewSlot(): Promise<() => void> {
  return new Promise((resolve) => {
    const grant = (): void => {
      activeLoads += 1
      let released = false
      resolve(() => {
        if (released) return
        released = true
        activeLoads -= 1
        const next = waiters.shift()
        if (next) next()
      })
    }

    if (activeLoads < MAX_CONCURRENT_PREVIEW_LOADS) {
      grant()
    } else {
      waiters.push(grant)
    }
  })
}

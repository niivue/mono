/// <reference types="vite/client" />

declare module '*.wgsl?raw' {
  const code: string
  export default code
}

interface Navigator {
  gpu?: GPU
}

/**
 * Build-time flag injected by Vite's `define`. `true` only when the
 * build was started with `NIIVUE_PERF=1` (see package.json `*:perf`
 * scripts). All `performance.mark`/`measure` instrumentation in
 * `NVPerfMarks.ts` is gated on this constant so production bundles
 * dead-code-eliminate the bodies entirely.
 */
declare const __NIIVUE_PERF__: boolean

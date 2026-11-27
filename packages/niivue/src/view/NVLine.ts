import type { LineData } from '@niivue/uikit'

// The line record and builder are uikit's (`buildLine`, `LineData`); this is
// the builder signature core's overlay code takes.
export type BuildLineFn = (
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  thickness: number,
  color: number[],
) => LineData

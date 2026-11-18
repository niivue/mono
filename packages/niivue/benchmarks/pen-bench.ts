// CPU micro-benchmark of the voxel pen and shape fills (no GPU, no DOM).
// Usage: bun packages/niivue/benchmarks/pen-bench.ts
// Reports the median of 31 runs (after 5 warm-up runs) per case on a 256x256x160 bitmap; stroke cases
// paint a 200-step axial drag. Run on main and on a branch to compare.

import * as pen from '../src/drawing/penTool'
import { PEN_SHAPE } from '../src/NVConstants'

const dims = [3, 256, 256, 160]
const bitmap = new Uint8Array(256 * 256 * 160)

function median(fn: () => void): number {
  const t: number[] = []
  for (let i = 0; i < 5; i++) fn() // JIT warm-up
  for (let i = 0; i < 31; i++) {
    bitmap.fill(0)
    const t0 = performance.now()
    fn()
    t.push(performance.now() - t0)
  }
  return t.sort((a, b) => a - b)[15]
}

// `reps` strokes per sample lift sub-ms cases above timer noise.
const stroke = (penSize: number, penShape: PEN_SHAPE, extra = {}, reps = 1) =>
  median(() => {
    for (let r = 0; r < reps; r++)
      pen.drawLine({
        ptA: [28, 28, 80],
        ptB: [228, 128, 80],
        penValue: 1,
        drawBitmap: bitmap,
        dims,
        penSize,
        penShape,
        penAxCorSag: 0,
        penOverwrites: true,
        ...extra,
      })
  })

const rows: [string, number][] = [
  ['2D stroke size 1 (x1000)', stroke(1, PEN_SHAPE.RECTANGLE, {}, 1000)],
  ['2D stroke size 9 square (x100)', stroke(9, PEN_SHAPE.RECTANGLE, {}, 100)],
  ['2D stroke size 9 circle (x100)', stroke(9, PEN_SHAPE.CIRCLE, {}, 100)],
  ['2D stroke size 49 circle (x10)', stroke(49, PEN_SHAPE.CIRCLE, {}, 10)],
  // The 3D-render pen (drawSphereSegment): 200 radius-10 voxel stamps.
  [
    'drawSphere r 10 vox x200',
    median(() => {
      for (let i = 0; i < 200; i++)
        pen.drawSphere({
          ...{ x: 28 + i, y: 28 + (i >> 1), z: 80, radius: 10 },
          ...{ penValue: 1, drawBitmap: bitmap, dims, penOverwrites: true },
        })
    }),
  ],
]
// The ball pen and fills exist only after the 3D pen change.
const P = PEN_SHAPE as unknown as Record<string, number>
const fill = (pen as Record<string, unknown>).drawShapeFill as
  | ((p: object) => void)
  | undefined
if (P.SPHERE !== undefined && fill) {
  const iso = { pixDims: [3, 1, 1, 1] }
  const aniso = { pixDims: [3, 0.5, 0.5, 3] }
  rows.push(
    ['ball stroke r 5 mm, 1 mm iso', stroke(10, P.SPHERE, iso)],
    ['ball stroke r 25 mm, 1 mm iso', stroke(50, P.SPHERE, iso)],
    ['ball stroke r 25 mm, 0.5x0.5x3 mm', stroke(100, P.SPHERE, aniso)],
  )
  const shape = (shape: number, b: number[], pixDims: number[]) =>
    median(() =>
      fill({
        shape,
        a: [128, 128, 80],
        b,
        sliceType: 0,
        penValue: 1,
        drawBitmap: bitmap,
        dims,
        pixDims,
        penOverwrites: true,
      }),
    )
  rows.push(
    ['circle fill r 50 mm', shape(P.CIRCLE, [178, 128, 80], [3, 1, 1, 1])],
    [
      'rectangle fill 100x100 mm',
      shape(P.RECTANGLE, [228, 228, 80], [3, 1, 1, 1]),
    ],
    ['sphere fill r 50 mm', shape(P.SPHERE, [178, 128, 80], [3, 1, 1, 1])],
  )
}
for (const [name, ms] of rows)
  console.log(`${name.padEnd(36)} ${ms.toFixed(3)} ms`)

import { describe, expect, it } from 'bun:test'
import type { RulerSpec } from '@niivue/uikit'
import { createRulerSync, rulerSpecFor } from './wsiSlideView'

function spec(
  a: [number, number],
  b: [number, number],
  dpr = 1,
  length = 2.5,
): RulerSpec {
  return { a, b, length, units: 'mm', decimals: 2, sizePx: 28 * dpr }
}

function setup() {
  const calls: string[] = []
  const reports: (string | null)[] = []
  const sync = createRulerSync(
    {
      setRuler: (s) => calls.push(`set ${s.a} ${s.b} ${s.sizePx}`),
      clear: () => calls.push('clear'),
    },
    (text) => reports.push(text),
  )
  return { sync, calls, reports }
}

describe('createRulerSync', () => {
  it('does not repeat setRuler/onMeasure for an identical frame', () => {
    const { sync, calls, reports } = setup()
    sync(spec([0, 0], [10, 0]), '2.50 mm')
    sync(spec([0, 0], [10, 0]), '2.50 mm')
    expect(calls).toEqual(['set 0,0 10,0 28'])
    expect(reports).toEqual(['2.50 mm'])
  })

  it('updates on pan/zoom (device endpoints) and on DPR', () => {
    const { sync, calls, reports } = setup()
    sync(spec([0, 0], [10, 0]), '2.50 mm')
    sync(spec([5, 5], [15, 5]), '2.50 mm')
    sync(spec([10, 10], [30, 10], 2), '2.50 mm')
    expect(calls).toEqual([
      'set 0,0 10,0 28',
      'set 5,5 15,5 28',
      'set 10,10 30,10 56',
    ])
    // The length did not change, so the host readout is not repeated.
    expect(reports).toEqual(['2.50 mm'])
  })

  it('updates the readout when new endpoints change the value', () => {
    const { sync, reports } = setup()
    sync(spec([0, 0], [10, 0]), '2.50 mm')
    sync(spec([0, 0], [20, 0], 1, 5), '5.00 mm')
    expect(reports).toEqual(['2.50 mm', '5.00 mm'])
  })

  it('clears once and re-pushes a recreated identical ruler', () => {
    const { sync, calls, reports } = setup()
    sync(null)
    sync(spec([0, 0], [10, 0]), '2.50 mm')
    sync(null)
    sync(null)
    sync(spec([0, 0], [10, 0]), '2.50 mm')
    expect(calls).toEqual(['set 0,0 10,0 28', 'clear', 'set 0,0 10,0 28'])
    expect(reports).toEqual(['2.50 mm', null, '2.50 mm'])
  })
})

describe('rulerSpecFor', () => {
  const slide = (spacing?: [number, number]) =>
    ({
      manifest: { pixelSpacingMM: spacing },
      slideToScreen: (x: number, y: number) => ({ xCss: x / 10, yCss: y / 10 }),
    }) as unknown as Parameters<typeof rulerSpecFor>[0]
  const at = (x: number, y = 0) => ({
    start: { x: 0, y: 0 },
    end: { x, y },
  })
  const screen = { widthCss: 100, heightCss: 100, devicePixelRatio: 2 }

  it('measures as before: px, um below 1 mm, mm with ticks', () => {
    expect(rulerSpecFor(slide(), at(30, 40), screen).text).toBe('50 px')
    expect(rulerSpecFor(slide([0.00025, 0.00025]), at(400), screen).text).toBe(
      '100 um',
    )
    const mm = rulerSpecFor(slide([0.00025, 0.00025]), at(10000), screen)
    expect(mm.text).toBe('2.50 mm')
    expect(mm.spec.showTicks).toBe(true)
  })

  it('places device-pixel endpoints and sizes at the pixel ratio', () => {
    const { spec } = rulerSpecFor(slide(), at(100, 50), screen)
    expect([spec.a, spec.b]).toEqual([
      [0, 0],
      [20, 10],
    ])
    expect([spec.sizePx, spec.thickness, spec.tickLength]).toEqual([56, 4, 12])
  })
})

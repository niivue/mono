import { describe, expect, it } from 'bun:test'
import type { RulerSpec } from '@niivue/uikit'
import { createRulerSync } from './wsiSlideView'

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

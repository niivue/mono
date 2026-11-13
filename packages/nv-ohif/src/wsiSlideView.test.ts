import { describe, expect, it } from 'bun:test'
import { keepOneRuler } from './wsiSlideView'

describe('keepOneRuler', () => {
  it('keeps only the last finished ruler', () => {
    const ctl = { measurements: ['a', 'b', 'c'], activeMeasurement: null }
    keepOneRuler(ctl)
    expect(ctl.measurements).toEqual(['c'])
  })

  it('clears the kept ruler while a new one is dragged', () => {
    const ctl = { measurements: ['a'], activeMeasurement: {} }
    keepOneRuler(ctl)
    expect(ctl.measurements).toEqual([])
  })

  it('leaves no rulers as none', () => {
    const ctl = { measurements: [], activeMeasurement: null }
    keepOneRuler(ctl)
    expect(ctl.measurements).toEqual([])
  })
})

import { describe, expect, it } from 'bun:test'

import { SPOKEN_NAMES } from './names'

describe('SPOKEN_NAMES', () => {
  it('has every AAL region, each sided one on both sides', () => {
    const labels = Object.keys(SPOKEN_NAMES)
    expect(labels).toHaveLength(116)
    expect(labels.filter((label) => label.startsWith('Vermis_'))).toHaveLength(
      8,
    )
    for (const label of labels) {
      const name = SPOKEN_NAMES[label]
      expect(name, label).not.toContain('_')
      if (label.endsWith('_L')) {
        expect(name, label).toMatch(/^left /)
        expect(SPOKEN_NAMES[label.replace(/_L$/, '_R')], label).toBe(
          name.replace(/^left /, 'right '),
        )
      } else if (label.endsWith('_R')) {
        expect(name, label).toMatch(/^right /)
      } else {
        expect(label, label).toMatch(/^Vermis_/)
        expect(name, label).toMatch(/^vermis, /)
      }
    }
  })
})

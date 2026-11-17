import { expect, it } from 'bun:test'
import { isMip } from './hangingOptions'

// The 4D demo's PT panes say MIP without a slab: cornerstone shows a slice.
it('isMip needs a full-volume slab', () => {
  expect(isMip([{ options: { blendMode: 'MIP' } }])).toBe(false)
  expect(
    isMip([{ options: { blendMode: 'MIP', slabThickness: 'fullVolume' } }]),
  ).toBe(true)
})

import { expect, test } from 'bun:test'
import { mockReactHooks } from './mockReact'

// One component's state across renders, as React keeps it.
const slots: unknown[] = []
let at = 0
mockReactHooks({
  useState: <T>(init?: T) => {
    const i = at++
    if (!(i in slots)) slots[i] = init
    return [slots[i], (v: T) => (slots[i] = v)]
  },
})
const { useLoadedFor } = await import('./NiivueViewport')
const render = (key: string) => {
  at = 0
  return useLoadedFor(key)
}

// A loaded MR pane switched to a SEG: the SEG's first render (before its load
// effect resets the flag) must not read as loaded, or the hydrate prompt shows
// over the outgoing base.
test('a new hang is not loaded until its own load finishes', () => {
  const [, setMr] = render('MR')
  setMr(true)
  expect(render('MR')[0]).toBe(true)
  const [onSeg, setSeg] = render('SEG')
  expect(onSeg).toBe(false)
  setSeg(true)
  expect(render('SEG')[0]).toBe(true)
})

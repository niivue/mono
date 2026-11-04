import { describe, expect, it } from 'bun:test'
import type { UIKitOverlayFrame } from '@niivue/niivue'
import { UIKitDrawBundle, UIKitEntryMap } from './overlayParts'
import type { UIKitFont } from './text/font'

// Empty geometry makes every primitive return before touching the backend.
const FONT = { metrics: {}, image: {} } as unknown as UIKitFont
const frame = (dpr = 1) => ({ dpr }) as unknown as UIKitOverlayFrame

describe('UIKitDrawBundle', () => {
  it('rebuilds only when invalidated or forced', () => {
    let redraws = 0
    let builds = 0
    const bundle = new UIKitDrawBundle(FONT, () => redraws++)
    const build = () => {
      builds++
      return []
    }
    bundle.draw(frame(), build)
    bundle.draw(frame(), build)
    expect(builds).toBe(1)
    bundle.invalidate()
    expect(redraws).toBe(1)
    bundle.draw(frame(), build)
    bundle.draw(frame(), build, true)
    expect(builds).toBe(3)
    bundle.destroy()
  })

  it('routes redraws to the layer unless the options supplied one', () => {
    let layer = 0
    const bound = new UIKitDrawBundle(FONT)
    bound.bind({ requestRedraw: () => layer++ })
    bound.invalidate()
    expect(layer).toBe(1)
    const own = new UIKitDrawBundle(FONT, () => {})
    own.bind({ requestRedraw: () => layer++ })
    own.invalidate()
    expect(layer).toBe(1)
  })
})

interface Entry {
  spec: { id: string; enabled?: boolean }
  layout: { x: number } | null
}

describe('UIKitEntryMap', () => {
  const make = (cssUnits: boolean) => {
    const map = new UIKitEntryMap<{ x: number }, Entry>(
      (e, scale) => ({ x: Number(e.spec.id) * scale }),
      cssUnits,
    )
    for (const id of ['1', '2', '3'])
      map.set(id, { spec: { id }, layout: null })
    return map
  }

  it('drops layouts only when the cssUnits scale changes', () => {
    const plain = make(false)
    expect(plain.rescale(2)).toBe(false)
    const css = make(true)
    const e = css.get('2') as Entry
    expect(css.layoutOf(e)).toEqual({ x: 2 })
    expect(css.rescale(2)).toBe(true)
    expect(e.layout).toBeNull()
    expect(css.layoutOf(e)).toEqual({ x: 4 })
    expect(css.rescale(2)).toBe(false)
  })

  it('hit-tests topmost first, skipping disabled entries', () => {
    const map = make(false)
    const all = () => true
    expect(map.topmost(all, 0, 0)?.spec.id).toBe('3')
    ;(map.get('3') as Entry).spec.enabled = false
    expect(map.topmost(all, 0, 0)?.spec.id).toBe('2')
    expect(map.enabled('3')).toBeUndefined()
    expect(map.enabled(null)).toBeUndefined()
  })

  it('replaces the id set, removing before adding', () => {
    const map = make(false)
    const log: string[] = []
    map.replaceAll(
      [{ id: '3' }, { id: '4' }],
      (s) => log.push(`add ${s.id}`),
      (id) => log.push(`remove ${id}`),
    )
    expect(log).toEqual(['remove 1', 'remove 2', 'add 3', 'add 4'])
  })
})

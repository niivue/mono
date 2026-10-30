import { afterEach, describe, expect, test } from 'bun:test'
import { effectiveDevicePixelRatio } from './devicePixelRatio'

const g = globalThis as { window?: { devicePixelRatio?: number } }

describe('effectiveDevicePixelRatio', () => {
  afterEach(() => {
    delete g.window
  })

  test('a forced ratio above 0 wins', () => {
    g.window = { devicePixelRatio: 2 }
    expect(effectiveDevicePixelRatio(3)).toBe(3)
  })

  test('auto (-1, 0 or omitted) uses the window ratio', () => {
    g.window = { devicePixelRatio: 2 }
    expect(effectiveDevicePixelRatio(-1)).toBe(2)
    expect(effectiveDevicePixelRatio(0)).toBe(2)
    expect(effectiveDevicePixelRatio()).toBe(2)
  })

  test('falls back to 1 without a window ratio or a window', () => {
    g.window = {}
    expect(effectiveDevicePixelRatio()).toBe(1)
    delete g.window
    expect(effectiveDevicePixelRatio()).toBe(1)
  })
})

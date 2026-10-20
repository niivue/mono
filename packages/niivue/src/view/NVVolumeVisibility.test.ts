import { describe, expect, test } from 'bun:test'
import { drawnOpacity, isVolumeDrawn } from './NVVolumeVisibility'

// The overlay bake, the 2D/3D background opacity uniforms and both depth
// picks go through these: a volume that is not drawn must not be picked
// either, and hiding must leave `opacity` alone.
describe('isVolumeDrawn', () => {
  test('a volume with neither field set is drawn', () => {
    expect(isVolumeDrawn({})).toBe(true)
  })

  test('visible: false hides it whatever the opacity', () => {
    expect(isVolumeDrawn({ visible: false })).toBe(false)
    expect(isVolumeDrawn({ visible: false, opacity: 1 })).toBe(false)
  })

  test('zero opacity hides it whatever the flag', () => {
    expect(isVolumeDrawn({ opacity: 0 })).toBe(false)
    expect(isVolumeDrawn({ opacity: 0, visible: true })).toBe(false)
  })

  test('any positive opacity with the flag unset or true is drawn', () => {
    expect(isVolumeDrawn({ opacity: 0.01 })).toBe(true)
    expect(isVolumeDrawn({ opacity: 1, visible: true })).toBe(true)
  })
})

describe('drawnOpacity', () => {
  test('is the volume opacity when shown, defaulting to 1', () => {
    expect(drawnOpacity({})).toBe(1)
    expect(drawnOpacity({ opacity: 0.5 })).toBe(0.5)
    expect(drawnOpacity({ opacity: 0.5, visible: true })).toBe(0.5)
  })

  test('is 0 when hidden, without touching the stored opacity', () => {
    const vol = { opacity: 0.5, visible: false }
    expect(drawnOpacity(vol)).toBe(0)
    expect(vol.opacity).toBe(0.5)
  })
})

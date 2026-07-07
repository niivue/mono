import { describe, expect, test } from 'bun:test'
import { settingEquals, sparsifyGroup } from './documentSettings'

describe('settingEquals', () => {
  test('primitives', () => {
    expect(settingEquals(1, 1)).toBe(true)
    expect(settingEquals(1, 2)).toBe(false)
    expect(settingEquals('a', 'a')).toBe(true)
    expect(settingEquals(true, false)).toBe(false)
    expect(settingEquals(null, undefined)).toBe(false)
  })

  test('arrays and typed arrays', () => {
    expect(settingEquals([0.5, 0.5, 0.5], [0.5, 0.5, 0.5])).toBe(true)
    expect(settingEquals([0.5, 0.5, 0.5], [0.5, 0.6, 0.5])).toBe(false)
    expect(settingEquals([1, 2], [1, 2, 3])).toBe(false)
    expect(settingEquals(new Float32Array([1, 2]), [1, 2])).toBe(true)
  })

  test('nested plain objects', () => {
    expect(settingEquals({ a: 1, b: [1, 2] }, { a: 1, b: [1, 2] })).toBe(true)
    expect(settingEquals({ a: 1 }, { a: 1, b: 2 })).toBe(false)
    expect(settingEquals({ a: 1 }, { a: 2 })).toBe(false)
  })
})

describe('sparsifyGroup', () => {
  const defaults = {
    azimuth: 110,
    elevation: 10,
    crosshairPos: [0.5, 0.5, 0.5],
  }

  test('omits keys equal to the default', () => {
    const current = {
      azimuth: 110,
      elevation: 10,
      crosshairPos: [0.5, 0.5, 0.5],
    }
    expect(sparsifyGroup('scene', current, defaults)).toEqual({})
  })

  test('keeps keys that differ from the default', () => {
    const current = {
      azimuth: 200,
      elevation: 10,
      crosshairPos: [0.1, 0.2, 0.3],
    }
    expect(sparsifyGroup('scene', current, defaults)).toEqual({
      azimuth: 200,
      crosshairPos: [0.1, 0.2, 0.3],
    })
  })

  test('neverSave drops a non-default dotted key', () => {
    const current = {
      azimuth: 200,
      elevation: 10,
      crosshairPos: [0.1, 0.2, 0.3],
    }
    const out = sparsifyGroup('scene', current, defaults, {
      neverSave: ['scene.crosshairPos'],
    })
    expect(out).toEqual({ azimuth: 200 })
  })

  test('neverSave drops the whole group', () => {
    const current = { azimuth: 200, elevation: 99, crosshairPos: [0, 0, 0] }
    expect(
      sparsifyGroup('scene', current, defaults, { neverSave: ['scene'] }),
    ).toEqual({})
  })

  test('alwaysSave forces a default-valued key', () => {
    const current = {
      azimuth: 110,
      elevation: 10,
      crosshairPos: [0.5, 0.5, 0.5],
    }
    const out = sparsifyGroup('scene', current, defaults, {
      alwaysSave: ['scene.azimuth'],
    })
    expect(out).toEqual({ azimuth: 110 })
  })

  test('neverSave wins over alwaysSave', () => {
    const current = {
      azimuth: 200,
      elevation: 10,
      crosshairPos: [0.5, 0.5, 0.5],
    }
    const out = sparsifyGroup('scene', current, defaults, {
      alwaysSave: ['scene.azimuth'],
      neverSave: ['scene.azimuth'],
    })
    expect(out).toEqual({})
  })

  test('alwaysSave for the whole group keeps every key', () => {
    const current = {
      azimuth: 110,
      elevation: 10,
      crosshairPos: [0.5, 0.5, 0.5],
    }
    const out = sparsifyGroup('scene', current, defaults, {
      alwaysSave: ['scene'],
    })
    expect(out).toEqual(current)
  })
})

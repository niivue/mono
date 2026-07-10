import { describe, expect, test } from 'bun:test'
import {
  fillGroup,
  fillModeFor,
  settingEquals,
  sparsifyGroup,
} from './documentSettings'

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

  test('a plain object with a numeric `length` key is compared by key, not index', () => {
    // Duck-typing on `length` would compare these two by index — every index is
    // undefined on both, so they would wrongly compare equal despite `a` differing.
    expect(settingEquals({ length: 2, a: 1 }, { length: 2, a: 2 })).toBe(false)
    expect(settingEquals({ length: 2, a: 1 }, { length: 2, a: 1 })).toBe(true)
    // A real sequence is never equal to an object that merely looks like one.
    expect(settingEquals([1, 2], { length: 2, 0: 1, 1: 2 })).toBe(false)
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

describe('fillModeFor', () => {
  test('undefined policy => default', () => {
    expect(fillModeFor('scene', 'azimuth', undefined)).toBe('default')
  })

  test('a single string applies to every setting', () => {
    expect(fillModeFor('scene', 'azimuth', 'current')).toBe('current')
    expect(fillModeFor('ui', 'crosshairWidth', 'current')).toBe('current')
  })

  test('dotted key beats group entry beats default', () => {
    const p = { scene: 'current' as const, 'scene.azimuth': 'default' as const }
    expect(fillModeFor('scene', 'azimuth', p)).toBe('default') // dotted wins
    expect(fillModeFor('scene', 'elevation', p)).toBe('current') // group
    expect(fillModeFor('ui', 'crosshairWidth', p)).toBe('default') // unlisted
  })
})

describe('fillGroup', () => {
  const defaults = {
    azimuth: 110,
    elevation: 10,
    crosshairPos: [0.5, 0.5, 0.5],
  }
  const current = { azimuth: 200, elevation: 20, crosshairPos: [0.1, 0.2, 0.3] }

  test('a value the document specifies always wins', () => {
    const out = fillGroup(
      'scene',
      current,
      defaults,
      { azimuth: 300 },
      'current',
    )
    expect(out.azimuth).toBe(300)
  })

  test('omitted settings reset to default by default', () => {
    const out = fillGroup(
      'scene',
      current,
      defaults,
      { azimuth: 300 },
      undefined,
    )
    expect(out).toEqual({
      azimuth: 300,
      elevation: 10,
      crosshairPos: [0.5, 0.5, 0.5],
    })
  })

  test("'current' keeps the instance value for omitted settings", () => {
    const out = fillGroup(
      'scene',
      current,
      defaults,
      { azimuth: 300 },
      'current',
    )
    expect(out).toEqual({
      azimuth: 300,
      elevation: 20,
      crosshairPos: [0.1, 0.2, 0.3],
    })
  })

  test('per-key policy: keep one, reset the rest', () => {
    const out = fillGroup('scene', current, defaults, undefined, {
      'scene.crosshairPos': 'current',
    })
    expect(out).toEqual({
      azimuth: 110,
      elevation: 10,
      crosshairPos: [0.1, 0.2, 0.3],
    })
  })

  test('default-filled arrays are cloned, not aliased to the constant', () => {
    const out = fillGroup('scene', current, defaults, undefined, undefined)
    expect(out.crosshairPos).toEqual([0.5, 0.5, 0.5])
    expect(out.crosshairPos).not.toBe(defaults.crosshairPos)
  })

  test('an absent doc group with default fill yields full defaults', () => {
    expect(fillGroup('scene', current, defaults, undefined, undefined)).toEqual(
      defaults,
    )
  })
})

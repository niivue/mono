import { describe, expect, it } from 'bun:test'

import {
  coerceSetting,
  DRAG_MODES,
  findSetting,
  OVERLAY_ALPHA_BLENDS,
  OVERLAY_COLOR_BLENDS,
  readSetting,
  SETTINGS,
  type Setting,
  settingChoices,
} from './settings'

const named = (name: string): Setting => {
  const setting = findSetting(name)
  if (!setting) throw new Error(`no setting ${name}`)
  return setting
}

describe('the settings table', () => {
  it('names each setting once, with a kind and a description', () => {
    const names = SETTINGS.map((s) => s.name)
    expect(new Set(names).size).toBe(names.length)
    for (const setting of SETTINGS) {
      expect(setting.description.length).toBeGreaterThan(0)
      if (setting.kind === 'enum' || setting.kind === 'choice')
        expect(settingChoices(setting).length).toBeGreaterThan(0)
    }
    expect(findSetting('nope')).toBeUndefined()
    expect(findSetting('crosshairWidth')?.kind).toBe('number')
  })

  it('takes a switch as a boolean or its word', () => {
    const setting = named('annotationIsEnabled')
    expect(coerceSetting(setting, true)).toBe(true)
    expect(coerceSetting(setting, 'false')).toBe(false)
    expect(() => coerceSetting(setting, 'yes')).toThrow(
      'annotationIsEnabled must be true or false.',
    )
  })

  it('keeps a number within its bounds and an integer whole', () => {
    const width = named('crosshairWidth')
    expect(coerceSetting(width, '2.5')).toBe(2.5)
    expect(() => coerceSetting(width, -1)).toThrow(
      'crosshairWidth must be at least 0.',
    )
    expect(() => coerceSetting(width, 'wide')).toThrow(
      'crosshairWidth must be a number.',
    )
    expect(() => coerceSetting(width, '')).toThrow('must be a number')
    const label = named('annotationActiveLabel')
    expect(coerceSetting(label, 3)).toBe(3)
    expect(() => coerceSetting(label, 1.5)).toThrow(
      'annotationActiveLabel must be a whole number.',
    )
  })

  it('fills a colour out to four channels and refuses one out of range', () => {
    const setting = named('backgroundColor')
    expect(coerceSetting(setting, [0, 0.5, 1])).toEqual([0, 0.5, 1, 1])
    expect(coerceSetting(setting, ['1', '1', '1', '0.5'])).toEqual([
      1, 1, 1, 0.5,
    ])
    expect(() => coerceSetting(setting, [2, 0, 0])).toThrow(
      'backgroundColor must be a colour',
    )
    expect(() => coerceSetting(setting, 'red')).toThrow('must be a colour')
    const perAxis = named('crosshairColorPerAxis')
    expect(
      coerceSetting(perAxis, [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 1, 0.5],
      ]),
    ).toEqual([
      [1, 0, 0, 1],
      [0, 1, 0, 1],
      [0, 0, 1, 0.5],
    ])
    expect(() => coerceSetting(perAxis, [1, 0, 0])).toThrow(
      'crosshairColorPerAxis must be a colour',
    )
  })

  it('turns an enum name into NiiVue number and back', () => {
    const setting = named('primaryDragMode')
    expect(coerceSetting(setting, 'pan')).toBe(DRAG_MODES.pan)
    expect(coerceSetting(setting, 3)).toBe(3)
    expect(coerceSetting(setting, '3')).toBe(3)
    expect(() => coerceSetting(setting, 'fly')).toThrow(
      `primaryDragMode must be one of ${Object.keys(DRAG_MODES).join(', ')}.`,
    )
    expect(() => coerceSetting(setting, 99)).toThrow('must be one of')
    expect(readSetting(setting, 3)).toBe('pan')
    expect(readSetting(setting, 99)).toBe(99)
    expect(settingChoices(setting)).toEqual(Object.keys(DRAG_MODES))
  })

  it('names the overlay blend modes as NiiVue numbers them', () => {
    const alpha = named('volumeOverlayAlphaBlend')
    expect(settingChoices(alpha)).toEqual(['max', 'additive', 'over'])
    expect(coerceSetting(alpha, 'additive')).toBe(OVERLAY_ALPHA_BLENDS.additive)
    expect(readSetting(alpha, 2)).toBe('over')
    expect(() => coerceSetting(alpha, 'screen')).toThrow(
      'volumeOverlayAlphaBlend must be one of max, additive, over.',
    )
    const colour = named('volumeOverlayColorBlend')
    expect(settingChoices(colour)).toEqual(['additive', 'mean'])
    expect(coerceSetting(colour, 'mean')).toBe(OVERLAY_COLOR_BLENDS.mean)
    expect(readSetting(colour, 0)).toBe('additive')
  })

  it('takes a choice only as one of its words', () => {
    const setting = named('wheelZoomAnchor')
    expect(coerceSetting(setting, 'pointer')).toBe('pointer')
    expect(() => coerceSetting(setting, 'mouse')).toThrow(
      'wheelZoomAnchor must be one of crosshair, pointer.',
    )
    expect(settingChoices(setting)).toEqual(['crosshair', 'pointer'])
  })

  it('takes text as text', () => {
    const setting = named('placeholderText')
    expect(coerceSetting(setting, 'Drop a file')).toBe('Drop a file')
    expect(() => coerceSetting(setting, 5)).toThrow(
      'placeholderText must be text.',
    )
  })

  it('takes a vector as exactly its length of numbers, and mm or null', () => {
    const vec3: Setting = { name: 'v', kind: 'vec3', description: '' }
    expect(coerceSetting(vec3, [1, '2', 3])).toEqual([1, 2, 3])
    expect(() => coerceSetting(vec3, [1, 2])).toThrow('v must be 3 numbers.')
    const mm: Setting = { name: 'm', kind: 'mm-or-null', description: '' }
    expect(coerceSetting(mm, null)).toBeNull()
    expect(coerceSetting(mm, [1, 2, 3])).toEqual([1, 2, 3])
    expect(() => coerceSetting(mm, [1])).toThrow(
      'm must be three numbers in millimetres, or null.',
    )
  })

  it('reads a typed array as plain numbers', () => {
    const setting = named('backgroundColor')
    expect(readSetting(setting, new Float32Array([0, 0.5, 1, 1]))).toEqual([
      0, 0.5, 1, 1,
    ])
    const perAxis = named('crosshairColorPerAxis')
    expect(
      readSetting(perAxis, [new Float32Array([1, 0, 0, 1]), [0, 1, 0, 1]]),
    ).toEqual([
      [1, 0, 0, 1],
      [0, 1, 0, 1],
    ])
    expect(readSetting(named('crosshairWidth'), 2)).toBe(2)
  })
})

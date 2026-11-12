import { expect, test } from 'bun:test'
import NiiVue from '@/index'
import { captureWarnings } from '@/testing/headless'

test('rulerUnits: option, setter and change event; an unknown unit is ignored', () => {
  const nv = new NiiVue({ backend: 'webgl2', rulerUnits: 'um' })
  expect(nv.rulerUnits).toBe('um')
  const changes: unknown[] = []
  nv.addEventListener('change', (e) => changes.push(e.detail))
  nv.rulerUnits = 'cm'
  const warnings = captureWarnings()
  try {
    Reflect.set(nv, 'rulerUnits', 'furlong')
  } finally {
    warnings.restore()
  }
  expect(nv.rulerUnits).toBe('cm')
  expect(changes).toEqual([{ property: 'rulerUnits', value: 'cm' }])
  expect(warnings.messages.join()).toContain('furlong')
})

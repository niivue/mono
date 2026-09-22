import { describe, expect, test } from 'bun:test'
import { isMeshDrawn } from './NVMeshVisibility'

// Both the render and the depth pick filter meshes through this: a mesh that
// is not drawn must not answer a double-click either.
describe('isMeshDrawn', () => {
  test('a mesh with neither field set is drawn', () => {
    expect(isMeshDrawn({})).toBe(true)
  })

  test('visible: false hides it whatever the opacity', () => {
    expect(isMeshDrawn({ visible: false })).toBe(false)
    expect(isMeshDrawn({ visible: false, opacity: 1 })).toBe(false)
  })

  test('zero opacity hides it whatever the visibility', () => {
    expect(isMeshDrawn({ opacity: 0 })).toBe(false)
    expect(isMeshDrawn({ opacity: 0, visible: true })).toBe(false)
  })

  test('any positive opacity with visible unset or true is drawn', () => {
    expect(isMeshDrawn({ opacity: 0.01 })).toBe(true)
    expect(isMeshDrawn({ opacity: 1, visible: true })).toBe(true)
  })
})

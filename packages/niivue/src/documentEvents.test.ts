import { describe, expect, test } from 'bun:test'
import {
  changePropertyName,
  type SettingsSnapshot,
  settingsChangeEvents,
  snapshotSettings,
} from './documentEvents'

const empty = (): SettingsSnapshot => ({
  scene: {},
  layout: {},
  ui: {},
  volume: {},
  mesh: {},
  draw: {},
  interaction: {},
  annotation: {},
})

describe('changePropertyName', () => {
  test('scene, layout, ui and interaction keys are unprefixed', () => {
    expect(changePropertyName('scene', 'azimuth')).toBe('azimuth')
    expect(changePropertyName('layout', 'isRadiological')).toBe(
      'isRadiological',
    )
    expect(changePropertyName('ui', 'crosshairWidth')).toBe('crosshairWidth')
    expect(changePropertyName('interaction', 'primaryDragMode')).toBe(
      'primaryDragMode',
    )
  })

  test('volume, mesh, draw and annotation keys are prefixed by their group', () => {
    expect(changePropertyName('volume', 'matcap')).toBe('volumeMatcap')
    expect(changePropertyName('mesh', 'xRay')).toBe('meshXRay')
    expect(changePropertyName('draw', 'penValue')).toBe('drawPenValue')
    expect(changePropertyName('annotation', 'isEnabled')).toBe(
      'annotationIsEnabled',
    )
  })

  test('layout.margin is the tileMargin setter', () => {
    expect(changePropertyName('layout', 'margin')).toBe('tileMargin')
  })
})

describe('settingsChangeEvents', () => {
  test('reports a changed key under its setter name with the new value', () => {
    const before = empty()
    const after = empty()
    before.layout.isRadiological = false
    after.layout.isRadiological = true
    before.volume.matcap = ''
    after.volume.matcap = 'cortex'
    expect(settingsChangeEvents(before, after)).toEqual([
      { property: 'isRadiological', value: true },
      { property: 'volumeMatcap', value: 'cortex' },
    ])
  })

  test('an unchanged key yields nothing', () => {
    const before = empty()
    const after = empty()
    before.ui.crosshairWidth = 1
    after.ui.crosshairWidth = 1
    expect(settingsChangeEvents(before, after)).toEqual([])
  })

  test('array values compare by content, not identity', () => {
    const before = empty()
    const after = empty()
    before.scene.crosshairPos = [0.5, 0.5, 0.5]
    after.scene.crosshairPos = [0.5, 0.5, 0.5]
    before.ui.crosshairColor = [1, 0, 0, 1]
    after.ui.crosshairColor = [0, 1, 0, 1]
    expect(settingsChangeEvents(before, after)).toEqual([
      { property: 'crosshairColor', value: [0, 1, 0, 1] },
    ])
  })

  test('a nested ui.graph key is named like its graph* setter', () => {
    const before = empty()
    const after = empty()
    before.ui.graph = { lineWidth: 1, lineAlpha: 1 }
    after.ui.graph = { lineWidth: 2, lineAlpha: 1 }
    expect(settingsChangeEvents(before, after)).toEqual([
      { property: 'graphLineWidth', value: 2 },
    ])
  })

  test('a key present on only one side is a change', () => {
    const before = empty()
    const after = empty()
    after.draw.penValue = 3
    expect(settingsChangeEvents(before, after)).toEqual([
      { property: 'drawPenValue', value: 3 },
    ])
  })
})

describe('snapshotSettings', () => {
  test('copies typed arrays and nested objects so later mutation is invisible', () => {
    const model = {
      scene: { crosshairPos: new Float32Array([0.25, 0.5, 0.75]) },
      layout: {},
      ui: { graph: { lineWidth: 1 } },
      volume: {},
      mesh: {},
      draw: {},
      interaction: {},
      annotation: {},
    }
    const snap = snapshotSettings(model)
    model.scene.crosshairPos[0] = 0.9
    model.ui.graph.lineWidth = 5
    expect(snap.scene.crosshairPos).toEqual([0.25, 0.5, 0.75])
    expect(snap.ui.graph).toEqual({ lineWidth: 1 })
  })
})

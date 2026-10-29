import { describe, expect, test } from 'bun:test'
import { upgradeLegendFlags } from './documentLegend'

type Doc = Parameters<typeof upgradeLegendFlags>[0]

describe('upgradeLegendFlags', () => {
  test('drops the never-honoured v10 flags and renames the signal one', () => {
    const doc: Doc = {
      version: 10,
      volumes: [{ isLegendVisible: false }],
      meshes: [{ isLegendVisible: false }],
      signals: [{ display: { showLegend: false } }],
    }
    upgradeLegendFlags(doc)
    expect(doc).toEqual({
      version: 10,
      volumes: [{}],
      meshes: [{}],
      signals: [{ display: { isLegendVisible: false } }],
    })
  })

  test('tolerates a signal without display options', () => {
    const doc: Doc = { version: 10, signals: [{}] }
    upgradeLegendFlags(doc)
    expect(doc.signals).toEqual([{}])
  })

  test('leaves a v11 document alone', () => {
    const doc = {
      version: 11,
      volumes: [{ isLegendVisible: false }],
      meshes: [{ isLegendVisible: false }],
    }
    upgradeLegendFlags(doc)
    expect(doc.volumes[0].isLegendVisible).toBe(false)
    expect(doc.meshes[0].isLegendVisible).toBe(false)
  })
})

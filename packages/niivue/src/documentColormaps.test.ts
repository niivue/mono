import { describe, expect, test } from 'bun:test'
import { labelLutToColormap, upgradeColormaps } from './documentColormaps'

// A v9 compiled label LUT: IDs 2..4, RGBA per ID, ID 3 unlisted (transparent).
const legacyLut = {
  lut: new Uint8Array([10, 20, 30, 255, 0, 0, 0, 0, 40, 50, 60, 255]),
  min: 2,
  max: 4,
  labels: ['left', '?', 'right'],
}

describe('labelLutToColormap', () => {
  test('rebuildsOneEntryPerId', () => {
    const cm = labelLutToColormap(legacyLut)
    expect(cm.I).toEqual([2, 3, 4])
    expect(cm.R).toEqual([10, 0, 40])
    expect(cm.A).toEqual([255, 0, 255])
    expect(cm.labels).toEqual(['left', '?', 'right'])
  })

  test('isALabelColormapEvenWithoutNames', () => {
    const cm = labelLutToColormap({ ...legacyLut, labels: undefined })
    expect(cm.labels).toEqual([])
  })
})

describe('upgradeColormaps', () => {
  test('turnsAnEmbeddedLabelLutIntoANamedDocumentColormap', () => {
    const doc = {
      version: 9,
      volumes: [
        { name: 'aparc.nii.gz', colormap: 'gray', colormapLabel: legacyLut },
      ],
    }
    upgradeColormaps(doc)
    const [vol] = doc.volumes
    expect(vol.colormap).toBe('Aparc labels')
    expect(vol.colormapLabel).toBeUndefined()
    expect(doc).toHaveProperty(['colormaps', 'Aparc labels', 'I'], [2, 3, 4])
  })

  test('givesEachVolumeItsOwnName', () => {
    const doc: Parameters<typeof upgradeColormaps>[0] = {
      version: 9,
      volumes: [
        { name: 'atlas.nii', colormapLabel: legacyLut },
        { name: 'atlas.nii', colormapLabel: legacyLut },
      ],
    }
    upgradeColormaps(doc)
    expect(doc.volumes?.map((v) => v.colormap)).toEqual([
      'Atlas labels',
      'Atlas labels 2',
    ])
  })

  test('doesNotReplaceAColormapAlreadyRegistered', () => {
    const doc: Parameters<typeof upgradeColormaps>[0] = {
      version: 9,
      volumes: [{ name: 'seg.nii.gz', colormapLabel: legacyLut }],
    }
    upgradeColormaps(doc, (name) => name === 'Seg labels')
    expect(doc.volumes?.[0].colormap).toBe('Seg labels 2')
  })

  test('dropsTheUnderscoreFromDrawingColormapNames', () => {
    const doc = {
      version: 9,
      draw: { colormap: '_itksnap' },
      volumes: [{ name: 'seg', colormap: '_slicer3d' }],
    }
    upgradeColormaps(doc)
    expect(doc.draw.colormap).toBe('Itksnap')
    expect(doc.volumes[0].colormap).toBe('Slicer3d')
    expect(doc).not.toHaveProperty('colormaps')
  })

  test('leavesAV10DocumentAlone', () => {
    const doc = {
      version: 10,
      volumes: [{ name: 'seg', colormap: '_draw', colormapLabel: legacyLut }],
    }
    upgradeColormaps(doc)
    expect(doc.volumes[0].colormap).toBe('_draw')
  })
})

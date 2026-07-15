import { describe, expect, test } from 'bun:test'
import { convertLegacyDocument, type LegacyDocument } from './documentLegacy'
import { NVD_DOCUMENT_VERSION } from './NVConstants'

const LEGACY: LegacyDocument = {
  sceneData: {
    azimuth: 110,
    elevation: 10,
    crosshairPos: [0.5, 0.5, 0.6],
    volScaleMultiplier: 1.43,
    clipPlane: [1, 0, 0, -0.05],
  },
  opts: {
    backColor: [0, 0, 0, 1],
    crosshairColor: [1, 0, 0, 1],
    isColorbar: true,
    isRadiologicalConvention: true,
    isNearestInterpolation: true,
    penValue: 3,
    dragMode: 2,
    someUnknownOpt: 42,
  },
  imageOptionsArray: [
    {
      url: '../images/mni152.nii.gz',
      name: 'mni152',
      colormap: 'gray',
      opacity: 1,
    },
    { name: 'no-url-vol', colormap: 'hot' },
  ],
  encodedImageBlobs: ['XAEA...', 'YWER...'],
  meshesString: JSON.stringify([
    { url: 'brain.mz3', name: 'brain', opacity: 0.5 },
  ]),
  encodedDrawingBlob: null,
}

describe('convertLegacyDocument', () => {
  const { doc, warnings } = convertLegacyDocument(
    LEGACY,
    '2026-07-08T00:00:00Z',
  )

  test('stamps the current version + created', () => {
    expect(doc.version).toBe(NVD_DOCUMENT_VERSION)
    expect(doc.created).toBe('2026-07-08T00:00:00Z')
  })

  test('maps sceneData to scene (volScaleMultiplier -> scaleMultiplier)', () => {
    expect(doc.scene.azimuth).toBe(110)
    expect(doc.scene.crosshairPos).toEqual([0.5, 0.5, 0.6])
    expect(doc.scene.scaleMultiplier).toBe(1.43)
  })

  test('maps opts into the right groups (and colors onto scene)', () => {
    expect(doc.scene.backgroundColor).toEqual([0, 0, 0, 1])
    expect(doc.ui.crosshairColor).toEqual([1, 0, 0, 1])
    expect(doc.ui.isColorbarVisible).toBe(true)
    expect(doc.layout.isRadiological).toBe(true)
    expect(doc.volume.isNearestInterpolation).toBe(true)
    expect(doc.draw.penValue).toBe(3)
    expect(doc.interaction.primaryDragMode).toBe(2)
  })

  test('links volumes by URL and skips URL-less ones (with a warning)', () => {
    expect(doc.volumes.length).toBe(1)
    expect(doc.volumes[0]).toEqual({
      url: '../images/mni152.nii.gz',
      name: 'mni152',
      colormap: 'gray',
      opacity: 1,
    })
    expect(doc.volumes[0].data).toBeUndefined() // linked, not embedded
    expect(warnings.some((w) => w.includes('no-url-vol'))).toBe(true)
  })

  test('links meshes by URL', () => {
    expect(doc.meshes).toEqual([
      { url: 'brain.mz3', name: 'brain', opacity: 0.5 },
    ])
  })

  test('reports unmapped opts + the clip plane', () => {
    expect(warnings.some((w) => w.includes('someUnknownOpt'))).toBe(true)
    expect(warnings.some((w) => w.includes('clipPlane'))).toBe(true)
  })
})

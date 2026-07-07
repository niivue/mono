import { describe, expect, test } from 'bun:test'

import { selectUrlMeshLayers } from './documentMeshLayers'
import type { NVDocumentMeshLayer } from './NVDocument'

/**
 * Guards the fix for URL-referenced document meshes dropping their scalar
 * overlay layers: `reconstructMesh` now forwards URL-backed layers to addMesh
 * via selectUrlMeshLayers.
 */
describe('selectUrlMeshLayers', () => {
  test('keeps URL-referenced layers so overlays are reloaded', () => {
    const layers: NVDocumentMeshLayer[] = [
      { url: 'lh.curv', colormap: 'gray', calMin: -1, calMax: 1, opacity: 1 },
    ]
    expect(selectUrlMeshLayers(layers)).toEqual([
      { url: 'lh.curv', colormap: 'gray', calMin: -1, calMax: 1, opacity: 1 },
    ])
  })

  test('drops layers without a URL (cannot be fetched on the URL path)', () => {
    const layers: NVDocumentMeshLayer[] = [
      { url: 'lh.curv', colormap: 'gray' },
      { colormap: 'hot' }, // embedded-only, no URL
    ]
    expect(selectUrlMeshLayers(layers)).toEqual([
      { url: 'lh.curv', colormap: 'gray' },
    ])
  })

  test('returns undefined for a layerless mesh', () => {
    expect(selectUrlMeshLayers(undefined)).toBeUndefined()
  })

  test('returns an empty array when every layer lacks a URL', () => {
    const layers: NVDocumentMeshLayer[] = [{ colormap: 'hot' }]
    expect(selectUrlMeshLayers(layers)).toEqual([])
  })
})

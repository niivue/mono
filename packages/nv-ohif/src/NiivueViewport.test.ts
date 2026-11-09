import { expect, test } from 'bun:test'
import NiiVue from '@niivue/niivue'
import { DEFAULT_OPTIONS } from './NiivueViewport'

test('the viewport snaps the crosshair to voxel centres', () => {
  // So a measurement drawn at a clicked depth lies on a DICOM frame (frameAt).
  expect(new NiiVue(DEFAULT_OPTIONS).isSnapToVoxelCenters).toBe(true)
})

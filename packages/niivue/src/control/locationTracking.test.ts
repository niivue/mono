import { describe, expect, test } from 'bun:test'
import type { vec3 } from 'gl-matrix'
import type { NVImage } from '@/NVTypes'
import { buildLocationMessage, type LocationContext } from './locationTracking'

describe('buildLocationMessage', () => {
  test('a crosshair off the volume reads no drawing label from a wrapped index', () => {
    // 4 x 4 x 1 drawing; voxel (5, 1, 0) is off the volume but would wrap to 9.
    const img = new Uint8Array(16)
    img[9] = 3
    const volume = {
      name: 'v',
      hdr: { intent_code: 0, datatypeCode: 2 },
      dimsRAS: [3, 4, 4, 1],
      matRAS: new Float32Array([
        1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1,
      ]),
    } as unknown as NVImage
    const at = (vox: number[]): LocationContext => ({
      volumes: [volume],
      meshes: [],
      model: {
        sceneExtentsMinMax: () =>
          [
            [0, 0, 0],
            [4, 4, 1],
            [4, 4, 1],
          ] as vec3[] as [vec3, vec3, vec3],
        scene2mm: () => [0, 0, 0] as unknown as vec3,
        scene2vox: () => vox as unknown as vec3,
        scene: { crosshairPos: [0, 0, 0] as unknown as vec3 },
        drawingVolume: { img } as unknown as NVImage,
        draw: { colormap: '_none_' },
      },
      _drawLut: null,
      lastPointerX: 0,
      lastPointerY: 0,
    })
    expect(buildLocationMessage(at([1, 2, 0]), 0)?.string).toContain('draw:3')
    expect(buildLocationMessage(at([5, 1, 0]), 0)?.string).not.toContain('draw')
  })
})

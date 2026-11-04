import { expect, test } from 'bun:test'
import { VolumeRenderer as GLRenderer } from '@/gl/render'
import type { NVImage } from '@/NVTypes'
import { VolumeRenderer as GPURenderer } from '@/wgpu/render'

// Mirrors are asked for the base's chunk indices and capped by its plan
// (chunkIndicesForAllBudgets), so one carrying its own grid would be priced
// and indexed against the wrong chunks.
for (const [name, Renderer] of [
  ['gl', GLRenderer],
  ['wgpu', GPURenderer],
] as const) {
  test(`${name}: a combined overlay is streamed on the base's chunk plan`, async () => {
    const basePlan = { gridDims: [4, 1, 1] }
    const ownPlan = { gridDims: [2, 1, 1] }
    const base = { chunkPlan: basePlan } as unknown as NVImage
    const overlay = { chunkPlan: ownPlan } as unknown as NVImage
    const plansSeen: unknown[] = []
    const entry = {
      manager: { setBudgetBytes() {} },
      decoded: { setMaxBytes() {} },
      sourceBytesPerVoxel: 1,
    }
    const self = {
      _chunkResidencyBytes: 1000,
      _activeChunked: null,
      _combinedOverlayEntries: [],
      _invalidateBindGroupCache() {},
      async _ensureChunkedVolumeEntry(_dev: unknown, vol: NVImage) {
        plansSeen.push(vol.chunkPlan)
        return entry
      },
    }
    const update = (
      Renderer.prototype as unknown as {
        _updateCombinedOverlayChunked: (
          dev: unknown,
          vols: NVImage[],
          volumes: NVImage[],
        ) => Promise<void>
      }
    )._updateCombinedOverlayChunked
    await update.call(self, {}, [overlay], [base, overlay])
    expect(plansSeen).toEqual([basePlan])
  })
}

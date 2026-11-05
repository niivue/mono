import { expect, test } from 'bun:test'
import { VolumeRenderer as GLRenderer } from '@/gl/render'
import type { NVImage } from '@/NVTypes'
import { VolumeRenderer as GPURenderer } from '@/wgpu/render'

type Method = (...args: unknown[]) => Promise<void>
const method = (R: unknown, name: string) =>
  (R as { prototype: Record<string, Method> }).prototype[name]

// Mirrors are asked for the base's chunk indices and capped by its plan
// (chunkIndicesForAllBudgets), so one carrying its own grid would be priced
// and indexed against the wrong chunks. The overlay keeps its own plan,
// though: it may later become the base or stream independently.
for (const [name, Renderer] of [
  ['gl', GLRenderer],
  ['wgpu', GPURenderer],
] as const) {
  test(`${name}: a combined overlay streams on the base plan, keeping its own`, async () => {
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
      async _ensureChunkedVolumeEntry(...args: unknown[]) {
        plansSeen.push(args.at(-1))
        return entry
      },
    }
    await method(Renderer, '_updateCombinedOverlayChunked').call(
      self,
      {},
      [overlay],
      [base, overlay],
    )
    expect(plansSeen).toEqual([basePlan])
    expect(overlay.chunkPlan as unknown).toBe(ownPlan)
  })

  test(`${name}: swapping the base plan moves its combined mirrors too`, async () => {
    const newPlan = { chunks: [{}] }
    const base = { chunkPlan: null } as unknown as NVImage
    const overlayVol = { chunkPlan: null } as unknown as NVImage
    const baseEntry = { kind: 'chunked' }
    const mirror = { kind: 'chunked', volume: overlayVol }
    const swapped: unknown[][] = []
    const self = {
      _texCache: { get: () => baseEntry },
      _activeChunked: baseEntry,
      _combinedOverlayEntries: [mirror],
      async _swapChunkedEntryPlan(
        _dev: unknown,
        vol: NVImage,
        e: unknown,
        p: unknown,
      ) {
        swapped.push([vol, e, p])
      },
    }
    await method(Renderer, 'swapChunkedVolumePlan').call(
      self,
      {},
      base,
      newPlan,
      false,
    )
    expect(swapped).toEqual([
      [base, baseEntry, newPlan],
      [overlayVol, mirror, newPlan],
    ])
    expect(base.chunkPlan as unknown).toBe(newPlan)
    expect(overlayVol.chunkPlan).toBeNull()
  })
}

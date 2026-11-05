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
      plan: basePlan,
      manager: { setBudgetBytes() {} },
      decoded: { setMaxBytes() {} },
      sourceBytesPerVoxel: 1,
    }
    const self = {
      _catchUpToPlan: method(Renderer, '_catchUpToPlan'),
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
      _catchUpToPlan: method(Renderer, '_catchUpToPlan'),
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
        ;(e as { plan: unknown }).plan = p
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

  test(`${name}: a base swap during a mirror rebuild still reaches the mirror`, async () => {
    const oldPlan = { chunks: [{}] }
    const newPlan = { chunks: [{}, {}] }
    const base = { chunkPlan: oldPlan } as unknown as NVImage
    const overlay = { chunkPlan: null } as unknown as NVImage
    const entry = {
      plan: oldPlan as unknown,
      manager: { setBudgetBytes() {} },
      decoded: { setMaxBytes() {} },
      sourceBytesPerVoxel: 1,
    }
    const self = {
      _catchUpToPlan: method(Renderer, '_catchUpToPlan'),
      _chunkResidencyBytes: 1000,
      _activeChunked: null,
      _combinedOverlayEntries: [] as unknown[],
      _invalidateBindGroupCache() {},
      async _ensureChunkedVolumeEntry() {
        // The base swaps while the mirror entry is being built.
        ;(base as { chunkPlan: unknown }).chunkPlan = newPlan
        return entry
      },
      async _swapChunkedEntryPlan(
        _d: unknown,
        _v: unknown,
        e: typeof entry,
        p: unknown,
      ) {
        e.plan = p
      },
    }
    await method(Renderer, '_updateCombinedOverlayChunked').call(
      self,
      {},
      [overlay],
      [base, overlay],
    )
    expect(entry.plan).toBe(newPlan)
    expect(self._combinedOverlayEntries).toEqual([entry])
  })

  test(`${name}: overlapping base swaps leave the mirrors on the newest plan`, async () => {
    const A = { label: 'A', chunks: [{}] }
    const B = { label: 'B', chunks: [{}, {}] }
    const base = { chunkPlan: null } as unknown as NVImage
    const baseEntry = { kind: 'chunked', plan: null }
    const mirror = { kind: 'chunked', volume: {}, plan: null }
    let release = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    const self = {
      _catchUpToPlan: method(Renderer, '_catchUpToPlan'),
      _texCache: { get: () => baseEntry },
      _activeChunked: baseEntry,
      _combinedOverlayEntries: [mirror],
      async _swapChunkedEntryPlan(
        _dev: unknown,
        _vol: unknown,
        e: { plan: unknown },
        p: unknown,
      ) {
        // The mirror's swap to A lands late, after B has finished.
        if (e === mirror && p === A) await gate
        e.plan = p
      },
    }
    const swap = method(Renderer, 'swapChunkedVolumePlan')
    const first = swap.call(self, {}, base, A, false)
    await swap.call(self, {}, base, B, false)
    release()
    await first
    expect(baseEntry.plan as unknown).toBe(B)
    expect(mirror.plan as unknown).toBe(B)
  })
}

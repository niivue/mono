import { expect, test } from 'bun:test'
import { VolumeRenderer as GLRenderer } from '@/gl/render'
import type { NVImage } from '@/NVTypes'
import { chunkedDisplayKey, volumeSourceKey } from '@/volume/orientChunked'
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
      decoded: { resize() {} },
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
      _queueEntrySwap: method(Renderer, '_queueEntrySwap'),
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
      decoded: { resize() {} },
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
      _queueEntrySwap: method(Renderer, '_queueEntrySwap'),
      _texCache: { get: () => baseEntry },
      _activeChunked: baseEntry,
      _combinedOverlayEntries: [mirror],
      async _swapChunkedEntryPlan(
        _dev: unknown,
        _vol: unknown,
        e: { plan: unknown },
        p: unknown,
      ) {
        // The mirror's swap to A is still in flight when B is asked for.
        if (e === mirror && p === A) await gate
        e.plan = p
      },
    }
    const swap = method(Renderer, 'swapChunkedVolumePlan')
    const first = swap.call(self, {}, base, A, false)
    await Promise.resolve()
    const second = swap.call(self, {}, base, B, false)
    release()
    await Promise.all([first, second])
    expect(baseEntry.plan as unknown).toBe(B)
    expect(mirror.plan as unknown).toBe(B)
  })

  test(`${name}: swaps on one entry run one at a time, skipping superseded ones`, async () => {
    const [A, B, C] = ['A', 'B', 'C'].map((label) => ({ label, chunks: [{}] }))
    const base = { chunkPlan: null } as unknown as NVImage
    const baseEntry = { kind: 'chunked', plan: null }
    const mirror = { kind: 'chunked', volume: {}, plan: null }
    let release = () => {}
    const gate = new Promise<void>((r) => {
      release = r
    })
    const running = new Set<unknown>()
    const swapped: [unknown, unknown][] = []
    const self = {
      _catchUpToPlan: method(Renderer, '_catchUpToPlan'),
      _queueEntrySwap: method(Renderer, '_queueEntrySwap'),
      _texCache: { get: () => baseEntry },
      _activeChunked: baseEntry,
      _combinedOverlayEntries: [mirror],
      async _swapChunkedEntryPlan(
        _dev: unknown,
        _vol: unknown,
        e: { plan: unknown },
        p: unknown,
      ) {
        // Each swap reads the entry, awaits, then rewrites it: two at once
        // would re-key the same residency twice.
        expect(running.has(e)).toBe(false)
        running.add(e)
        swapped.push([e, p])
        if (e === baseEntry && p === A) await gate
        await Promise.resolve()
        e.plan = p
        running.delete(e)
      },
    }
    const swap = method(Renderer, 'swapChunkedVolumePlan')
    const first = swap.call(self, {}, base, A, false)
    await Promise.resolve()
    const later = [B, C].map((p) => swap.call(self, {}, base, p, false))
    release()
    await Promise.all([first, ...later])
    expect(baseEntry.plan as unknown).toBe(C)
    expect(mirror.plan as unknown).toBe(C)
    expect(swapped.filter(([e]) => e === baseEntry).map(([, p]) => p)).toEqual([
      A,
      C,
    ])
    expect(swapped.filter(([e, p]) => e === mirror && p === C).length).toBe(1)
  })

  test(`${name}: a refresh waiting on a superseded swap keeps the entry`, async () => {
    const plan = () => ({
      chunks: [{ texDims: [4, 4, 4] }],
      gridDims: [1, 1, 1],
    })
    const [old, A, B] = [plan(), plan(), plan()]
    const vol = {
      name: 'v',
      hdr: { dims: [3, 4, 4, 4], datatypeCode: 2, scl_slope: 1, scl_inter: 0 },
      chunkPlan: old,
    } as unknown as NVImage
    const entry = {
      kind: 'chunked',
      plan: old as unknown,
      volume: vol,
      displayKey: chunkedDisplayKey(vol, null),
      sourceKey: volumeSourceKey(vol),
    }
    const self = {
      max3D: 8,
      maxTextureDimension3D: 8,
      _texCache: { get: () => entry },
      _activeChunked: entry,
      _combinedOverlayEntries: [],
      _queueEntrySwap: method(Renderer, '_queueEntrySwap'),
      _evictTexEntry() {
        throw new Error('entry evicted')
      },
      async _swapChunkedEntryPlan(
        _dev: unknown,
        _vol: unknown,
        e: { plan: unknown },
        p: unknown,
      ) {
        e.plan = p
      },
    }
    const swap = method(Renderer, 'swapChunkedVolumePlan')
    // Queue A, refresh on A, then supersede A with B in the same turn.
    const first = swap.call(self, {}, vol, A, false)
    const refresh = method(Renderer, '_ensureChunkedVolumeEntry')
      .call(self, {}, vol, 1000, null)
      .catch((e: Error) => e.message)
    const second = swap.call(self, {}, vol, B, false)
    expect((await refresh) as unknown).toBe(entry)
    await Promise.all([first, second])
    expect(entry.plan).toBe(B)
  })

  test(`${name}: swapping a combined mirror's own plan leaves it on the base grid`, async () => {
    const [basePlan, ownPlan] = [1, 2].map((n) => ({
      chunks: Array.from({ length: n }, () => ({})),
    }))
    const overlay = { chunkPlan: null } as unknown as NVImage
    const baseEntry = { kind: 'chunked', plan: basePlan }
    const mirror = { kind: 'chunked', volume: overlay, plan: basePlan }
    const swapped: unknown[] = []
    const self = {
      _queueEntrySwap: method(Renderer, '_queueEntrySwap'),
      _texCache: { get: () => mirror },
      _activeChunked: baseEntry,
      _combinedOverlayEntries: [mirror],
      async _swapChunkedEntryPlan(_d: unknown, _v: unknown, e: unknown) {
        swapped.push(e)
      },
    }
    await method(Renderer, 'swapChunkedVolumePlan').call(
      self,
      {},
      overlay,
      ownPlan,
      false,
    )
    expect(mirror.plan).toBe(basePlan)
    expect(swapped).toEqual([])
    expect(overlay.chunkPlan as unknown).toBe(ownPlan)
  })
}

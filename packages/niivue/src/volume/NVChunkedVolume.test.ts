import { describe, expect, test } from 'bun:test'
import { mat4 } from 'gl-matrix'
import type NiiVueGPU from '@/NVControlBase'
import type { NVImage, VolumeChunkSourceRequest } from '@/NVTypes'
import type {
  ChunkedVolumeFetch,
  ChunkedVolumeSource,
} from './ChunkedVolumeSource'
import type { ChunkPlan, Vec3f, Vec3i, VolumeChunkDesc } from './chunking'
import {
  createSourceChunkLoader,
  focusCenterBiased,
  mmToVolumeFraction,
  NVChunkedVolume,
  planForFocus,
} from './NVChunkedVolume'

function req(
  sourceLevel: number,
  texOrigin: Vec3i,
  texDims: Vec3i,
  bytesPerVoxel = 2,
): VolumeChunkSourceRequest {
  const desc = {
    voxelOrigin: texOrigin,
    voxelDims: texDims,
    haloLow: [0, 0, 0],
    haloHigh: [0, 0, 0],
    texDims,
    texOrigin,
    gridIndex: [0, 0, 0],
    sourceLevel,
  } as unknown as VolumeChunkDesc
  return {
    chunkIndex: 0,
    desc,
    plan: {} as VolumeChunkSourceRequest['plan'],
    datatypeCode: 4,
    bytesPerVoxel,
  }
}

const opts = {
  budgetBytes: 0,
  maxBricks: 0,
  cellEdge: 64,
  halo: [1, 1, 1] as Vec3i,
  detail: 1,
  minLevel: 0,
  deviceLimit: 256,
  renderCentering: 'none' as const,
  debounceMs: 150,
}

describe('focusCenterBiased', () => {
  test('nudges the focus off cell boundaries and clamps to the volume', () => {
    const c = focusCenterBiased([256, 256, 256], [0.5, 0.5, 0.5], 128)
    // base 128 + asymmetric bias; distinct per axis, all inside the volume.
    expect(c[0]).toBeGreaterThan(128)
    expect(c[0]).not.toBe(c[1])
    expect(c[1]).not.toBe(c[2])
    for (let a = 0; a < 3; a++) expect(c[a]).toBeLessThan(256)
  })
})

describe('mmToVolumeFraction', () => {
  // Column-major scale+translate: mm = frac * [10,20,30] + [1,2,3].
  const f2m = mat4.fromValues(10, 0, 0, 0, 0, 20, 0, 0, 0, 0, 30, 0, 1, 2, 3, 1)

  test('inverts frac2mm to recover the texture fraction', () => {
    const frac = mmToVolumeFraction(f2m, [6, 12, 18])
    expect(frac).not.toBeNull()
    for (const v of frac ?? []) expect(v).toBeCloseTo(0.5, 6)
  })

  test('clamps a crosshair outside the volume to [0,1]', () => {
    expect(mmToVolumeFraction(f2m, [999, -999, 18])).toEqual([1, 0, 0.5])
  })

  test('returns null for a singular matrix', () => {
    const singular = mat4.fromValues(
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
    )
    expect(mmToVolumeFraction(singular, [1, 2, 3])).toBeNull()
  })
})

describe('planForFocus', () => {
  const source: ChunkedVolumeSource = {
    datatypeCode: 4,
    levels: [
      { level: 0, shape: [512, 512, 512], spacing: [1, 1, 1] },
      { level: 1, shape: [256, 256, 256], spacing: [2, 2, 2] },
      { level: 2, shape: [128, 128, 128], spacing: [4, 4, 4] },
      { level: 3, shape: [64, 64, 64], spacing: [8, 8, 8] },
    ],
    fetchChunk: async () => new Uint8Array(),
  }

  test('finest bricks cluster near the focus, coarsen outward, under budget', () => {
    const plan = planForFocus(source, [0.2, 0.2, 0.2], 32, {
      ...opts,
      budgetBytes: 512 * 1024 * 1024,
      maxBricks: 240,
    })
    const common = plan.volumeDims
    const focusC = [0.2 * common[0], 0.2 * common[1], 0.2 * common[2]]
    const dist = (c: VolumeChunkDesc): number => {
      const ctr = [
        c.voxelOrigin[0] + c.voxelDims[0] / 2,
        c.voxelOrigin[1] + c.voxelDims[1] / 2,
        c.voxelOrigin[2] + c.voxelDims[2] / 2,
      ]
      return Math.hypot(
        ctr[0] - focusC[0],
        ctr[1] - focusC[1],
        ctr[2] - focusC[2],
      )
    }
    const byLevel = new Map<number, number[]>()
    for (const c of plan.chunks) {
      const l = c.sourceLevel ?? 0
      if (!byLevel.has(l)) byLevel.set(l, [])
      byLevel.get(l)?.push(dist(c))
    }
    const levels = [...byLevel.keys()].sort((a, b) => a - b)
    expect(levels.length).toBeGreaterThan(1) // genuinely mixed resolution
    const mean = (l: number): number => {
      const ds = byLevel.get(l) ?? []
      return ds.reduce((a, b) => a + b, 0) / ds.length
    }
    // Finer level => closer to the focus on average.
    for (let i = 1; i < levels.length; i++) {
      expect(mean(levels[i])).toBeGreaterThan(mean(levels[i - 1]))
    }
    // Budget respected (rgba + gradient = 8 B/voxel over padded textures).
    const bytes = plan.chunks.reduce(
      (s, c) => s + c.texDims[0] * c.texDims[1] * c.texDims[2] * 8,
      0,
    )
    expect(bytes).toBeLessThanOrEqual(512 * 1024 * 1024)
    expect(plan.chunks.length).toBeLessThanOrEqual(240)
  })
})

describe('createSourceChunkLoader', () => {
  test('dispatches each brick to its own level with level-grid coords', async () => {
    const calls: ChunkedVolumeFetch[] = []
    const source: ChunkedVolumeSource = {
      datatypeCode: 4,
      levels: [
        { level: 0, shape: [8, 8, 8], spacing: [1, 1, 1] },
        { level: 1, shape: [4, 4, 4], spacing: [2, 2, 2] },
      ],
      fetchChunk: async (r) => {
        calls.push(r)
        return new Uint8Array(
          r.texDims[0] * r.texDims[1] * r.texDims[2] * r.bytesPerVoxel,
        )
      },
    }
    const load = createSourceChunkLoader(source, {
      maxConcurrentLoads: 4,
      retryAttempts: 1,
    })
    await load(req(0, [0, 0, 0], [2, 2, 2], 2))
    await load(req(1, [1, 2, 3], [2, 2, 2], 2))
    expect(calls).toHaveLength(2)
    expect(calls[0].levelIndex).toBe(0)
    expect(calls[1].levelIndex).toBe(1)
    expect(calls[1].texOrigin).toEqual([1, 2, 3])
    expect(calls[1].bytesPerVoxel).toBe(2)
  })

  test('bounds in-flight fetches to maxConcurrentLoads', async () => {
    let active = 0
    let peak = 0
    const source: ChunkedVolumeSource = {
      datatypeCode: 4,
      levels: [{ level: 0, shape: [64, 64, 64], spacing: [1, 1, 1] }],
      fetchChunk: async () => {
        active++
        peak = Math.max(peak, active)
        await new Promise((r) => setTimeout(r, 15))
        active--
        return new Uint8Array(8)
      },
    }
    const load = createSourceChunkLoader(source, {
      maxConcurrentLoads: 2,
      retryAttempts: 1,
    })
    // 8 distinct regions (no dedup) fired at once.
    await Promise.all(
      Array.from({ length: 8 }, (_, i) => load(req(0, [i, 0, 0], [1, 1, 1]))),
    )
    expect(peak).toBeLessThanOrEqual(2)
  })

  test('dedups concurrent requests for the same region', async () => {
    let calls = 0
    const source: ChunkedVolumeSource = {
      datatypeCode: 4,
      levels: [{ level: 0, shape: [64, 64, 64], spacing: [1, 1, 1] }],
      fetchChunk: async () => {
        calls++
        await new Promise((r) => setTimeout(r, 10))
        return new Uint8Array(8)
      },
    }
    const load = createSourceChunkLoader(source, {
      maxConcurrentLoads: 4,
      retryAttempts: 1,
    })
    const a = load(req(0, [0, 0, 0], [1, 1, 1]))
    const b = load(req(0, [0, 0, 0], [1, 1, 1]))
    await Promise.all([a, b])
    expect(calls).toBe(1)
  })

  test('retries a transient "Failed to fetch" and then succeeds', async () => {
    let attempts = 0
    const source: ChunkedVolumeSource = {
      datatypeCode: 4,
      levels: [{ level: 0, shape: [64, 64, 64], spacing: [1, 1, 1] }],
      fetchChunk: async () => {
        attempts++
        if (attempts === 1) throw new TypeError('Failed to fetch')
        return new Uint8Array(8)
      },
    }
    const load = createSourceChunkLoader(source, {
      maxConcurrentLoads: 4,
      retryAttempts: 3,
    })
    const out = await load(req(0, [0, 0, 0], [1, 1, 1]))
    expect(attempts).toBe(2)
    expect((out as Uint8Array).byteLength).toBe(8)
  })

  test('a permanently failing fetch rejects the caller with no unhandled rejection', async () => {
    const unhandled: unknown[] = []
    const onUnhandled = (err: unknown): void => {
      unhandled.push(err)
    }
    process.on('unhandledRejection', onUnhandled)
    try {
      const source: ChunkedVolumeSource = {
        datatypeCode: 4,
        levels: [{ level: 0, shape: [8, 8, 8], spacing: [1, 1, 1] }],
        // Non-transient: withRetry throws on the first attempt (retryAttempts 1).
        fetchChunk: async () => {
          throw new Error('permanent 404')
        },
      }
      const load = createSourceChunkLoader(source, {
        maxConcurrentLoads: 2,
        retryAttempts: 1,
      })
      await expect(load(req(0, [0, 0, 0], [1, 1, 1]))).rejects.toThrow(
        'permanent 404',
      )
      // The internal cleanup promise settles on a microtask; give it a turn.
      await new Promise((r) => setTimeout(r, 0))
      expect(unhandled).toHaveLength(0)
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
  })
})

// --- manager: id uniqueness + serialized plan swaps ------------------------

const mgrSource: ChunkedVolumeSource = {
  datatypeCode: 4,
  levels: [
    { level: 0, shape: [256, 256, 256], spacing: [1, 1, 1] },
    { level: 1, shape: [128, 128, 128], spacing: [2, 2, 2] },
    { level: 2, shape: [64, 64, 64], spacing: [4, 4, 4] },
  ],
  fetchChunk: async () => new Uint8Array(),
}

/** Minimal host stub: only what the manager touches for a static-focus refocus. */
function makeHost(
  swap: (id: string, plan: ChunkPlan) => Promise<void>,
): NiiVueGPU {
  return {
    swapVolumeChunkPlan: swap,
  } as unknown as NiiVueGPU
}

interface Refocusable {
  focusFrac: Vec3f
  doRefocus(): Promise<void>
}

describe('NVChunkedVolume id + plan-swap routing', () => {
  test('two default-option handles get distinct ids that route swaps correctly', () => {
    const host = makeHost(async () => {})
    const a = new NVChunkedVolume(host, mgrSource, { radius: 16 })
    const b = new NVChunkedVolume(host, mgrSource, { radius: 16 })
    expect(a.id).not.toBe(b.id)
    // Mirror host.swapVolumeChunkPlan's find-first id-or-name lookup: b's id
    // must not match a (whose name is the shared 'streamed volume').
    const vols: NVImage[] = [a.volume, b.volume]
    expect(vols.find((v) => v.id === b.id || v.name === b.id)).toBe(b.volume)
    expect(vols.find((v) => v.id === a.id || v.name === a.id)).toBe(a.volume)
  })
})

describe('NVChunkedVolume serialized refocus', () => {
  test('a slow swap followed by a fast one leaves the newest plan applied', async () => {
    const applied: ChunkPlan[] = []
    let call = 0
    // First swap resolves LATE, second resolves immediately. Recorded on
    // RESOLUTION (when the GPU brick set actually updates), so an unserialized
    // path would record newest-then-oldest and disagree with currentPlan.
    const host = makeHost(
      (_id, plan) =>
        new Promise<void>((resolve) => {
          const ms = call++ === 0 ? 30 : 0
          setTimeout(() => {
            applied.push(plan)
            resolve()
          }, ms)
        }),
    )
    const mgr = new NVChunkedVolume(host, mgrSource, { radius: 16 })
    const inner = mgr as unknown as Refocusable

    inner.focusFrac = [0.2, 0.2, 0.2]
    const p1 = inner.doRefocus()
    inner.focusFrac = [0.8, 0.8, 0.8]
    const p2 = inner.doRefocus()
    await Promise.all([p1, p2])

    expect(applied).toHaveLength(2)
    // Newest plan applied last, and the handle/GPU agree.
    expect(applied[applied.length - 1]).toBe(mgr.currentPlan)
  })
})

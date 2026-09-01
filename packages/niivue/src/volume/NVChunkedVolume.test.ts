import { describe, expect, test } from 'bun:test'
import { mat4 } from 'gl-matrix'
import { SLICE_TYPE } from '@/NVConstants'
import type NiiVue from '@/NVControlBase'
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

  test('keeps a thin-axis centre inside the volume (extent below the bias band)', () => {
    // Z extent 30 < 2 * bias[2] (~29.44 each side at cellEdge 128): unclamped,
    // Math.min(common - bias, base + bias) goes NEGATIVE on that axis.
    const common: Vec3i = [4096, 4096, 30]
    const c = focusCenterBiased(common, [0.5, 0.5, 0.5], 128)
    for (let a = 0; a < 3; a++) {
      expect(c[a]).toBeGreaterThanOrEqual(0)
      expect(c[a]).toBeLessThanOrEqual(common[a])
    }
    // Too thin for the bias band: the only stable centre is the middle.
    expect(c[2]).toBeCloseTo(15, 6)
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

  test('thin-Z pyramid: finest bricks still cover the crosshair', () => {
    // Z extent (24) is below the bias band at cellEdge 128 (~29.44); an
    // unclamped focus centre lands OUTSIDE the volume (z = -5.44), inflating
    // every brick's z distance so a small pinned radius with a tight LOD
    // falloff leaves the crosshair region coarser than the finest level.
    const thin: ChunkedVolumeSource = {
      datatypeCode: 4,
      levels: [
        { level: 0, shape: [1024, 1024, 24], spacing: [1, 1, 1] },
        { level: 1, shape: [512, 512, 12], spacing: [2, 2, 2] },
        { level: 2, shape: [256, 256, 6], spacing: [4, 4, 4] },
      ],
      fetchChunk: async () => new Uint8Array(),
    }
    const common: Vec3i = [1024, 1024, 24]
    const center = focusCenterBiased(common, [0.5, 0.5, 0.5], 128)
    for (let a = 0; a < 3; a++) {
      expect(center[a]).toBeGreaterThanOrEqual(0)
      expect(center[a]).toBeLessThanOrEqual(common[a])
    }
    const plan = planForFocus(thin, [0.5, 0.5, 0.5], 4, {
      ...opts,
      cellEdge: 128,
      detail: 0.05,
      budgetBytes: 512 * 1024 * 1024,
      maxBricks: 240,
    })
    const vox = [512, 512, 12] // crosshair position in common-grid voxels
    const at = plan.chunks.filter((c) =>
      [0, 1, 2].every(
        (a) =>
          vox[a] >= c.voxelOrigin[a] &&
          vox[a] < c.voxelOrigin[a] + c.voxelDims[a],
      ),
    )
    expect(at.length).toBeGreaterThan(0)
    // The brick under the crosshair is at the finest level.
    expect(Math.min(...at.map((c) => c.sourceLevel ?? 0))).toBe(0)
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

  test('clamps maxConcurrentLoads:0 so it still fetches (no deadlock)', async () => {
    let calls = 0
    const source: ChunkedVolumeSource = {
      datatypeCode: 4,
      levels: [{ level: 0, shape: [8, 8, 8], spacing: [1, 1, 1] }],
      fetchChunk: async () => {
        calls++
        return new Uint8Array(8)
      },
    }
    // A 0 concurrency cap would leave acquire() forever pending (no slot frees);
    // the clamp to >= 1 must let the fetch through.
    const load = createSourceChunkLoader(source, {
      maxConcurrentLoads: 0,
      retryAttempts: 1,
    })
    const out = await load(req(0, [0, 0, 0], [1, 1, 1]))
    expect(calls).toBe(1)
    expect((out as Uint8Array).byteLength).toBe(8)
  })

  test('clamps a non-finite maxConcurrentLoads so the flood cap survives', async () => {
    // Infinity passes straight through both Math.floor and Math.max, so an
    // unguarded clamp leaves `active < maxConcurrent` permanently true and the
    // bound is gone: all 5 would run at once.
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
      maxConcurrentLoads: Number.POSITIVE_INFINITY,
      retryAttempts: 1,
    })
    // 5 distinct regions (distinct texOrigin, so no dedup) fired at once.
    await Promise.all(
      Array.from({ length: 5 }, (_, i) => load(req(0, [i, 0, 0], [1, 1, 1]))),
    )
    // Falls back to the safe floor of 1, not to 'all five at once'.
    expect(peak).toBe(1)
  })

  test('clamps a non-finite retryAttempts so retries stay bounded', async () => {
    // Infinity here is the worse half: withRetry's loop has no end, and once the
    // backoff 80 * 2 ** i overflows to Infinity the delay never resolves, so the
    // read hangs for good. Race a timer so a regression fails fast and loudly
    // rather than stalling the run until the job timeout.
    let calls = 0
    const source: ChunkedVolumeSource = {
      datatypeCode: 4,
      levels: [{ level: 0, shape: [8, 8, 8], spacing: [1, 1, 1] }],
      // TypeError is withRetry's 'transient' signal, the one it retries.
      fetchChunk: async () => {
        calls++
        throw new TypeError('Failed to fetch')
      },
    }
    const load = createSourceChunkLoader(source, {
      maxConcurrentLoads: 2,
      retryAttempts: Number.POSITIVE_INFINITY,
    })
    const outcome = await Promise.race([
      Promise.resolve(load(req(0, [0, 0, 0], [1, 1, 1]))).then(
        () => 'resolved',
        () => 'rejected',
      ),
      new Promise((r) => setTimeout(() => r('still retrying'), 500)),
    ])
    // Clamped to the floor of 1: one attempt, give up, no unbounded backoff.
    expect(outcome).toBe('rejected')
    expect(calls).toBe(1)
  })

  test('clamps NaN and fractional counts to a usable floor', async () => {
    let calls = 0
    const source: ChunkedVolumeSource = {
      datatypeCode: 4,
      levels: [{ level: 0, shape: [8, 8, 8], spacing: [1, 1, 1] }],
      fetchChunk: async () => {
        calls++
        return new Uint8Array(8)
      },
    }
    // NaN would make every `active < maxConcurrent` comparison false (nothing
    // ever starts); 0.5 floors to 0, which is the same deadlock.
    const load = createSourceChunkLoader(source, {
      maxConcurrentLoads: Number.NaN,
      retryAttempts: 0.5,
    })
    const out = await load(req(0, [0, 0, 0], [1, 1, 1]))
    expect(calls).toBe(1)
    expect((out as Uint8Array).byteLength).toBe(8)
  })

  test('retryAttempts:0 still fetches exactly once', async () => {
    let calls = 0
    const source: ChunkedVolumeSource = {
      datatypeCode: 4,
      levels: [{ level: 0, shape: [8, 8, 8], spacing: [1, 1, 1] }],
      fetchChunk: async () => {
        calls++
        return new Uint8Array(8)
      },
    }
    // 'No retries' must still make the initial fetch, not zero fetches.
    const load = createSourceChunkLoader(source, {
      maxConcurrentLoads: 4,
      retryAttempts: 0,
    })
    const out = await load(req(0, [0, 0, 0], [1, 1, 1]))
    expect(calls).toBe(1)
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

  test('a cancelled request aborts the source read', async () => {
    let seen: AbortSignal | undefined
    const source: ChunkedVolumeSource = {
      datatypeCode: 4,
      levels: [{ level: 0, shape: [8, 8, 8], spacing: [1, 1, 1] }],
      fetchChunk: (r) =>
        new Promise((_resolve, reject) => {
          seen = r.signal
          r.signal?.addEventListener('abort', () =>
            reject(new DOMException('aborted', 'AbortError')),
          )
        }),
    }
    const load = createSourceChunkLoader(source, {
      maxConcurrentLoads: 2,
      retryAttempts: 3,
    })
    const controller = new AbortController()
    const request = {
      ...req(0, [0, 0, 0], [1, 1, 1]),
      signal: controller.signal,
    }
    const pending = load(request)
    await new Promise((r) => setTimeout(r, 0))
    expect(seen?.aborted).toBe(false)
    controller.abort()
    expect(seen?.aborted).toBe(true)
    // An abort is never retried, so it surfaces on the first attempt.
    await expect(pending).rejects.toThrow('aborted')
  })

  test('one cancelled request does not abort a shared read another still wants', async () => {
    let seen: AbortSignal | undefined
    let release: (() => void) | undefined
    const source: ChunkedVolumeSource = {
      datatypeCode: 4,
      levels: [{ level: 0, shape: [8, 8, 8], spacing: [1, 1, 1] }],
      fetchChunk: (r) =>
        new Promise((resolve) => {
          seen = r.signal
          release = () => resolve(new Uint8Array(2))
        }),
    }
    const load = createSourceChunkLoader(source, {
      maxConcurrentLoads: 2,
      retryAttempts: 1,
    })
    const first = new AbortController()
    const second = new AbortController()
    // Same region, two chunk indices — the plan-swap case the dedup exists for.
    const shared = req(0, [0, 0, 0], [1, 1, 1])
    const a = load({ ...shared, signal: first.signal })
    const b = load({ ...shared, chunkIndex: 1, signal: second.signal })
    await new Promise((r) => setTimeout(r, 0))
    first.abort()
    expect(seen?.aborted).toBe(false)
    release?.()
    await expect(a).resolves.toHaveLength(2)
    await expect(b).resolves.toHaveLength(2)
    second.abort()
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
): NiiVue {
  return {
    swapVolumeChunkPlan: swap,
    _registerChunkedVolume: () => {},
    _unregisterChunkedVolume: () => {},
  } as unknown as NiiVue
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

describe('NVChunkedVolume deviceLimit default', () => {
  const makeHostWithLimit = (maxTextureDimension3D: number): NiiVue =>
    ({
      opts: { maxTextureDimension3D },
      swapVolumeChunkPlan: async () => {},
      _registerChunkedVolume: () => {},
      _unregisterChunkedVolume: () => {},
    }) as unknown as NiiVue

  test('defaults from the host maxTextureDimension3D option', () => {
    // Default cellEdge (128) would emit texDims up to 130 under the old
    // hardcoded 256; the host's 64 cap must bound every brick edge.
    const mgr = new NVChunkedVolume(makeHostWithLimit(64), mgrSource, {
      radius: 16,
    })
    for (const c of mgr.currentPlan.chunks) {
      for (let a = 0; a < 3; a++) expect(c.texDims[a]).toBeLessThanOrEqual(64)
    }
  })

  test('an explicit deviceLimit option wins over the host value', () => {
    const mgr = new NVChunkedVolume(makeHostWithLimit(64), mgrSource, {
      radius: 16,
      deviceLimit: 32,
    })
    for (const c of mgr.currentPlan.chunks) {
      for (let a = 0; a < 3; a++) expect(c.texDims[a]).toBeLessThanOrEqual(32)
    }
  })

  test('falls back to 256 when the host has no configured limit', () => {
    const mgr = new NVChunkedVolume(
      makeHost(async () => {}),
      mgrSource,
      {
        radius: 16,
      },
    )
    // Bricks larger than a small cap prove the fallback stayed at 256.
    const maxEdge = Math.max(
      ...mgr.currentPlan.chunks.map((c) => Math.max(...c.texDims)),
    )
    expect(maxEdge).toBeGreaterThan(64)
    expect(maxEdge).toBeLessThanOrEqual(256)
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

// --- manager: refocus completion promise -----------------------------------

/**
 * Host stub whose swap blocks until the test releases it, recording every
 * plan it was asked to apply, so a test can pin down exactly WHEN a refocus
 * promise settles relative to the host swap.
 */
function makeGatedHost(): {
  host: NiiVue
  swaps: ChunkPlan[]
  release: () => void
} {
  const swaps: ChunkPlan[] = []
  const releases: Array<() => void> = []
  const host = makeHost(
    (_id, plan) =>
      new Promise<void>((resolve) => {
        swaps.push(plan)
        releases.push(resolve)
      }),
  )
  // dispose() drops the viewDestroyed listener; nothing here subscribes.
  Object.assign(host, {
    addEventListener: () => {},
    removeEventListener: () => {},
  })
  return {
    host,
    swaps,
    release: () => {
      for (const r of releases.splice(0)) r()
    },
  }
}

/** Track a promise's settlement without awaiting it. */
function settled(p: Promise<unknown>): () => boolean {
  let done = false
  p.then(
    () => {
      done = true
    },
    () => {
      done = true
    },
  )
  return () => done
}

const tick = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms))

/**
 * Poll `predicate` until it holds, or throw after `timeoutMs`. Waits on real
 * observable state (a swap recorded, a promise settled) instead of a fixed
 * delay, so assertions never race the debounce timer or the swap chain under
 * CI scheduler load.
 */
const waitFor = async (
  predicate: () => boolean,
  timeoutMs = 2000,
): Promise<void> => {
  const start = Date.now()
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('waitFor: predicate not satisfied within timeout')
    }
    await tick(1)
  }
}

const DEBOUNCE = 20

describe('NVChunkedVolume refocus promise', () => {
  test('setFocus resolves only after the host swap has applied', async () => {
    const { host, swaps, release } = makeGatedHost()
    const mgr = new NVChunkedVolume(host, mgrSource, {
      radius: 16,
      debounceMs: DEBOUNCE,
    })
    const before = mgr.currentPlan
    const done = settled(mgr.setFocus([0.2, 0.2, 0.2]))

    // Timer fired, swap requested, but the host has not applied it yet.
    await waitFor(() => swaps.length === 1)
    expect(done()).toBe(false)

    release()
    await waitFor(() => done())
    expect(mgr.currentPlan).not.toBe(before)
    expect(swaps[0]).toBe(mgr.currentPlan)
    expect(mgr.focus).toEqual([0.2, 0.2, 0.2])
  })

  test('two rapid setFocus calls coalesce: both resolve, the host sees one swap of the newest plan', async () => {
    const { host, swaps, release } = makeGatedHost()
    const mgr = new NVChunkedVolume(host, mgrSource, {
      radius: 16,
      debounceMs: DEBOUNCE,
    })
    const first = mgr.setFocus([0.2, 0.2, 0.2])
    const second = mgr.setFocus([0.8, 0.8, 0.8])
    const firstDone = settled(first)
    const secondDone = settled(second)

    await waitFor(() => swaps.length === 1)
    expect(firstDone()).toBe(false)
    expect(secondDone()).toBe(false)

    release()
    await Promise.all([first, second])
    // The superseded request settles with the swap that absorbed it.
    expect(swaps).toHaveLength(1)
    expect(swaps[0]).toBe(mgr.currentPlan)
    expect(mgr.focus).toEqual([0.8, 0.8, 0.8])
  })

  test('a superseded request does not resolve before the superseding plan is on the host', async () => {
    // Per-swap gating that records each plan at APPLICATION time (its release),
    // so the test can apply an OLDER swap on its own and prove the superseded
    // promise stays unsettled until the swap that absorbed it has applied.
    // This is the #153 hazard spelled out: "a promise that resolves after a
    // superseded refocus would be worse than no promise".
    const applied: ChunkPlan[] = []
    const gates: Array<{ plan: ChunkPlan; resolve: () => void }> = []
    const host = makeHost(
      (_id, plan) =>
        new Promise<void>((resolve) => {
          gates.push({
            plan,
            resolve: () => {
              applied.push(plan)
              resolve()
            },
          })
        }),
    )
    const mgr = new NVChunkedVolume(host, mgrSource, {
      radius: 16,
      debounceMs: DEBOUNCE,
    })
    // An older refocus whose swap the host is still holding.
    const older = mgr.setFocus([0.1, 0.1, 0.1])
    await waitFor(() => gates.length === 1)

    // A superseded/superseding pair arrives while that older swap is in
    // flight. Both share ONE deferred: the superseded request is absorbed by
    // the newer one, and only the newest focus is ever planned.
    const superseded = mgr.setFocus([0.4, 0.4, 0.4])
    const superseding = mgr.setFocus([0.9, 0.9, 0.9])
    expect(superseding).toBe(superseded)
    const supersededDone = settled(superseded)
    await tick(DEBOUNCE * 4)
    // The coalesced swap is queued behind the older one, not yet with the host.
    expect(gates).toHaveLength(1)
    expect(supersededDone()).toBe(false)

    // Apply ONLY the older swap. The plan that absorbed the superseded request
    // is not on the host yet, so its promise must not settle off this older
    // swap.
    gates[0].resolve()
    await older
    await tick()
    expect(supersededDone()).toBe(false)

    // The coalesced swap (built for the NEWEST focus) is now with the host.
    await waitFor(() => gates.length === 2)
    gates[1].resolve()
    await superseded
    // It settled only once the newest plan applied, and that plan applied last.
    expect(applied).toHaveLength(2)
    expect(applied[applied.length - 1]).toBe(mgr.currentPlan)
    expect(gates[1].plan).toBe(mgr.currentPlan)
    expect(mgr.focus).toEqual([0.9, 0.9, 0.9])
  })

  test('a request made while a swap is in flight queues a second swap, in order', async () => {
    const { host, swaps, release } = makeGatedHost()
    const mgr = new NVChunkedVolume(host, mgrSource, {
      radius: 16,
      debounceMs: DEBOUNCE,
    })
    const first = mgr.setFocus([0.2, 0.2, 0.2])
    await waitFor(() => swaps.length === 1)
    // Now in flight (host holding the first swap); a new request debounces
    // separately and must not be absorbed by the swap already in progress.
    const second = mgr.setFocus([0.8, 0.8, 0.8])
    const secondDone = settled(second)
    await tick(DEBOUNCE * 4)
    expect(swaps).toHaveLength(1) // serialized behind the first
    release()
    await first
    expect(secondDone()).toBe(false)
    await waitFor(() => swaps.length === 2)
    release()
    await second
    expect(swaps[1]).toBe(mgr.currentPlan)
  })

  test('dispose() before the timer fires resolves the pending promise without a swap', async () => {
    const { host, swaps } = makeGatedHost()
    const mgr = new NVChunkedVolume(host, mgrSource, {
      radius: 16,
      debounceMs: 1000,
    })
    const before = mgr.currentPlan
    const pending = mgr.setFocus([0.2, 0.2, 0.2])
    mgr.dispose()
    await pending
    expect(swaps).toHaveLength(0)
    expect(mgr.currentPlan).toBe(before)
    // After dispose every mutator resolves immediately and stays inert.
    await mgr.setBudget(1024)
    await mgr.setMaxDetail(1)
    await mgr.setBudgetPlan('uniform')
    expect(swaps).toHaveLength(0)
  })

  test('a failed host swap still resolves the request (logged, not rejected)', async () => {
    const host = makeHost(async () => {
      throw new Error('swap exploded')
    })
    const mgr = new NVChunkedVolume(host, mgrSource, {
      radius: 16,
      debounceMs: DEBOUNCE,
    })
    await expect(mgr.setFocus([0.2, 0.2, 0.2])).resolves.toBeUndefined()
    // The queue is intact: a later request still applies.
    await expect(mgr.setBudget(1024)).resolves.toBeUndefined()
  })

  test('raiseHaloTo resolves immediately when it is a no-op', async () => {
    const { host, swaps } = makeGatedHost()
    const mgr = new NVChunkedVolume(host, mgrSource, {
      radius: 16,
      debounceMs: DEBOUNCE,
    })
    const done = settled(mgr.raiseHaloTo(1)) // default halo is already 1
    await waitFor(() => done())
    expect(swaps).toHaveLength(0)
  })

  test('whenSettled resolves immediately when idle', async () => {
    const { host, swaps } = makeGatedHost()
    const mgr = new NVChunkedVolume(host, mgrSource, {
      radius: 16,
      debounceMs: DEBOUNCE,
    })
    const done = settled(mgr.whenSettled())
    await waitFor(() => done())
    expect(swaps).toHaveLength(0)
  })

  test('whenSettled waits for a pending refocus and its in-flight swap', async () => {
    const { host, swaps, release } = makeGatedHost()
    const mgr = new NVChunkedVolume(host, mgrSource, {
      radius: 16,
      debounceMs: DEBOUNCE,
    })
    void mgr.setFocus([0.2, 0.2, 0.2])
    const barrier = settled(mgr.whenSettled())
    // Pending (timer not fired): not settled.
    expect(barrier()).toBe(false)
    await waitFor(() => swaps.length === 1)
    // In flight (host holding the swap): still not settled.
    expect(barrier()).toBe(false)
    release()
    await waitFor(() => barrier())
    // Idle again: a fresh barrier is immediate.
    const again = settled(mgr.whenSettled())
    await waitFor(() => again())
  })

  test('dispose() settles whenSettled and a queued setFocus behind a swap the host never completes', async () => {
    // The host takes the swap and simply never settles it (a torn-down
    // renderer). Everything chained on the swap queue would hang forever
    // without dispose racing it: the first request's own promise, a second
    // request queued behind it, and the whenSettled barrier.
    const { host, swaps } = makeGatedHost() // release() is never called
    const mgr = new NVChunkedVolume(host, mgrSource, {
      radius: 16,
      debounceMs: DEBOUNCE,
    })
    const first = mgr.setFocus([0.2, 0.2, 0.2])
    await waitFor(() => swaps.length === 1) // in flight, hung
    const second = mgr.setFocus([0.8, 0.8, 0.8])
    await tick(DEBOUNCE * 4) // second's doRefocus is now queued behind the hang
    const firstDone = settled(first)
    const secondDone = settled(second)
    const barrierDone = settled(mgr.whenSettled())
    await tick()
    expect(firstDone()).toBe(false)
    expect(secondDone()).toBe(false)
    expect(barrierDone()).toBe(false)

    mgr.dispose()
    await waitFor(() => firstDone() && secondDone() && barrierDone())
    // A barrier requested after dispose is immediate too.
    await mgr.whenSettled()
  })

  test('mutators after dispose resolve without touching state', async () => {
    const { host, swaps } = makeGatedHost()
    const mgr = new NVChunkedVolume(host, mgrSource, {
      radius: 16,
      debounceMs: DEBOUNCE,
    })
    const focus = mgr.focus
    const plan = mgr.currentPlan
    const budgetBytes = mgr.budgetPlan.budgetBytes
    const halo = mgr.halo
    mgr.dispose()

    await mgr.setFocus([0.9, 0.9, 0.9])
    await mgr.setMaxDetail(2)
    await mgr.setBudget(budgetBytes + 1)
    await mgr.raiseHaloTo(halo[0] + 3)

    expect(mgr.focus).toEqual(focus)
    expect(mgr.currentPlan).toBe(plan)
    expect(mgr.budgetPlan.budgetBytes).toBe(budgetBytes)
    expect(mgr.halo).toEqual(halo)
    await tick(DEBOUNCE * 4)
    expect(swaps).toHaveLength(0)
  })

  test('whenSettled resolves after dispose cancels a pending refocus', async () => {
    const { host } = makeGatedHost()
    const mgr = new NVChunkedVolume(host, mgrSource, {
      radius: 16,
      debounceMs: 1000,
    })
    void mgr.setFocus([0.2, 0.2, 0.2])
    const barrier = mgr.whenSettled()
    mgr.dispose()
    await expect(barrier).resolves.toBeUndefined()
  })
})

// --- manager: automatic coarse floor ---------------------------------------

/**
 * Host stub that records every floor install. `setBaseCoarseFloor` is the only
 * host call `applyCoarseFloor` makes, so nothing else needs stubbing.
 */
function makeFloorHost(): {
  host: NiiVue
  installs: Array<NVImage | null>
} {
  const installs: Array<NVImage | null> = []
  const host = {
    setBaseCoarseFloor: async (vol: NVImage | null) => {
      installs.push(vol)
    },
    _registerChunkedVolume: () => {},
    _unregisterChunkedVolume: () => {},
  } as unknown as NiiVue
  return { host, installs }
}

/** mgrSource with a recording fetchChunk that returns correctly-sized bytes. */
function floorSource(levels: ChunkedVolumeSource['levels']): {
  source: ChunkedVolumeSource
  fetches: ChunkedVolumeFetch[]
} {
  const fetches: ChunkedVolumeFetch[] = []
  const source: ChunkedVolumeSource = {
    datatypeCode: 4, // INT16 -> 2 bytes per voxel
    levels,
    fetchChunk: async (r) => {
      fetches.push(r)
      const n = r.texDims[0] * r.texDims[1] * r.texDims[2] * r.bytesPerVoxel
      return new Uint8Array(n)
    },
  }
  return { source, fetches }
}

describe('NVChunkedVolume coarse floor', () => {
  test('builds the floor from the coarsest level and installs it', async () => {
    const { host, installs } = makeFloorHost()
    const { source, fetches } = floorSource(mgrSource.levels)
    const mgr = new NVChunkedVolume(host, source, { radius: 16 })

    expect(await mgr.applyCoarseFloor()).toBe(true)
    // Whole coarsest level, in that level's own grid.
    expect(fetches).toHaveLength(1)
    expect(fetches[0].levelIndex).toBe(source.levels.length - 1)
    expect(fetches[0].texOrigin).toEqual([0, 0, 0])
    expect(fetches[0].texDims).toEqual([64, 64, 64])
    expect(fetches[0].bytesPerVoxel).toBe(2)

    expect(installs).toHaveLength(1)
    const floor = installs[0]
    expect(floor).not.toBeNull()
    // CPU voxels on the img:null streaming skeleton, reinterpreted as the
    // source datatype (INT16), and no chunkSource: the floor is not streamed.
    expect(floor?.img).toBeInstanceOf(Int16Array)
    expect(floor?.img?.length).toBe(64 * 64 * 64)
    expect(floor?.chunkSource).toBeUndefined()
    expect(floor?.dims?.slice(1, 4)).toEqual([64, 64, 64])
  })

  test('a repeat apply reuses the built floor instead of re-fetching', async () => {
    const { host, installs } = makeFloorHost()
    const { source, fetches } = floorSource(mgrSource.levels)
    const mgr = new NVChunkedVolume(host, source, { radius: 16 })

    await mgr.applyCoarseFloor()
    await mgr.applyCoarseFloor()
    expect(fetches).toHaveLength(1)
    expect(installs).toHaveLength(2)
    expect(installs[1]).toBe(installs[0])
  })

  test('coarseFloor: false neither fetches nor touches the host floor', async () => {
    const { host, installs } = makeFloorHost()
    const { source, fetches } = floorSource(mgrSource.levels)
    const mgr = new NVChunkedVolume(host, source, {
      radius: 16,
      coarseFloor: false,
    })

    expect(await mgr.applyCoarseFloor()).toBe(false)
    expect(fetches).toHaveLength(0)
    // An app-supplied floor set via setBaseCoarseFloor must survive.
    expect(installs).toHaveLength(0)
  })

  test('an oversized coarsest level CLEARS the floor rather than leaving a stale one', async () => {
    const { host, installs } = makeFloorHost()
    // Coarsest level is 1024^3: past both the voxel and the edge cap.
    const { source, fetches } = floorSource([
      { level: 0, shape: [4096, 4096, 4096], spacing: [1, 1, 1] },
      { level: 1, shape: [1024, 1024, 1024], spacing: [4, 4, 4] },
    ])
    const mgr = new NVChunkedVolume(host, source, { radius: 16 })

    expect(await mgr.applyCoarseFloor()).toBe(false)
    expect(fetches).toHaveLength(0)
    expect(installs).toEqual([null])
  })

  test('a failed fetch degrades to no floor, not a thrown load', async () => {
    const { host, installs } = makeFloorHost()
    const source: ChunkedVolumeSource = {
      datatypeCode: 4,
      levels: mgrSource.levels,
      fetchChunk: async () => {
        throw new Error('coarse level 404')
      },
    }
    const mgr = new NVChunkedVolume(host, source, { radius: 16 })

    expect(await mgr.applyCoarseFloor()).toBe(false)
    expect(installs).toEqual([null])
  })
})

describe('budget plans', () => {
  // A pyramid deep enough that the budget pass has somewhere to coarsen TO.
  const pyramid: ChunkedVolumeSource = {
    datatypeCode: 4,
    levels: [512, 256, 128, 64, 32].map((n, i) => ({
      level: i,
      shape: [n, n, n] as Vec3i,
      spacing: [2 ** i, 2 ** i, 2 ** i] as Vec3f,
    })),
    fetchChunk: async () => new Uint8Array(),
  }

  /** Records locationChange subscribe/unsubscribe so leaks are assertable. */
  function makePlanHost(): { host: NiiVue; listeners: () => number } {
    let n = 0
    const host = {
      swapVolumeChunkPlan: async () => {},
      _registerChunkedVolume: () => {},
      _unregisterChunkedVolume: () => {},
      addVolume: async () => {},
      sliceType: SLICE_TYPE.MULTIPLANAR,
      pan2Dxyzmm: [0, 0, 0, 1],
      getCrosshairPos: () => [0, 0, 0],
      addEventListener: (t: string) => {
        if (t === 'locationChange') n++
      },
      removeEventListener: (t: string) => {
        if (t === 'locationChange') n--
      },
    } as unknown as NiiVue
    return { host, listeners: () => n }
  }

  const levelsOf = (mgr: NVChunkedVolume): number[] => [
    ...new Set(mgr.currentPlan.chunks.map((c) => c.sourceLevel ?? 0)),
  ]

  test("'uniform' plans one level everywhere; an 8x smaller budget steps it by 1", () => {
    const at = (budgetBytes: number): number[] => {
      const mgr = new NVChunkedVolume(makePlanHost().host, pyramid, {
        budgetPlan: 'uniform',
        coarseFloor: false,
        cellEdge: 64,
        // High enough that BYTES are the only lever under test.
        maxBricks: 100000,
        budgetBytes,
      })
      return levelsOf(mgr)
    }
    const wide = at(160 * 1024 * 1024)
    expect(wide).toHaveLength(1)
    const tight = at(20 * 1024 * 1024)
    expect(tight).toHaveLength(1)
    // One eighth the bytes is one octree step: each level is 8x fewer voxels.
    expect(tight[0]).toBe(wide[0] + 1)
  })

  test("'focus' on the same source is genuinely mixed-resolution", () => {
    const mgr = new NVChunkedVolume(makePlanHost().host, pyramid, {
      budgetPlan: 'focus',
      coarseFloor: false,
      cellEdge: 64,
      radius: 64,
      budgetBytes: 512 * 1024 * 1024,
    })
    expect(levelsOf(mgr).length).toBeGreaterThan(1)
  })

  test('an individual option still wins over the named plan', () => {
    const mgr = new NVChunkedVolume(makePlanHost().host, pyramid, {
      budgetPlan: 'uniform',
      coarseFloor: false,
      focus: 'crosshair',
    })
    expect(mgr.budgetPlan.focus).toBe('crosshair')
    // Untouched by the override, so still the preset's.
    expect(mgr.budgetPlan.radius).toBe('volume')
  })

  test('focus -> uniform -> focus leaks no crosshair subscription', async () => {
    const { host, listeners } = makePlanHost()
    const mgr = new NVChunkedVolume(host, pyramid, {
      budgetPlan: 'focus',
      coarseFloor: false,
    })
    await mgr.init()
    expect(listeners()).toBe(1)

    mgr.setBudgetPlan('uniform')
    expect(mgr.budgetPlan.focus).toBe('none')
    expect(listeners()).toBe(0)
    // Idempotent: re-selecting the same plan must not unsubscribe twice.
    mgr.setBudgetPlan('uniform')
    expect(listeners()).toBe(0)

    mgr.setBudgetPlan('focus')
    expect(listeners()).toBe(1)
    mgr.dispose()
    expect(listeners()).toBe(0)
    // A switch after teardown must not resubscribe a disposed manager.
    mgr.setBudgetPlan('focus')
    expect(listeners()).toBe(0)
  })

  test('a plan switch keeps a max-detail cap set in between', () => {
    const mgr = new NVChunkedVolume(makePlanHost().host, pyramid, {
      budgetPlan: 'focus',
      coarseFloor: false,
      cellEdge: 64,
    })
    mgr.setMaxDetail(2)
    mgr.setBudgetPlan('uniform')
    expect(Math.min(...levelsOf(mgr))).toBeGreaterThanOrEqual(2)
  })
})

// --- automatic display window ---------------------------------------------

/**
 * A streamed volume is built before any voxel has been read, so its window can
 * only be a placeholder until data arrives. These cover the derivation that
 * replaces it, and the caller override that suppresses it.
 */
describe('NVChunkedVolume automatic display window', () => {
  const COARSE = 32

  /** uint8 pyramid whose coarsest level reads back as a 0..200 ramp + outliers. */
  const rampSource = (): ChunkedVolumeSource => ({
    datatypeCode: 2, // DT_UINT8
    levels: [
      { level: 0, shape: [128, 128, 128], spacing: [1, 1, 1] },
      { level: 1, shape: [COARSE, COARSE, COARSE], spacing: [4, 4, 4] },
    ],
    fetchChunk: async (r: { texDims: Vec3i }) => {
      const n = r.texDims[0] * r.texDims[1] * r.texDims[2]
      const out = new Uint8Array(n)
      for (let i = 0; i < n; i++) out[i] = Math.floor((i / n) * 200)
      for (let i = Math.max(0, n - 8); i < n; i++) out[i] = 255
      return out
    },
  })

  /**
   * The stub mirrors ONE controller behaviour that matters here: `addVolume`
   * stores a SHALLOW COPY (`NVModel.prepareVolume`), so what the scene renders
   * is a different object from the handle's `volume`. Without that, a window
   * written only to the handle looks correct in a test and is invisible on
   * screen.
   */
  function makeWindowHost(): {
    host: NiiVue
    updateGLCalls: () => number
    sceneVolume: () => NVImage | undefined
  } {
    let updateGL = 0
    const volumes: NVImage[] = []
    const host = {
      volumes,
      addVolume: async (vol: NVImage) => {
        volumes.push({ ...vol })
      },
      addEventListener: () => {},
      removeEventListener: () => {},
      setBaseCoarseFloor: async () => {},
      updateGLVolume: async () => {
        updateGL++
      },
      swapVolumeChunkPlan: async () => {},
      _registerChunkedVolume: () => {},
      _unregisterChunkedVolume: () => {},
      isDestroyed: false,
    } as unknown as NiiVue
    return {
      host,
      updateGLCalls: () => updateGL,
      sceneVolume: () => volumes[0],
    }
  }

  test('derives the window from the coarse floor instead of the 0..1 placeholder', async () => {
    const { host, updateGLCalls, sceneVolume } = makeWindowHost()
    const mgr = new NVChunkedVolume(host, rampSource(), { radius: 16 })
    // The placeholder every streamed volume starts on.
    expect(mgr.volume.calMin).toBe(0)
    expect(mgr.volume.calMax).toBe(1)

    await mgr.init()

    expect(mgr.volume.calMax).toBeGreaterThan(1)
    expect(mgr.volume.calMax).toBeGreaterThan(mgr.volume.calMin)
    // Contrast dragging scales by this range; on the placeholder it was 1.
    expect(mgr.volume.robustMin).toBe(mgr.volume.calMin)
    expect(mgr.volume.robustMax).toBe(mgr.volume.calMax)
    expect(mgr.volume.globalMax).toBe(255)
    // The outliers sit above the robust high, which is the point of a window.
    expect(mgr.volume.calMax).toBeLessThan(mgr.volume.globalMax as number)
    // The scene renders a shallow copy made before the window was derived; the
    // window is only real if it landed there too.
    expect(sceneVolume()?.calMin).toBe(mgr.volume.calMin)
    expect(sceneVolume()?.calMax).toBe(mgr.volume.calMax)
    expect(sceneVolume()?.robustMax).toBe(mgr.volume.calMax)
    // The new window has to reach the GPU, not just the model.
    expect(updateGLCalls()).toBe(1)
  })

  test('a caller-supplied window is left alone', async () => {
    const { host, updateGLCalls } = makeWindowHost()
    const mgr = new NVChunkedVolume(host, rampSource(), {
      radius: 16,
      calMin: 12,
      calMax: 34,
    })
    await mgr.init()
    expect(mgr.volume.calMin).toBe(12)
    expect(mgr.volume.calMax).toBe(34)
    expect(updateGLCalls()).toBe(0)
  })

  test('supplying only one bound still counts as caller-owned', async () => {
    const { host } = makeWindowHost()
    const mgr = new NVChunkedVolume(host, rampSource(), {
      radius: 16,
      calMax: 90,
    })
    await mgr.init()
    expect(mgr.volume.calMax).toBe(90)
  })

  test('falls back to a bounded probe when there is no coarse floor', async () => {
    const { host } = makeWindowHost()
    const mgr = new NVChunkedVolume(host, rampSource(), {
      radius: 16,
      coarseFloor: false,
    })
    await mgr.init()
    expect(mgr.volume.calMax).toBeGreaterThan(1)
    expect(mgr.volume.calMax).toBeGreaterThan(mgr.volume.calMin)
  })

  test('keeps the placeholder when every sampled voxel is identical', async () => {
    const { host } = makeWindowHost()
    const flat: ChunkedVolumeSource = {
      ...rampSource(),
      fetchChunk: async (r: { texDims: Vec3i }) =>
        new Uint8Array(r.texDims[0] * r.texDims[1] * r.texDims[2]).fill(7),
    }
    const mgr = new NVChunkedVolume(host, flat, { radius: 16 })
    await mgr.init()
    expect(mgr.volume.calMin).toBe(0)
    expect(mgr.volume.calMax).toBe(1)
  })
})

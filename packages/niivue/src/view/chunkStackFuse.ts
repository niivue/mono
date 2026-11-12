import { isVolumeDrawn } from './NVVolumeVisibility'

/**
 * Fused overlay textures, one per base chunk, for a channel stack
 * (`volumeIsChannelStack`) whose base is chunked. Each chunk fuses the resident
 * bricks of every drawn channel (the base and its streamed mirrors, which share
 * the base's chunk grid). An entry belongs to a brick region of one source
 * generation (the channels' loaders, so a frame switch is a new generation):
 * a plan swap moves it with its region, it keeps drawing while its bricks are
 * re-baked or a channel is shown or hidden, until the re-fuse replaces it, and
 * it never draws under another generation, so a frame switch shows no chunk
 * of the old time point beside one of the new. Backend-neutral; the renderers
 * supply the blend.
 */
export class ChunkStackFuse<T> {
  private fused: (
    | { region: string; gen: string; key: string; inputs: T[]; texture: T }
    | undefined
  )[] = []
  /** Chunks fused and the ms spent on them (CPU side), for benches. */
  readonly stats = { chunks: 0, ms: 0 }
  private cleared = 0

  /** `changed` reports a chunk whose fused texture changed (a cached binding). */
  constructor(
    private readonly destroy: (texture: T) => void,
    private readonly changed: (chunk: number) => void = () => {},
  ) {}

  /** The fused texture of chunk `i` for `region` in generation `gen`, else null. */
  get(i: number, region: string, gen: string): T | null {
    const have = this.fused[i]
    return have?.region === region && have.gen === gen ? have.texture : null
  }

  /** Every chunk's fused texture, `empty` where there is none. */
  textures(regions: readonly string[], gen: string, empty: T): T[] {
    return regions.map((r, i) => this.get(i, r, gen) ?? empty)
  }

  /**
   * Follow the plan and generation: move entries to their region's new index,
   * drop those whose region left it or whose generation is over, and return the
   * chunks to fuse, at most `max`: those whose complete input set (null while
   * a drawn channel's brick is still loading) or blend `modes` differ from what
   * they were fused with.
   */
  stale(
    regions: readonly string[],
    gen: string,
    modes: string,
    inputsOf: (i: number) => T[] | null,
    max: number,
  ): number[] {
    const at = new Map(regions.map((r, i) => [r, i]))
    const next: typeof this.fused = []
    this.fused.forEach((have, j) => {
      if (!have) return
      const i = have.gen === gen ? at.get(have.region) : undefined
      if (i === undefined || next[i]) {
        this.destroy(have.texture)
        this.changed(j)
        return
      }
      next[i] = have
      if (i !== j) this.changed(i)
    })
    this.fused = next
    const out: number[] = []
    for (let i = 0; i < regions.length && out.length < max; i++) {
      const inputs = inputsOf(i)
      const have = next[i]
      if (!inputs?.length) continue
      if (!have || have.key !== modes || !same(have.inputs, inputs)) out.push(i)
    }
    return out
  }

  /**
   * Fuse the stale chunks until `deadline` (at least one), with `blend`
   * returning the fused texture (null: skip). Stops, dropping its result,
   * once `alive` turns false or the fuse is cleared. Whether any chunk changed.
   */
  async pump(
    regions: readonly string[],
    gen: string,
    modes: string,
    inputsOf: (i: number) => T[] | null,
    blend: (inputs: T[], i: number) => T | null | Promise<T | null>,
    deadline: number,
    max: number,
    alive: () => boolean,
  ): Promise<boolean> {
    const cleared = this.cleared
    let changed = false
    for (const [k, i] of this.stale(
      regions,
      gen,
      modes,
      inputsOf,
      max,
    ).entries()) {
      const t0 = performance.now()
      if (k > 0 && t0 > deadline) break
      const inputs = inputsOf(i)
      if (!inputs) continue
      const texture = await blend(inputs, i)
      if (!texture) continue
      if (!alive() || this.cleared !== cleared) {
        this.destroy(texture)
        return changed
      }
      this.set(i, regions[i], gen, modes, inputs, texture)
      this.stats.chunks++
      this.stats.ms += performance.now() - t0
      changed = true
    }
    return changed
  }

  set(
    i: number,
    region: string,
    gen: string,
    modes: string,
    inputs: T[],
    texture: T,
  ): void {
    const have = this.fused[i]
    if (have) this.destroy(have.texture)
    this.fused[i] = { region, gen, key: modes, inputs, texture }
    this.changed(i)
  }

  clear(): void {
    this.cleared++
    this.fused.forEach((have, i) => {
      if (!have) return
      this.destroy(have.texture)
      this.changed(i)
    })
    this.fused = []
  }
}

function same<T>(a: T[], b: T[]): boolean {
  return a.length === b.length && a.every((t, k) => t === b[k])
}

/** A stack channel's chunk entry, as both renderers hold it. */
export interface StackEntry<T> {
  volume: { visible?: boolean; opacity?: number }
  sourceKey: string
  manager: { getChunk(i: number): { volumeTexture: T } | null | undefined }
}

/**
 * Drawn channels' resident bricks for chunk `i`, base first; null while any
 * of them is still loading, so a chunk is fused once, complete.
 */
export function stackInputs<T>(
  entries: readonly StackEntry<T>[],
  i: number,
): T[] | null {
  const out: T[] = []
  for (const e of entries) {
    if (!isVolumeDrawn(e.volume)) continue
    const tex = e.manager.getChunk(i)?.volumeTexture
    if (!tex) return null
    out.push(tex)
  }
  return out
}

/** The channels' source generation: changes with any channel's loader. */
export function stackGeneration<T>(entries: readonly StackEntry<T>[]): string {
  return entries.map((e) => e.sourceKey).join(';')
}

const _regions = new WeakMap<object, string[]>()

/** Each chunk's brick region of a plan (level, origin, size), memoized per plan. */
export function chunkRegions(plan: {
  chunks: readonly {
    sourceLevel?: number
    texOrigin: readonly number[]
    texDims: readonly number[]
  }[]
}): string[] {
  let out = _regions.get(plan)
  if (!out) {
    out = plan.chunks.map(
      (c) =>
        `${c.sourceLevel ?? 0}|${c.texOrigin.join(',')}|${c.texDims.join(',')}`,
    )
    _regions.set(plan, out)
  }
  return out
}

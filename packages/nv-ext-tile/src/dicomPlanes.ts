import type {
  NVSlideLevelManifest,
  NVSlideManifest,
  NVSlidePlaneAxes,
  NVSlidePlaneIndex,
  NVSlideTileManifest,
  SlidePlaneCapable,
  SlideSourceHost,
  SlideTileSource,
} from '@niivue/niivue'

/** The slide fields that place a plane in its stack. */
interface PlaneSlide {
  study: string
  series: string
  frameOfReference: string
  container?: string
  opticalPath: string
  focalPlane: number
  zOffsetUm?: number
}

/**
 * Slides of an index grouped into focal-plane stacks: one per study, series,
 * frame of reference, container and optical path, planes in rank order. A
 * stack of one is a plain slide.
 */
export function focalStacks<S extends PlaneSlide>(slides: readonly S[]): S[][] {
  const stacks = new Map<string, S[]>()
  for (const s of slides) {
    const key = [
      s.study,
      s.series,
      s.frameOfReference,
      s.container ?? '',
      s.opticalPath,
    ].join('|')
    const stack = stacks.get(key)
    if (stack) stack.push(s)
    else stacks.set(key, [s])
  }
  return [...stacks.values()].map((st) =>
    st.sort((a, b) => a.focalPlane - b.focalPlane),
  )
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b)

/**
 * Why `m` cannot be a plane of `base` (contract F14), or null: level-0 size,
 * spacing, channel count and, per channel and common level, storedToValue,
 * sampleType and bitsStored must match.
 */
function planeMismatch(
  base: NVSlideManifest,
  m: NVSlideManifest,
): string | null {
  if (m.width !== base.width || m.height !== base.height) return 'level-0 size'
  if (!same(m.pixelSpacingMM, base.pixelSpacingMM)) return 'pixel spacing'
  const info = m.channelInfo ?? []
  const baseInfo = base.channelInfo ?? []
  if (info.length !== baseInfo.length) return 'channel count'
  if (info.some((c, i) => !same(c.storedToValue, baseInfo[i]?.storedToValue)))
    return 'storedToValue'
  const n = Math.min(m.levels.length, base.levels.length)
  for (let i = 0; i < n; i++) {
    const a = m.levels[i] as NVSlideLevelManifest
    const b = base.levels[i] as NVSlideLevelManifest
    if (a.sampleType !== b.sampleType) return `level ${i} sampleType`
    if (a.bitsStored !== b.bitsStored) return `level ${i} bitsStored`
  }
  return null
}

/** `m` with every level stating plane `z`. */
const onPlane = (m: NVSlideManifest, z: number): NVSlideManifest => ({
  ...m,
  levels: m.levels.map((l) => ({ ...l, plane: { z, t: 0 } })),
})

/**
 * One slide's focal planes as a single source (`SlidePlaneCapable`), over one
 * source per plane in rank order (e.g. a {@link focalStacks} stack, each plane
 * a `DicomWsiSource` or `DicomWebWsiSource`). Every level states its `plane`;
 * fetch* reads that plane's source. `manifest` is plane `z` (default 0);
 * `preparePlane` rejects RangeError for a plane out of bounds or one whose
 * size, spacing or sample semantics differ from it (contract F14). The plane
 * sources are owned: dispose disposes them.
 */
export class DicomPlaneStack implements SlideTileSource, SlidePlaneCapable {
  readonly manifest: NVSlideManifest
  readonly planes: NVSlidePlaneAxes

  constructor(
    private readonly sources: readonly SlideTileSource[],
    { z = 0, zPositionsUm }: { z?: number; zPositionsUm?: number[] } = {},
  ) {
    this.planes = {
      z: sources.length,
      t: 1,
      ...(zPositionsUm?.length === sources.length ? { zPositionsUm } : {}),
    }
    this.manifest = this.manifestOf({ z, t: 0 })
  }

  private manifestOf({ z, t }: NVSlidePlaneIndex): NVSlideManifest {
    const s = this.sources[z]
    if (!s || t !== 0 || !Number.isInteger(z))
      throw new RangeError(
        `plane z${z} t${t} is not in z 0-${this.planes.z - 1}, t 0`,
      )
    // The first manifest made (the initial plane) is the one others must match.
    const why = this.manifest && planeMismatch(this.manifest, s.manifest)
    if (why) throw new RangeError(`plane z${z} differs in ${why}`)
    return onPlane(s.manifest, z)
  }

  private sourceOf(level: NVSlideLevelManifest): SlideTileSource {
    return this.sources[level.plane?.z ?? 0] as SlideTileSource
  }

  async preparePlane(
    p: NVSlidePlaneIndex,
    signal?: AbortSignal,
  ): Promise<NVSlideManifest> {
    signal?.throwIfAborted()
    return this.manifestOf(p)
  }

  bind(host: SlideSourceHost): void {
    for (const s of this.sources) s.bind(host)
  }

  fetchTileBytes(
    level: NVSlideLevelManifest,
    tile: NVSlideTileManifest,
    label: string,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    return this.sourceOf(level).fetchTileBytes(level, tile, label, signal)
  }

  async fetchIccProfile(signal?: AbortSignal): Promise<Uint8Array | null> {
    return (await this.sources[0]?.fetchIccProfile?.(signal)) ?? null
  }

  dispose(): void {
    for (const s of this.sources) s.dispose?.()
  }
}

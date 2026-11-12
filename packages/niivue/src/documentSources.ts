import { log } from '@/logger'
import type NiiVue from '@/NVControlBase'
import type { NVDocumentVolume } from '@/NVDocument'
import type {
  NVImage,
  VolumeFrameSource,
  VolumeSourceDescriptor,
} from '@/NVTypes'
import type { ChunkedVolumeSource } from '@/volume/ChunkedVolumeSource'
import { markVolumeDataChanged } from '@/volume/dataVersion'

/**
 * Reopens a saved {@link VolumeSourceDescriptor} for `loadDocument`. `streamed`
 * asks for a `ChunkedVolumeSource` (the document holds no voxels), otherwise a
 * `VolumeFrameSource` for a volume whose shown frame is embedded. The host adds
 * its credentials here. Return null when the source is unavailable; a superseded
 * restore (`signal` aborted) disposes what it was handed.
 */
export type DocumentSourceResolver = (
  descriptor: VolumeSourceDescriptor,
  context: { signal: AbortSignal; streamed: boolean },
) =>
  | Promise<ChunkedVolumeSource | VolumeFrameSource | null | undefined>
  | ChunkedVolumeSource
  | VolumeFrameSource
  | null
  | undefined

/** Saved lazy-time state of one volume. */
export type NVDocumentSource = {
  descriptor: VolumeSourceDescriptor
  /** The time point shown. */
  frame: number
  /** Volumes with the same number switch frames together. */
  group?: number
}

/**
 * Words of a param name (split at `-`, `_`, `.` and camelCase) that mark a
 * credential; `keyframe` and `design` are whole words of their own and stay.
 */
const CREDENTIAL_WORDS = new Set([
  'token',
  'tokens',
  'secret',
  'signature',
  'sig',
  'credential',
  'credentials',
  'password',
  'passwd',
  'auth',
  'authorization',
  'apikey',
  'accesskey',
  'session',
  'key',
  'jwt',
  'pwd',
  'pass',
  'bearer',
  'cookie',
  'header',
  'hdnts',
  'policy',
  'jsessionid',
  'googleaccessid',
])

/** Whether a param name looks like it carries a credential. */
export function isCredentialParam(name: string): boolean {
  if (/^x-(amz|goog)-/i.test(name)) return true
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
  return (
    CREDENTIAL_WORDS.has(name.toLowerCase()) ||
    words.some((w) => CREDENTIAL_WORDS.has(w))
  )
}

/** `url` without query, fragment, user info or a `;jsessionid=` path param. */
function bareUrl(url: string): string {
  let bare: string
  try {
    const u = new URL(url)
    u.username = ''
    u.password = ''
    u.search = ''
    u.hash = ''
    bare = u.href
  } catch {
    // Not absolute: still drop user info, protocol-relative (`//u:p@h`) too.
    bare = url
      .split(/[?#]/)[0]
      .replace(/^((?:[a-z][a-z0-9+.-]*:)?\/\/)[^/@]*@/i, '$1')
  }
  return bare.replace(/;jsessionid=[^/]*/gi, '')
}

/** A descriptor safe to save: bare URL, primitive non-credential params. */
export function savedDescriptor(
  d: VolumeSourceDescriptor,
): VolumeSourceDescriptor {
  const out: VolumeSourceDescriptor = { kind: d.kind, url: bareUrl(d.url) }
  const params = Object.entries(d.params ?? {}).filter(
    ([k, v]) =>
      !isCredentialParam(k) &&
      // A URL-valued param (protocol-relative too) may itself be signed.
      !(typeof v === 'string' && /:\/\/|^\s*(\/\/|bearer\s)/i.test(v)) &&
      (v === null || ['string', 'number', 'boolean'].includes(typeof v)),
  )
  if (params.length) out.params = Object.fromEntries(params)
  if (typeof d.revision === 'string') out.revision = d.revision
  return out
}

/**
 * The document `source` entry of `v`, one of the saved `volumes`. Frame groups
 * are runtime objects, so a shared one is saved as its first member's index.
 */
export function documentSource(
  v: NVImage,
  volumes: readonly NVImage[],
): NVDocumentSource | undefined {
  const fs = v.frameSource
  if (!fs?.descriptor) return undefined
  const source: NVDocumentSource = {
    descriptor: savedDescriptor({
      ...fs.descriptor,
      revision: fs.descriptor.revision ?? fs.revision,
    }),
    frame: fs.frame,
  }
  const members = volumes.filter(
    (w) => w.frameSource?.descriptor && w.frameSource.group === fs.group,
  )
  if (members.length > 1) source.group = volumes.indexOf(members[0])
  return source
}

/**
 * A document `source` entry checked before the scene is cleared: a malformed
 * one is dropped (warned), a non-numeric frame becomes 0 (warned).
 */
export function checkedSource(
  s: unknown,
  name: string,
): NVDocumentSource | undefined {
  const d = (s as { descriptor?: { kind?: unknown; url?: unknown } } | null)
    ?.descriptor
  if (typeof d?.kind !== 'string' || typeof d.url !== 'string') {
    log.warn(`loadDocument: "${name}" has a malformed source; ignored`)
    return undefined
  }
  const src = s as NVDocumentSource
  if (!Number.isFinite(src.frame)) {
    log.warn(`loadDocument: "${name}" has no usable frame; showing frame 0`)
    return { ...src, frame: 0 }
  }
  return src
}

/** State one `loadDocument` shares across its source restores. */
export interface SourceRestore {
  resolve?: DocumentSourceResolver
  signal: AbortSignal
  groups: Map<number, object>
}

async function open(
  restore: SourceRestore,
  s: NVDocumentSource,
  streamed: boolean,
  name: string,
): Promise<ChunkedVolumeSource | VolumeFrameSource | null> {
  if (!restore.resolve) return null
  const { signal } = restore
  try {
    const opening = Promise.resolve(
      restore.resolve(s.descriptor, { signal, streamed }),
    )
    // A resolver that ignores the signal cannot hold a superseded load, even
    // one that aborted it synchronously.
    const aborted = new Promise<null>((r) =>
      signal.aborted
        ? r(null)
        : signal.addEventListener('abort', () => r(null), { once: true }),
    )
    const src = await Promise.race([opening, aborted])
    if (signal.aborted) {
      // Whatever it opens late is ours to release.
      void opening.then(dispose, () => {})
      return null
    }
    return src ?? null
  } catch (err) {
    if (!signal.aborted)
      log.warn(`loadDocument: source of "${name}" unavailable`, err)
    return null
  }
}

function dispose(
  src: ChunkedVolumeSource | VolumeFrameSource | null | undefined,
) {
  if (src && 'dispose' in src) src.dispose?.()
}

/** Display fields of a saved volume that setVolume restores on a streamed one. */
const DISPLAY_FIELDS = [
  'colormapNegative',
  'isColormapInverted',
  'isNearestInterpolation',
  'atlasOutline',
  'hiddenLabels',
  'selectedLabels',
  'visible',
  'calMinNeg',
  'calMaxNeg',
  'colormapType',
  'modulateAlpha',
  'modulationImage',
  'isColorbarVisible',
  'isLegendVisible',
] as const

function warnRevision(name: string, saved?: string, now?: string): boolean {
  const moved = !!saved && !!now && saved !== now
  if (moved)
    log.warn(
      `loadDocument: source of "${name}" changed since it was saved (revision ${saved} -> ${now})`,
    )
  return moved
}

function groupOf(restore: SourceRestore, s: NVDocumentSource): object {
  if (s.group === undefined) return {}
  let g = restore.groups.get(s.group)
  if (!g) {
    g = {}
    restore.groups.set(s.group, g)
  }
  return g
}

/**
 * Reattach the lazy time of a restored volume whose shown frame was embedded.
 * Without a source (no resolver, offline, null) it stays a static volume
 * showing the embedded frame. When the source's revision moved, the shown
 * frame is fetched again (the embedded one may be stale); if that fails the
 * embedded frame stays.
 */
export async function attachFrameSource(
  vol: NVImage,
  s: NVDocumentSource,
  restore: SourceRestore,
): Promise<void> {
  const name = vol.name ?? 'volume'
  const src = await open(restore, s, false, name)
  if (!src) return
  if ('fetchChunk' in src) {
    log.warn(`loadDocument: source of "${name}" is streamed, expected frames`)
    dispose(src)
    return
  }
  const frame = Math.min(Math.max(0, s.frame), Math.max(1, src.count) - 1)
  if (warnRevision(name, s.descriptor.revision, src.revision) && vol.img) {
    try {
      vol.img.set(await src.load(frame, restore.signal))
      markVolumeDataChanged(vol)
    } catch (err) {
      if (restore.signal.aborted) return
      log.warn(`loadDocument: "${name}" keeps its saved frame`, err)
    }
  }
  if (restore.signal.aborted) return
  const group = groupOf(restore, s)
  vol.frameSource = {
    frame,
    get count() {
      return src.count
    },
    group,
    load: (t, signal) => src.load(t, signal),
    descriptor: s.descriptor,
    get revision() {
      return src.revision
    },
  }
}

/**
 * Reopen a streamed volume (no voxels in the document) through the resolver
 * and show its saved frame and display state. Without a source it is skipped
 * with a warning. Returns the added volume, or null.
 */
export async function restoreStreamedVolume(
  nv: NiiVue,
  v: NVDocumentVolume & { source: NVDocumentSource },
  restore: SourceRestore,
): Promise<NVImage | null> {
  const name = v.name ?? v.source.descriptor.url
  const src = await open(restore, v.source, true, name)
  if (!src || !('fetchChunk' in src)) {
    dispose(src)
    log.warn(`loadDocument: streamed volume "${name}" not restored: no source`)
    return null
  }
  warnRevision(name, v.source.descriptor.revision, src.revision)
  let chunked: Awaited<ReturnType<NiiVue['loadChunkedVolume']>>
  try {
    chunked = await nv.loadChunkedVolume(src, {
      name: v.name,
      id: v.id,
      colormap: v.colormap,
      calMin: v.calMin,
      calMax: v.calMax,
      opacity: v.opacity,
      isTransparentBelowCalMin: v.isTransparentBelowCalMin,
      frame: v.source.frame,
      frameGroup: groupOf(restore, v.source),
      // The descriptor with the source's current revision, for the next save.
      descriptor: { ...v.source.descriptor, revision: src.revision },
    })
  } catch (err) {
    // One volume that cannot open must not cost the document the rest.
    src.dispose?.()
    log.warn(`loadDocument: streamed volume "${name}" not restored`, err)
    return null
  }
  const vol = nv.volumes.find((x) => x.id === chunked.id) ?? null
  if (restore.signal.aborted) {
    chunked.dispose()
    if (vol) await nv.removeVolume(nv.volumes.indexOf(vol))
    src.dispose?.()
    return null
  }
  if (vol) {
    const display: Record<string, unknown> = {}
    for (const key of DISPLAY_FIELDS)
      if (v[key] !== undefined) display[key] = v[key]
    if (Object.keys(display).length)
      await nv.setVolume(nv.volumes.indexOf(vol), display)
  }
  return vol
}

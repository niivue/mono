import * as NVLoader from '@/NVLoader'
import type {
  NVSignal,
  NVSignalDisplay,
  NVSignalRaw,
  SignalSidecar,
} from '@/NVTypes'
import { defaultSignalDisplay } from './processing'
import { fetchSidecar } from './sidecar'

type SignalReader = {
  extensions?: string[]
  read: (
    buffer: ArrayBuffer,
    name?: string,
    sidecar?: SignalSidecar | null,
  ) => Promise<NVSignalRaw>
}

const modules = import.meta.glob<SignalReader>(
  ['./readers/*.ts', '!./readers/*.test.ts'],
  { eager: true },
)
const readerByExt = NVLoader.buildExtensionMap(modules)

export function signalExtensions(): string[] {
  return Array.from(readerByExt.keys()).sort()
}

/**
 * Fetch and parse a signal file into raw data. When `sidecar` is omitted and
 * the input is a URL, the sibling `.json` is fetched automatically; for File
 * inputs the caller supplies the paired sidecar (drag-drop pairing happens at
 * the controller layer).
 */
export async function loadSignalRaw(
  input: string | File,
  sidecar?: SignalSidecar | null,
): Promise<NVSignalRaw> {
  const ext = NVLoader.getFileExt(input)
  const reader = readerByExt.get(ext)
  if (!reader || typeof reader.read !== 'function') {
    throw new Error(`No signal reader available for extension "${ext}"`)
  }
  const buffer = await NVLoader.fetchFile(input)
  let meta = sidecar ?? null
  if (!meta && typeof input === 'string') {
    meta = await fetchSidecar(input)
  }
  return reader.read(buffer, NVLoader.getName(input), meta)
}

/** Options for loading a signal from a URL or File. */
export type SignalFromUrlOptions = {
  url: string | File
  name?: string
  /** force signal-vs-volume routing for ambiguous NIfTI (used by the loader) */
  asSignal?: boolean
  /** pre-resolved sidecar (drag-drop pairing); else fetched for URLs */
  sidecar?: SignalSidecar | null
  /** initial display overrides */
  display?: Partial<NVSignalDisplay>
  /** id of a volume/mesh to associate with */
  attachToId?: string
}

/** Wrap raw signal data into a displayable NVSignal instance. */
export function createSignal(
  raw: NVSignalRaw,
  opts: {
    name: string
    url?: string
    display?: Partial<NVSignalDisplay>
    attachToId?: string
  },
): NVSignal {
  return {
    id: opts.name,
    name: opts.name,
    url: opts.url,
    kind: raw.kind,
    raw,
    display: { ...defaultSignalDisplay(), ...(opts.display ?? {}) },
    attachedToId: opts.attachToId,
  }
}

/** Fetch, parse, and wrap a signal file into an NVSignal. */
export async function loadSignal(
  opts: SignalFromUrlOptions,
): Promise<NVSignal> {
  const raw = await loadSignalRaw(opts.url, opts.sidecar)
  const name = opts.name ?? NVLoader.getName(opts.url)
  const url = typeof opts.url === 'string' ? opts.url : undefined
  return createSignal(raw, {
    name,
    url,
    display: opts.display,
    attachToId: opts.attachToId,
  })
}

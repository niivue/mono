export function getName(
  pathOrFile: string | { name?: string } | null | undefined,
): string {
  if (typeof pathOrFile === 'string') return pathOrFile
  if (pathOrFile && typeof pathOrFile.name === 'string') return pathOrFile.name
  return ''
}

/**
 * Opt an HTMLImageElement into CORS-clean loading. Call BEFORE setting
 * `img.src`. Required for any image that will later be uploaded to a GPU
 * texture: both WebGL2 `texImage2D` and WebGPU `copyExternalImageToTexture`
 * refuse tainted cross-origin bitmaps. Setting the attribute unconditionally
 * is spec-safe: same-origin requests pass regardless, `blob:`/`data:` URLs
 * ignore it, and cross-origin servers must send `Access-Control-Allow-Origin`
 * (standard for CDNs and `raw.githubusercontent.com`).
 */
export function applyCORS(img: HTMLImageElement): void {
  img.crossOrigin = 'anonymous'
}

/**
 * Largest width or height accepted for an image NiiVue decodes for display
 * (thumbnail, matcap, 2D image volume): a few-kilobyte PNG can declare a size
 * that decodes to gigabytes (#385, #511).
 */
export const MAX_IMAGE_SIDE = 8192

/**
 * Load `src` into a CORS-clean image element, refusing it when a side exceeds
 * `MAX_IMAGE_SIDE`. Browsers decode lazily: `load` fires once the size is
 * known, and the pixels are decoded only when drawn or uploaded, so the check
 * runs before the large allocation.
 */
export function loadImageElement(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const { naturalWidth: w, naturalHeight: h } = img
      if (w > MAX_IMAGE_SIDE || h > MAX_IMAGE_SIDE) {
        img.src = ''
        reject(
          new Error(
            `Image ${src.slice(0, 80)} is ${w}x${h}, larger than ${MAX_IMAGE_SIDE} on a side`,
          ),
        )
        return
      }
      resolve(img)
    }
    img.onerror = () =>
      reject(new Error(`Failed to load image ${src.slice(0, 80)}`))
    applyCORS(img)
    img.src = src
  })
}

export function getFileExt(
  pathOrFile: string | { name?: string } | null | undefined,
  upperCase = true,
): string {
  // Strip any URL `?query` / `#fragment` before parsing the extension, else a
  // signed/cache-busted URL like `image.nii.gz?token=...` (or `...#v1`) yields a
  // bogus ext ("GZ?TOKEN..."), breaking format routing for volumes, signals,
  // meshes, tracts, and layers. Only for URL STRINGS — a local File's `.name` can
  // legally contain `#`/`?` on some platforms, so leave it intact.
  const raw = getName(pathOrFile)
  const fullname = typeof pathOrFile === 'string' ? raw.split(/[?#]/)[0] : raw
  if (!fullname) return ''
  const cleanName =
    typeof pathOrFile === 'string'
      ? (fullname.split('?')[0]?.split('#')[0] ?? '')
      : fullname
  const re = /(?:\.([^.]+))?$/
  let ext = re.exec(cleanName)?.[1] ?? ''
  ext = ext.toUpperCase()
  if (ext === 'GZ') {
    // img.trk.gz -> trk
    ext = re.exec(cleanName.slice(0, -3))?.[1] ?? ''
    ext = ext.toUpperCase()
  } else if (ext === 'CBOR') {
    // img.iwi.cbor -> IWI.CBOR
    const endExt = ext
    ext = re.exec(cleanName.slice(0, -5))?.[1] ?? ''
    ext = `${ext.toUpperCase()}.${endExt}`
  }
  return upperCase ? ext : ext.toLowerCase()
}

/** Build an extension → module map from a module registry (`_registry.ts`). */
export function buildExtensionMap<T extends { extensions?: string[] }>(
  modules: Record<string, T>,
  skipSelf?: string,
): Map<string, T> {
  const map = new Map<string, T>()
  for (const [path, mod] of Object.entries(modules)) {
    if (skipSelf && path === skipSelf) continue
    for (const e of mod.extensions ?? []) {
      map.set(e.toUpperCase(), mod)
    }
  }
  return map
}

type ReaderModule<A extends unknown[], R> = {
  extensions?: string[]
  read: (buffer: ArrayBuffer, ...args: A) => R | Promise<R>
}

/** Register `fromExt` as `converter` followed by the built-in reader for `toExt`. */
export function registerConvertedReader<A extends unknown[], R>(
  readerByExt: Map<string, ReaderModule<A, R>>,
  kind: string,
  fromExt: string,
  toExt: string,
  converter: (
    buffer: ArrayBuffer,
  ) => ArrayBuffer | Uint8Array | Promise<ArrayBuffer | Uint8Array>,
): void {
  const targetReader = readerByExt.get(toExt.toUpperCase())
  if (!targetReader) {
    throw new Error(`No built-in ${kind} reader for target format "${toExt}"`)
  }
  readerByExt.set(fromExt.toUpperCase(), {
    extensions: [fromExt.toUpperCase()],
    read: async (buffer, ...args) => {
      const converted = await converter(buffer)
      const ab =
        converted instanceof ArrayBuffer
          ? converted
          : (new Uint8Array(converted).buffer as ArrayBuffer)
      return targetReader.read(ab, ...args)
    },
  })
}

/** Newline-delimited text lines of a binary file; `pos` is the byte after the last line read. */
export class LineReader {
  pos = 0
  readonly bytes: Uint8Array
  constructor(buffer: ArrayBufferLike) {
    this.bytes = new Uint8Array(buffer)
  }
  readLine(skipBlank = true): string {
    const { bytes } = this
    const len = bytes.length
    if (skipBlank) {
      while (this.pos < len && bytes[this.pos] === 10) this.pos++
    }
    const start = this.pos
    while (this.pos < len && bytes[this.pos] !== 10) this.pos++
    this.pos++ // skip EOLN
    return new TextDecoder().decode(bytes.subarray(start, this.pos - 1))
  }
}

export async function fetchFile(input: string | File): Promise<ArrayBuffer> {
  let buf: ArrayBuffer
  if (input instanceof File) {
    // Local file from drag and drop
    buf = await input.arrayBuffer()
  } else {
    // Remote file from server
    const resp = await fetch(input)
    if (!resp.ok) {
      throw new Error(
        `fetchVolume failed to load ${input}: ${resp.status} ${resp.statusText}`,
      )
    }
    buf = await resp.arrayBuffer()
  }
  return buf
}

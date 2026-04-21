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

export function getFileExt(
  pathOrFile: string | { name?: string } | null | undefined,
  upperCase = true,
): string {
  const fullname = getName(pathOrFile)
  if (!fullname) return ''
  const re = /(?:\.([^.]+))?$/
  let ext = re.exec(fullname)?.[1] ?? ''
  ext = ext.toUpperCase()
  if (ext === 'GZ') {
    // img.trk.gz -> trk
    ext = re.exec(fullname.slice(0, -3))?.[1] ?? ''
    ext = ext.toUpperCase()
  } else if (ext === 'CBOR') {
    // img.iwi.cbor -> IWI.CBOR
    const endExt = ext
    ext = re.exec(fullname.slice(0, -5))?.[1] ?? ''
    ext = `${ext.toUpperCase()}.${endExt}`
  }
  return upperCase ? ext : ext.toLowerCase()
}

/** Build an extension → module map from import.meta.glob results. */
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

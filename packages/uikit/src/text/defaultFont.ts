// Loads the bundled default MSDF atlas (Ubuntu, the same asset NiiVue ships) into
// a UIKitFont. Browser-only (createImageBitmap); kept separate from the pure
// font.ts so unit tests and the layout math never touch assets. Vite either
// inlines ubuntu.png as a data: URL or emits it as a hashed asset and rewrites
// the URL; ubuntu.json is inlined.

import ubuntuJson from '../fonts/ubuntu.json'
import { parseFont, type RawFontFile, type UIKitFont } from './font'

/** Decode the bundled Ubuntu atlas and parse its metrics. */
export async function loadDefaultFont(): Promise<UIKitFont> {
  const url = new URL('../fonts/ubuntu.png', import.meta.url).href
  const image = await createImageBitmap(await atlasBlob(url))
  return { metrics: parseFont(ubuntuJson as unknown as RawFontFile), image }
}

// A data: URL is decoded in place rather than fetched, so hosts whose CSP
// connect-src omits data: (Tauri, extensions) can still load the font.
async function atlasBlob(url: string): Promise<Blob> {
  const match = /^data:([^;,]+);base64,(.*)$/.exec(url)
  if (match) {
    const bytes = Uint8Array.from(atob(match[2]), (c) => c.charCodeAt(0))
    return new Blob([bytes], { type: match[1] })
  }
  const res = await fetch(url)
  if (!res.ok)
    throw new Error(`UIKit: failed to load font atlas: ${res.status}`)
  return res.blob()
}

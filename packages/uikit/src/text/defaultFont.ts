// Loads the bundled default MSDF atlas (Ubuntu, the same asset NiiVue ships) into
// a UIKitFont. Browser-only (fetch + createImageBitmap); kept separate from the
// pure font.ts so unit tests and the layout math never touch assets. Vite emits
// ubuntu.png as a hashed asset and rewrites the URL; ubuntu.json is inlined.

import ubuntuJson from '../fonts/ubuntu.json'
import { parseFont, type RawFontFile, type UIKitFont } from './font'

/** Fetch + decode the bundled Ubuntu atlas and parse its metrics. */
export async function loadDefaultFont(): Promise<UIKitFont> {
  const url = new URL('../fonts/ubuntu.png', import.meta.url).href
  const res = await fetch(url)
  if (!res.ok)
    throw new Error(`UIKit: failed to load font atlas: ${res.status}`)
  const image = await createImageBitmap(await res.blob())
  return { metrics: parseFont(ubuntuJson as unknown as RawFontFile), image }
}

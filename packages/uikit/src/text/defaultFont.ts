// Loads the bundled default MSDF atlas (Ubuntu, the same asset NiiVue ships) into
// a UIKitFont. Browser-only (createImageBitmap); kept separate from the pure
// font.ts so unit tests and the layout math never touch assets. Both the PNG and
// the JSON are inlined. The PNG is decoded in memory, not fetched: a fetch of a
// data: URL is governed by CSP connect-src, which hosts such as OHIF restrict.

import ubuntuJson from '../fonts/ubuntu.json'
import ubuntuPng from '../fonts/ubuntu.png?inline'
import {
  dataUrlBytes,
  parseFont,
  type RawFontFile,
  type UIKitFont,
} from './font'

/** Decode the bundled Ubuntu atlas and parse its metrics. */
export async function loadDefaultFont(): Promise<UIKitFont> {
  const image = await createImageBitmap(new Blob([dataUrlBytes(ubuntuPng)]))
  return { metrics: parseFont(ubuntuJson as unknown as RawFontFile), image }
}

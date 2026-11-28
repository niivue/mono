// The bundled Ubuntu MSDF atlas (ASCII plus µ ° ± ² ³), inlined: its
// msdf-atlas-gen metrics and the PNG as a data URL. NiiVue builds its default
// font from these, so there is one copy. Rebuild recipe:
// packages/niivue/notes/fonts.md.

import ubuntuJson from '../fonts/ubuntu.json'
import ubuntuPng from '../fonts/ubuntu.png?inline'
import type { RawFontFile } from './font'

export const UBUNTU_FONT_METRICS = ubuntuJson as unknown as RawFontFile
/** The atlas PNG as a `data:` URL. */
export const UBUNTU_FONT_ATLAS: string = ubuntuPng

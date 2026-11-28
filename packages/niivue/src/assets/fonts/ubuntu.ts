import {
  parseFont,
  UBUNTU_FONT_ATLAS,
  UBUNTU_FONT_METRICS,
} from '@niivue/uikit'
import type { NVFontData } from '@/NVTypes'

// The bundled atlas is uikit's (one copy for both packages).
export const ubuntu: NVFontData = {
  metrics: parseFont(UBUNTU_FONT_METRICS),
  atlasUrl: UBUNTU_FONT_ATLAS,
}

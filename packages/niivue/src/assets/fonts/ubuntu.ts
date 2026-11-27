import { UBUNTU_FONT_ATLAS, UBUNTU_FONT_METRICS } from '@niivue/uikit'
import type { NVFontData } from '@/NVTypes'
import { parseFontMetrics } from '@/view/NVFont'

// The bundled atlas is uikit's (one copy for both packages).
export const ubuntu: NVFontData = {
  metrics: parseFontMetrics(UBUNTU_FONT_METRICS),
  atlasUrl: UBUNTU_FONT_ATLAS,
}

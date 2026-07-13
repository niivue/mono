import type { FC } from 'react'
import { createRoot } from 'react-dom/client'
import niivueExtension from '../src/index'
import type { OhifViewportProps } from '../src/ohif-types'

// Phase-1 proof harness. This is NOT a full OHIF app; it exercises the exact OHIF
// extension contract our package must satisfy: pull the viewport component the way
// OHIF's getViewportModule flow would, then render it with a mock display set (the
// shape OHIF passes a viewport) pointing at a public NIfTI. If NiiVue renders the
// volume here, the extension + viewport + data bridge work end-to-end.

const NIFTI_URL = 'https://niivue.github.io/niivue-demo-images/mni152.nii.gz'

const entry = niivueExtension.getViewportModule({})[0]
if (!entry) {
  throw new Error('getViewportModule returned no viewport')
}
const NiivueViewport = entry.component as unknown as FC<OhifViewportProps>

// A minimal display set, as OHIF would hand a viewport (a NIfTI-URL series).
const mockDisplaySets = [
  {
    displaySetInstanceUID: 'demo-1',
    SeriesDescription: 'MNI152 (mock OHIF display set)',
    url: NIFTI_URL,
  },
]

const container = document.getElementById('root')
if (!container) {
  throw new Error('missing #root')
}

createRoot(container).render(
  <div
    style={{
      position: 'fixed',
      inset: 0,
      display: 'flex',
      flexDirection: 'column',
      background: '#111',
      color: '#ccc',
      font: '13px sans-serif',
    }}
  >
    <div style={{ padding: '8px 12px', borderBottom: '1px solid #333' }}>
      <strong>@niivue/nv-ohif</strong> — NiiVue viewport rendering a mock OHIF
      NIfTI display set (Phase-1 proof)
    </div>
    <div style={{ flex: 1, position: 'relative' }}>
      <NiivueViewport displaySets={mockDisplaySets} viewportId="demo" />
    </div>
  </div>,
)

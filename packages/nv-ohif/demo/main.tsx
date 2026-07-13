import type { FC } from 'react'
import { createRoot } from 'react-dom/client'
import niivueExtension from '../src/index'
import type { OhifDisplaySet, OhifViewportProps } from '../src/ohif-types'

// Phase-1/2 proof harness. This is NOT a full OHIF app; it exercises the exact OHIF
// extension contract our package must satisfy: pull the viewport component the way
// OHIF's getViewportModule flow would, then render it with a mock display set.
//
//   default          -> a NIfTI-URL display set (Phase 1)
//   ?dicom (in URL)  -> a DICOMweb (JPEG-LS) series -> reconstruct P10 + dcm2niix
//                       + NiiVue render (Phase 2). Uses the OHIF public demo series.
//
// Vite bundles the dcm2niix Web Worker + WASM correctly (unlike some webpack setups),
// so ?dicom exercises the full reconstruction -> convert -> render path in-browser.

const NIFTI_URL = 'https://niivue.github.io/niivue-demo-images/mni152.nii.gz'
const SERIES_BASE =
  'https://d14fa38qiwhyfd.cloudfront.net/dicomweb/studies/2.16.840.1.114362.1.11972228.22789312658.616067305.306.2/series/2.16.840.1.114362.1.11972228.22789312658.616067305.306.3'

const entry = niivueExtension.getViewportModule({})[0]
if (!entry) {
  throw new Error('getViewportModule returned no viewport')
}
const NiivueViewport = entry.component as unknown as FC<OhifViewportProps>

const container = document.getElementById('root')
if (!container) {
  throw new Error('missing #root')
}
const root = createRoot(container)

function Frame({
  title,
  displaySets,
  viewportId,
}: {
  title: string
  displaySets: OhifDisplaySet[]
  viewportId: string
}) {
  return (
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
        <strong>@niivue/nv-ohif</strong> — {title}
      </div>
      <div style={{ flex: 1, position: 'relative' }}>
        <NiivueViewport displaySets={displaySets} viewportId={viewportId} />
      </div>
    </div>
  )
}

async function main() {
  if (!location.search.includes('dicom')) {
    root.render(
      <Frame
        title="NiiVue rendering a mock OHIF NIfTI display set (Phase 1)"
        viewportId="demo"
        displaySets={[
          {
            displaySetInstanceUID: 'demo-1',
            SeriesDescription: 'MNI152 (mock OHIF display set)',
            url: NIFTI_URL,
          },
        ]}
      />,
    )
    return
  }

  // Build a DICOMweb display set from the series metadata: one instance per SOP,
  // each with a `wadors:` frames imageId (the shape OHIF hands a viewport).
  const meta = (await fetch(`${SERIES_BASE}/metadata`, {
    headers: { Accept: 'application/dicom+json' },
  }).then((r) => r.json())) as Array<Record<string, { Value?: string[] }>>
  const instances = meta
    .map((m) => m['00080018']?.Value?.[0])
    .filter((sop): sop is string => typeof sop === 'string')
    .map((sop) => ({
      SOPInstanceUID: sop,
      imageId: `wadors:${SERIES_BASE}/instances/${sop}/frames/1`,
    }))

  root.render(
    <Frame
      title={`DICOMweb JPEG-LS series (${instances.length} slices) -> reconstruct + dcm2niix + render (Phase 2)`}
      viewportId="dicom"
      displaySets={[
        {
          displaySetInstanceUID: 'cta',
          SeriesDescription: 'CTA Head and Neck (reconstructed)',
          Modality: 'CT',
          instances,
        },
      ]}
    />,
  )
}

main()

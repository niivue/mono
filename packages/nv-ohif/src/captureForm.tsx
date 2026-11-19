import { type CSSProperties, useState } from 'react'
import type { NiivueViewportEntry } from './niivueRegistry'

// OHIF's Capture opens cornerstone's download form (CornerstoneViewportDownloadForm),
// which refuses a non-cornerstone pane: this is its NiiVue counterpart, saving
// the pane as drawn (canvas resolution, annotations included).

const field: CSSProperties = {
  display: 'flex',
  gap: 8,
  alignItems: 'center',
  margin: '6px 0',
}

function NiivueCaptureForm({
  entry,
  hide,
}: {
  entry: NiivueViewportEntry
  hide?: () => void
}) {
  const [name, setName] = useState('image')
  const [type, setType] = useState<'png' | 'jpg'>('jpg')
  return (
    <div data-cy="niivue-capture-form" style={{ color: '#d1d5db' }}>
      <label style={field}>
        File name
        <input
          data-cy="file-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </label>
      <label style={field}>
        File type
        <select
          data-cy="file-type"
          value={type}
          onChange={(e) => setType(e.target.value as 'png' | 'jpg')}
        >
          <option value="jpg">JPG</option>
          <option value="png">PNG</option>
        </select>
      </label>
      <div style={{ ...field, justifyContent: 'flex-end' }}>
        <button type="button" onClick={() => hide?.()}>
          Cancel
        </button>
        <button
          type="button"
          data-cy="download-btn"
          onClick={() => {
            const file = `${name.trim() || 'image'}.${type}`
            void (entry.slideView
              ? entry.slideView.saveBitmap()
              : entry.nv.saveBitmap(file))
            hide?.()
          }}
        >
          Download
        </button>
      </div>
    </div>
  )
}

/** OHIF's download form for a NiiVue pane; a direct PNG without a modal service. */
export function showCaptureForm(
  entry: NiivueViewportEntry,
  services: Record<string, unknown> | undefined,
): void {
  const modal = services?.uiModalService as
    | { show?: (o: object) => void; hide?: () => void }
    | undefined
  if (!modal?.show) {
    void (entry.slideView
      ? entry.slideView.saveBitmap()
      : entry.nv.saveBitmap('image.png'))
    return
  }
  modal.show({
    content: NiivueCaptureForm,
    title: 'Download High Quality Image',
    contentProps: { entry, hide: () => modal.hide?.() },
    containerClassName: 'max-w-4xl p-4',
  })
}

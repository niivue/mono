import { FileJson, FolderOpen, PackageOpen, X } from 'lucide-react'
import { type JSX, useState } from 'react'

// Shown in the Browse pane while the only dataset is the bundled MNI152
// sample, so a first-run researcher sees how to get their own data in.
// Offers only actions the app has: the same three as the Datasets menu.
// Docked bottom-left so it doesn't cover the sample tile, and dismissible
// for the session since the same actions live in the Datasets menu.
export function OpenDataCard({
  disabled,
  onOpenFolder,
  onOpenFile,
  onOpenBundle,
}: {
  disabled: boolean
  onOpenFolder: () => void
  onOpenFile: () => void
  onOpenBundle: () => void
}): JSX.Element | null {
  const [dismissed, setDismissed] = useState(false)
  if (dismissed) return null
  return (
    <section className="nv-open-data-card" aria-labelledby="nv-open-data-title">
      <button
        aria-label="Dismiss"
        className="nv-open-data-dismiss"
        onClick={() => setDismissed(true)}
        title="Dismiss (open data any time from the Datasets menu)"
        type="button"
      >
        <X aria-hidden="true" size={14} />
      </button>
      <h2 id="nv-open-data-title">Open your data</h2>
      <p>You're looking at the bundled MNI152 template.</p>
      <div className="nv-open-data-actions">
        <button
          className="nv-desktop-only"
          disabled={disabled}
          onClick={onOpenFolder}
          title="Open a folder of NIfTI volumes, such as a BIDS dataset"
          type="button"
        >
          <FolderOpen aria-hidden="true" size={14} />
          Open folder
        </button>
        <button
          disabled={disabled}
          onClick={onOpenFile}
          title="Open a single NIfTI file (.nii or .nii.gz)"
          type="button"
        >
          <FileJson aria-hidden="true" size={14} />
          Open NIfTI file
        </button>
        <button
          disabled={disabled}
          onClick={onOpenBundle}
          title="Open a NeuroVue bundle (.nvbundle) with its saved view"
          type="button"
        >
          <PackageOpen aria-hidden="true" size={14} />
          Open bundle
        </button>
      </div>
    </section>
  )
}

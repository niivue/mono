import {
  Brain,
  FileJson,
  Folder,
  FolderOpen,
  LoaderCircle,
  PackageOpen,
  X,
} from 'lucide-react'
import type { JSX, ReactNode } from 'react'
import { isBundlePath } from '../domain/bundle'
import { recentDatasetLabel } from '../hooks/useRecentDatasets'

// Shown in place of the workbench whenever no dataset is open: at launch
// (unless the last dataset is reopened, as VS Code does with its last
// folder) and after an open that left nothing loaded. While the app is still
// starting or reopening, it shows only what it is waiting on, so a relaunch
// that restores a dataset doesn't flash the full Welcome screen.
export function WelcomeScreen({
  busy,
  openingLabel,
  recentDatasets,
  reopenLast,
  onOpenBundle,
  onOpenFile,
  onOpenFolder,
  onOpenRecent,
  onOpenSample,
  onRemoveRecent,
  onReopenLastChange,
}: {
  busy: boolean
  /** Set while starting up or reopening: what the app is waiting on. */
  openingLabel: string | null
  recentDatasets: readonly string[]
  reopenLast: boolean
  onOpenBundle: () => void
  onOpenFile: () => void
  onOpenFolder: () => void
  onOpenRecent: (path: string) => void
  /** Null when this build ships no sample. */
  onOpenSample: (() => void) | null
  onRemoveRecent: (path: string) => void
  onReopenLastChange: (reopen: boolean) => void
}): JSX.Element {
  if (openingLabel !== null) {
    return (
      <section className="nv-welcome" aria-busy="true" aria-label="Welcome">
        <p className="nv-welcome-opening">
          <LoaderCircle aria-hidden="true" className="nv-spin" size={16} />
          {openingLabel}
        </p>
      </section>
    )
  }

  return (
    <section className="nv-welcome" aria-labelledby="nv-welcome-title">
      <div className="nv-welcome-inner">
        <header className="nv-welcome-header">
          <h2 id="nv-welcome-title">Welcome to NeuroVue</h2>
          <p>Open a NIfTI file or a BIDS dataset folder to start.</p>
        </header>

        <div className="nv-welcome-columns">
          <section aria-labelledby="nv-welcome-start">
            <h3 id="nv-welcome-start">Start</h3>
            <div className="nv-welcome-actions">
              <WelcomeAction
                className="nv-desktop-only"
                disabled={busy}
                hint="A folder of NIfTI volumes, such as a BIDS dataset"
                icon={<FolderOpen aria-hidden="true" size={16} />}
                label="Open folder…"
                onClick={onOpenFolder}
              />
              <WelcomeAction
                disabled={busy}
                hint="A single .nii or .nii.gz volume"
                icon={<FileJson aria-hidden="true" size={16} />}
                label="Open NIfTI file…"
                onClick={onOpenFile}
              />
              <WelcomeAction
                disabled={busy}
                hint="A .nvbundle, with the view it was saved with"
                icon={<PackageOpen aria-hidden="true" size={16} />}
                label="Open bundle…"
                onClick={onOpenBundle}
              />
              {onOpenSample ? (
                <WelcomeAction
                  disabled={busy}
                  hint="The MNI152 template that ships with NeuroVue"
                  icon={<Brain aria-hidden="true" size={16} />}
                  label="Open sample data"
                  onClick={onOpenSample}
                />
              ) : null}
            </div>
          </section>

          <section aria-labelledby="nv-welcome-recent">
            <h3 id="nv-welcome-recent">Recent</h3>
            {recentDatasets.length > 0 ? (
              <ul className="nv-welcome-recents">
                {recentDatasets.map((path) => (
                  <li key={path}>
                    <button
                      className="nv-welcome-recent"
                      disabled={busy}
                      onClick={() => onOpenRecent(path)}
                      title={path}
                      type="button"
                    >
                      <RecentIcon path={path} />
                      <span className="nv-welcome-recent-text">
                        <strong>{recentDatasetLabel(path)}</strong>
                        <small>{path}</small>
                      </span>
                    </button>
                    <button
                      aria-label={`Remove ${path} from recents`}
                      className="nv-welcome-recent-remove"
                      onClick={() => onRemoveRecent(path)}
                      title="Remove from recents"
                      type="button"
                    >
                      <X aria-hidden="true" size={13} />
                    </button>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="nv-welcome-empty">
                Datasets you open will appear here.
              </p>
            )}
          </section>
        </div>

        <label className="nv-welcome-reopen">
          <input
            checked={reopenLast}
            onChange={(event) => onReopenLastChange(event.target.checked)}
            type="checkbox"
          />
          Reopen the last dataset when NeuroVue starts
        </label>
      </div>
    </section>
  )
}

function WelcomeAction({
  className,
  disabled,
  hint,
  icon,
  label,
  onClick,
}: {
  className?: string
  disabled: boolean
  hint: string
  icon: ReactNode
  label: string
  onClick: () => void
}): JSX.Element {
  return (
    <button
      className={`nv-welcome-action ${className ?? ''}`}
      disabled={disabled}
      onClick={onClick}
      type="button"
    >
      {icon}
      <span>
        <strong>{label}</strong>
        <small>{hint}</small>
      </span>
    </button>
  )
}

function RecentIcon({ path }: { path: string }): JSX.Element {
  if (isBundlePath(path)) return <PackageOpen aria-hidden="true" size={15} />
  if (/\.nii(\.gz)?$/i.test(path)) {
    return <FileJson aria-hidden="true" size={15} />
  }
  return <Folder aria-hidden="true" size={15} />
}

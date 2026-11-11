import type { CSSProperties } from 'react'
import {
  type DisplaySetServiceLike,
  NIIVUE_COLORMAPS,
  overlayCandidates,
  overlayOrder,
  overlayVolumeIndex,
} from './commands'
import {
  getActiveNiivueEntry,
  type NiivueViewportEntry,
  ohifCommandsManager,
  ohifServices,
} from './niivueRegistry'
import type { OhifDisplaySet, OhifExtensionParams } from './ohif-types'

export const NIIVUE_OVERLAY_MENU_UI_TYPE = 'niivue.overlayMenu'

function seriesLabel(ds: OhifDisplaySet | undefined, uid: string): string {
  if (ds?.SeriesDescription) return ds.SeriesDescription
  if (ds?.SeriesNumber !== undefined) return `Series ${ds.SeriesNumber}`
  return uid
}

export interface OverlayMenuRow {
  uid: string
  label: string
  visible: boolean
  opacity: number
  colormap: string
  canMoveUp: boolean
  canMoveDown: boolean
}

/**
 * What the overlay menu shows: the loaded overlays, top layer first, and the
 * series that can still be added.
 */
export function overlayMenuState(
  entry: NiivueViewportEntry,
  activeDisplaySets: ReadonlyArray<OhifDisplaySet>,
): {
  overlays: OverlayMenuRow[]
  candidates: Array<{ uid: string; label: string }>
} {
  const byUid = new Map(
    activeDisplaySets.map((ds) => [ds.displaySetInstanceUID, ds]),
  )
  const order = overlayOrder(entry)
  const overlays = order
    .map((uid, i) => {
      const volume = entry.nv.volumes[overlayVolumeIndex(entry, uid)]
      return {
        uid,
        label: seriesLabel(byUid.get(uid), uid),
        visible: volume?.visible !== false,
        opacity: volume?.opacity ?? 1,
        colormap: volume?.colormap ?? 'gray',
        canMoveUp: i < order.length - 1,
        canMoveDown: i > 0,
      }
    })
    .reverse()
  const candidates = overlayCandidates(entry, activeDisplaySets).map((ds) => {
    const uid = String(ds.displaySetInstanceUID)
    return { uid, label: seriesLabel(ds, uid) }
  })
  return { overlays, candidates }
}

// OHIF's theme variables, with dark fallbacks for a host without them.
const PANEL: CSSProperties = {
  position: 'absolute',
  zIndex: 50,
  marginTop: 4,
  padding: 8,
  minWidth: 280,
  borderRadius: 6,
  background: 'hsl(var(--popover, 234 64% 10%))',
  color: 'hsl(var(--popover-foreground, 0 0% 100%))',
  colorScheme: 'dark',
  fontSize: 12,
}
const ROW: CSSProperties = { display: 'flex', gap: 4, alignItems: 'center' }
// OHIF's toolbar buttons (Tailwind h-10 text-base text-foreground/80): an
// unstyled summary is black 16px text on the dark toolbar.
const TRIGGER: CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  height: 40,
  padding: '0 8px',
  border: 'none',
  borderRadius: 8,
  background: 'transparent',
  color: 'hsl(var(--foreground, 0 0% 98%) / 0.8)',
  fontSize: 13,
  cursor: 'pointer',
  whiteSpace: 'nowrap',
}

/**
 * The toolbar's overlay dropdown (`uiType: 'niivue.overlayMenu'`): add a series
 * of the study, and per overlay show/hide, colormap, opacity, order and remove.
 * Acts on the active viewport through the overlay commands, which refresh the
 * toolbar, so OHIF re-renders it with the new state. OHIF passes the button's
 * props, the evaluated `disabled` / `disabledText`, and its open state
 * (`isOpen` / `onOpen` / `onClose`), which closes the menu when another
 * toolbar menu opens. Escape and focus leaving the menu close it too.
 */
export function overlayMenuComponent({
  servicesManager,
  commandsManager,
}: OhifExtensionParams) {
  return function NiivueOverlayMenu({
    label,
    tooltip,
    disabled,
    disabledText,
    isOpen,
    onOpen,
    onClose,
  }: {
    label?: string
    tooltip?: string
    disabled?: boolean
    disabledText?: string
    isOpen?: boolean
    onOpen?: () => void
    onClose?: () => void
  }) {
    const entry = getActiveNiivueEntry(servicesManager)
    if (disabled || !entry)
      return (
        <button
          type="button"
          disabled
          title={disabledText ?? tooltip}
          style={{ ...TRIGGER, cursor: 'default', opacity: 0.5 }}
        >
          {label}
        </button>
      )
    // The menu is enabled only on a NiiVue viewport, so skip the shadowed
    // CORNERSTONE setViewportColormap.
    const run = (name: string, options: Record<string, unknown>) =>
      ohifCommandsManager(commandsManager)?.runCommand?.(
        name,
        options,
        'NIIVUE',
      )
    const dsService = ohifServices(servicesManager)?.displaySetService as
      | DisplaySetServiceLike
      | undefined
    const { overlays, candidates } = overlayMenuState(
      entry,
      dsService?.getActiveDisplaySets?.() ?? [],
    )
    return (
      <details
        style={{ position: 'relative' }}
        open={isOpen}
        onToggle={(e) => {
          const open = e.currentTarget.open
          // React setting `open` from isOpen also fires toggle: report changes only.
          if (open !== isOpen) (open ? onOpen : onClose)?.()
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose?.()
        }}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null))
            onClose?.()
        }}
      >
        <summary title={tooltip} style={TRIGGER}>
          {label}
        </summary>
        <div style={PANEL}>
          <select
            aria-label="Add overlay"
            value=""
            disabled={entry.overlayLoading || candidates.length === 0}
            onChange={(e) =>
              run('niivueAddOverlay', {
                displaySetInstanceUID: e.target.value,
              })
            }
          >
            <option value="">
              {entry.overlayLoading
                ? 'Loading...'
                : candidates.length
                  ? 'Add series...'
                  : 'No other series'}
            </option>
            {candidates.map((c) => (
              <option key={c.uid} value={c.uid}>
                {c.label}
              </option>
            ))}
          </select>
          {overlays.map((o) => {
            const target = { displaySetInstanceUID: o.uid }
            const colormap = o.colormap.toLowerCase()
            return (
              <div key={o.uid} style={ROW}>
                <input
                  type="checkbox"
                  aria-label={`Show ${o.label}`}
                  checked={o.visible}
                  onChange={(e) =>
                    run('niivueSetOverlayVisible', {
                      ...target,
                      visible: e.target.checked,
                    })
                  }
                />
                <span style={{ flex: 1 }}>{o.label}</span>
                <select
                  aria-label={`${o.label} colormap`}
                  value={colormap}
                  onChange={(e) =>
                    run('setViewportColormap', {
                      ...target,
                      colormap: e.target.value,
                    })
                  }
                >
                  {NIIVUE_COLORMAPS.some((c) => c.name === colormap) ? null : (
                    <option value={colormap}>{o.colormap}</option>
                  )}
                  {NIIVUE_COLORMAPS.map((c) => (
                    <option key={c.name} value={c.name}>
                      {c.label}
                    </option>
                  ))}
                </select>
                <input
                  type="range"
                  aria-label={`${o.label} opacity`}
                  min={0}
                  max={1}
                  step={0.05}
                  value={o.opacity}
                  onChange={(e) =>
                    run('setViewportColormap', {
                      ...target,
                      opacity: Number(e.target.value),
                    })
                  }
                />
                <button
                  type="button"
                  aria-label={`Move ${o.label} up`}
                  disabled={!o.canMoveUp}
                  onClick={() =>
                    run('niivueMoveOverlay', { ...target, direction: 'up' })
                  }
                >
                  ↑
                </button>
                <button
                  type="button"
                  aria-label={`Move ${o.label} down`}
                  disabled={!o.canMoveDown}
                  onClick={() =>
                    run('niivueMoveOverlay', { ...target, direction: 'down' })
                  }
                >
                  ↓
                </button>
                <button
                  type="button"
                  aria-label={`Remove ${o.label}`}
                  onClick={() => run('niivueRemoveOverlay', target)}
                >
                  ×
                </button>
              </div>
            )
          })}
        </div>
      </details>
    )
  }
}

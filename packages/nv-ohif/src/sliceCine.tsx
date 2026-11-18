import { useEffect, useState } from 'react'
import { type CineServiceLike, paneFrames } from './frames4D'
import { getNiivueEntry, type NiivueViewportEntry } from './niivueRegistry'
import type { OhifServicesManager } from './ohif-types'
import { scrollImage } from './standardCommands'

// OHIF's Cine (toolbar, `c`) only flips cineService state: cornerstone's own
// viewport draws the player and plays the clip. NiiVue panes not showing a 4D
// series (those step frames, frames4D.ts) get the same player and a slice clip.

type CineService = Omit<CineServiceLike, 'getState'> & {
  getState?: () =>
    | {
        isCineEnabled?: boolean
        cines?: Record<string, { isPlaying?: boolean; frameRate?: number }>
      }
    | undefined
  setIsCineEnabled?: (isCineEnabled: boolean) => void
  subscribe?: (event: string, cb: () => void) => { unsubscribe(): void }
  EVENTS?: { CINE_STATE_CHANGED?: string }
}

/** One image forward; past the last, back to the first (cornerstone's loop). */
export function cineStep(entry: NiivueViewportEntry): void {
  const before = Array.from(entry.nv.crosshairPos).join()
  scrollImage(entry, 1)
  if (Array.from(entry.nv.crosshairPos).join() === before)
    scrollImage(entry, -Number.MAX_SAFE_INTEGER)
}

export function SliceCine({
  viewportId,
  isLoaded,
  servicesManager,
}: {
  viewportId: string
  /** A volume pane with its image shown (not a slide). */
  isLoaded: boolean
  servicesManager: OhifServicesManager | undefined
}) {
  const cine = servicesManager?.services?.cineService as CineService | undefined
  const read = () => {
    const s = cine?.getState?.()
    return { enabled: !!s?.isCineEnabled, ...s?.cines?.[viewportId] }
  }
  const [state, setState] = useState(read)
  // setIsCineEnabled broadcasts; setCine does not, so the player sets both.
  useEffect(() => {
    const sub = cine?.subscribe?.(
      cine.EVENTS?.CINE_STATE_CHANGED ?? 'event::cineStateChanged',
      () => setState(read()),
    )
    return () => sub?.unsubscribe()
  })
  const isPlaying = state.enabled && !!state.isPlaying
  const frameRate = Math.min(50, Math.max(1, state.frameRate ?? 24))
  useEffect(() => {
    if (!isPlaying || !isLoaded) return
    const timer = setInterval(() => {
      const entry = getNiivueEntry(viewportId)
      if (entry && !paneFrames(viewportId)) cineStep(entry)
    }, 1000 / frameRate)
    return () => clearInterval(timer)
  }, [isPlaying, isLoaded, frameRate, viewportId])
  if (!state.enabled || !isLoaded || paneFrames(viewportId)) return null
  const set = (patch: { isPlaying?: boolean; frameRate?: number }) => {
    const next = { isPlaying: !!state.isPlaying, frameRate, ...patch }
    cine?.setCine?.({ id: viewportId, ...next })
    setState({ enabled: true, ...next })
  }
  const button = {
    background: 'none',
    border: 'none',
    color: '#5acce6',
    cursor: 'pointer',
    font: '13px sans-serif',
  }
  return (
    <div
      data-cy="cine-player"
      data-playing={isPlaying || undefined}
      data-fps={frameRate}
      style={{
        position: 'absolute',
        // Above the display menu's button (displayMenu.tsx).
        bottom: 32,
        left: '50%',
        transform: 'translateX(-50%)',
        display: 'flex',
        gap: 6,
        alignItems: 'center',
        padding: '2px 8px',
        borderRadius: 6,
        background: 'rgba(0,0,0,0.6)',
        color: '#ddd',
        font: '12px sans-serif',
      }}
    >
      <button
        type="button"
        style={button}
        aria-label={isPlaying ? 'Pause' : 'Play'}
        onClick={() => set({ isPlaying: !isPlaying })}
      >
        {isPlaying ? 'Pause' : 'Play'}
      </button>
      <button
        type="button"
        style={button}
        aria-label="Slower"
        onClick={() => set({ frameRate: Math.max(1, frameRate - 1) })}
      >
        -
      </button>
      <span>{frameRate} FPS</span>
      <button
        type="button"
        style={button}
        aria-label="Faster"
        onClick={() => set({ frameRate: Math.min(50, frameRate + 1) })}
      >
        +
      </button>
      <button
        type="button"
        style={button}
        aria-label="Close"
        onClick={() => {
          cine?.setCine?.({ id: viewportId, isPlaying: false })
          cine?.setIsCineEnabled?.(false)
        }}
      >
        x
      </button>
    </div>
  )
}

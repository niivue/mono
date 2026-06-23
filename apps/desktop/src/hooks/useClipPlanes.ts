import { useState } from 'react'
import { type ClipPlane, defaultClipPlanes } from '../domain/desktop'

export type RenderWheelMode = 'zoom' | 'clip-plane'

export interface ClipPlanesState {
  clipPlanes: ClipPlane[]
  activeClipPlaneId: string
  renderWheelMode: RenderWheelMode
  /** The active plane (or the first as a fallback). */
  activeClipPlane: ClipPlane | undefined
  setRenderWheelMode: (mode: RenderWheelMode) => void
  /** Make `planeId` the wheel-controlled plane (and switch to clip-plane mode). */
  bindActiveClipPlane: (planeId: string) => void
  /** Replace a plane's settings (and bind it as active). */
  updateClipPlane: (plane: ClipPlane) => void
  /** Set just a plane's depth (used by the render wheel). */
  changeClipPlaneDepth: (planeId: string, depth: number) => void
  /** Restore the default clip planes. */
  resetClipPlanes: () => void
}

/** Owns clip-plane state shared by the controls panel and the NiiVue stage. */
export function useClipPlanes(): ClipPlanesState {
  const [clipPlanes, setClipPlanes] = useState(defaultClipPlanes)
  // Empty until a clip plane is selected — the wheel starts bound to zoom, so no
  // plane should read as the wheel's target on first load.
  const [activeClipPlaneId, setActiveClipPlaneId] = useState('')
  const [renderWheelMode, setRenderWheelMode] = useState<RenderWheelMode>('zoom')

  const activeClipPlane = clipPlanes.find((plane) => plane.id === activeClipPlaneId) ?? clipPlanes[0]

  function bindActiveClipPlane(planeId: string): void {
    setActiveClipPlaneId(planeId)
    setRenderWheelMode('clip-plane')
  }

  function changeClipPlaneDepth(planeId: string, depth: number): void {
    setClipPlanes((planes) =>
      planes.map((plane) => (plane.id === planeId ? { ...plane, depth } : plane))
    )
  }

  function updateClipPlane(plane: ClipPlane): void {
    bindActiveClipPlane(plane.id)
    setClipPlanes((planes) =>
      planes.map((candidate) => (candidate.id === plane.id ? plane : candidate))
    )
  }

  function resetClipPlanes(): void {
    setClipPlanes(defaultClipPlanes())
  }

  return {
    clipPlanes,
    activeClipPlaneId,
    renderWheelMode,
    activeClipPlane,
    setRenderWheelMode,
    bindActiveClipPlane,
    updateClipPlane,
    changeClipPlaneDepth,
    resetClipPlanes
  }
}

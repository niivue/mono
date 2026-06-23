import { useState } from 'react'

const TERMINAL_OPEN_KEY = 'neurovue.terminalOpen.v1'
const TERMINAL_HEIGHT_KEY = 'neurovue.terminalHeight.v1'
const MIN_TERMINAL_HEIGHT = 120
const MAX_TERMINAL_HEIGHT = 800
const DEFAULT_TERMINAL_HEIGHT = 280

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max)
}

function loadTerminalOpen(): boolean {
  try {
    return window.localStorage.getItem(TERMINAL_OPEN_KEY) === '1'
  } catch {
    return false
  }
}

function loadTerminalHeight(): number {
  try {
    const raw = Number(window.localStorage.getItem(TERMINAL_HEIGHT_KEY))
    if (Number.isFinite(raw) && raw > 0) {
      return clamp(raw, MIN_TERMINAL_HEIGHT, MAX_TERMINAL_HEIGHT)
    }
  } catch {
    // fall through to default
  }
  return DEFAULT_TERMINAL_HEIGHT
}

function persistTerminalOpen(open: boolean): void {
  try {
    window.localStorage.setItem(TERMINAL_OPEN_KEY, open ? '1' : '0')
  } catch {
    // localStorage may be disabled — state stays in-memory for this session.
  }
}

function persistTerminalHeight(height: number): void {
  try {
    window.localStorage.setItem(TERMINAL_HEIGHT_KEY, String(Math.round(height)))
  } catch {
    // localStorage may be disabled.
  }
}

export interface TerminalDock {
  isTerminalOpen: boolean
  terminalHeight: number
  toggleTerminal: () => void
  /** Set the dock height, clamped to the allowed range, and persist it. */
  setTerminalHeight: (height: number) => void
}

/** Owns the integrated terminal dock's open state and persisted height. */
export function useTerminalDock(): TerminalDock {
  const [isTerminalOpen, setIsTerminalOpen] = useState<boolean>(() => loadTerminalOpen())
  const [terminalHeight, setHeight] = useState<number>(() => loadTerminalHeight())

  function toggleTerminal(): void {
    setIsTerminalOpen((open) => {
      const next = !open
      persistTerminalOpen(next)
      return next
    })
  }

  function setTerminalHeight(height: number): void {
    const clamped = clamp(height, MIN_TERMINAL_HEIGHT, MAX_TERMINAL_HEIGHT)
    setHeight(clamped)
    persistTerminalHeight(clamped)
  }

  return { isTerminalOpen, terminalHeight, toggleTerminal, setTerminalHeight }
}

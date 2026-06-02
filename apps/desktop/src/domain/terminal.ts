import { invoke } from '@tauri-apps/api/core'
import { open } from '@tauri-apps/plugin-dialog'

export type InterpreterSource = 'path' | 'venv' | 'pyenv' | 'conda' | 'manual'

export interface PythonInterpreter {
  path: string
  version: string
  label: string
  source: InterpreterSource
}

export interface TerminalStartOptions {
  interpreterPath?: string
  rows?: number
  cols?: number
}

export interface TerminalChunk {
  id: string
  data: number[]
}

export interface TerminalExit {
  id: string
}

export function discoverPythonInterpreters(): Promise<PythonInterpreter[]> {
  return invoke<PythonInterpreter[]>('discover_python_interpreters')
}

/**
 * Open the OS-native file dialog (cross-platform via the Tauri dialog plugin) to
 * choose a Python interpreter, then validate it in the backend. Returns null if
 * the user cancels.
 */
export async function pickPythonInterpreter(): Promise<PythonInterpreter | null> {
  const selected = await open({
    multiple: false,
    directory: false,
    title: 'Select a Python interpreter'
  })
  if (!selected || Array.isArray(selected)) return null
  return invoke<PythonInterpreter>('inspect_python_interpreter', { path: selected })
}

export function startTerminal(options: TerminalStartOptions): Promise<string> {
  return invoke<string>('terminal_start', { options })
}

export function writeTerminal(id: string, data: string): Promise<void> {
  return invoke('terminal_write', { id, data })
}

export function resizeTerminal(id: string, rows: number, cols: number): Promise<void> {
  return invoke('terminal_resize', { id, rows, cols })
}

export function killTerminal(id: string): Promise<void> {
  return invoke('terminal_kill', { id })
}

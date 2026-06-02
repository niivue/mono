import { useEffect, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { RotateCcw, Trash2, ChevronDown, FolderSearch } from 'lucide-react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import {
  discoverPythonInterpreters,
  killTerminal,
  pickPythonInterpreter,
  resizeTerminal,
  startTerminal,
  writeTerminal,
  type PythonInterpreter,
  type TerminalChunk,
  type TerminalExit
} from '../domain/terminal'

const INTERPRETER_KEY = 'neurovue.pythonInterpreter.v1'
const BROWSE_VALUE = '__browse__'

const TERMINAL_THEME = {
  background: '#12130f',
  foreground: '#e7e3d4',
  cursor: '#d7a642',
  selectionBackground: 'rgba(215, 166, 66, 0.35)'
}

function loadPersistedInterpreter(): string {
  try {
    return window.localStorage.getItem(INTERPRETER_KEY) ?? ''
  } catch {
    return ''
  }
}

function persistInterpreter(path: string): void {
  try {
    if (path) {
      window.localStorage.setItem(INTERPRETER_KEY, path)
    } else {
      window.localStorage.removeItem(INTERPRETER_KEY)
    }
  } catch {
    // localStorage may be disabled — the selection just won't survive a reload.
  }
}

export function TerminalPanel({
  datasetRoot,
  onStatus
}: {
  datasetRoot: string
  onStatus?: (message: string) => void
}): JSX.Element {
  const containerRef = useRef<HTMLDivElement | null>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const interpreterRef = useRef<string>(loadPersistedInterpreter())

  const [interpreters, setInterpreters] = useState<PythonInterpreter[]>([])
  const [selectedPath, setSelectedPath] = useState<string>(interpreterRef.current)
  const [isTermReady, setIsTermReady] = useState(false)

  useEffect(() => {
    interpreterRef.current = selectedPath
  }, [selectedPath])

  // Create the xterm instance once and route backend output / input through it.
  useEffect(() => {
    const container = containerRef.current
    if (!container) return

    const term = new Terminal({
      fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
      fontSize: 13,
      cursorBlink: true,
      theme: TERMINAL_THEME,
      allowProposedApi: true
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)
    fit.fit()
    termRef.current = term
    fitRef.current = fit

    const disposeData = term.onData((data) => {
      const id = sessionIdRef.current
      if (id) void writeTerminal(id, data)
    })
    const disposeResize = term.onResize(({ cols, rows }) => {
      const id = sessionIdRef.current
      if (id) void resizeTerminal(id, rows, cols)
    })

    const observer = new ResizeObserver(() => {
      try {
        fit.fit()
      } catch {
        // fit() can throw when the dock is mid-collapse with zero height — ignore.
      }
    })
    observer.observe(container)

    let unlistenData: (() => void) | null = null
    let unlistenExit: (() => void) | null = null
    void listen<TerminalChunk>('terminal://data', (event) => {
      if (event.payload.id !== sessionIdRef.current) return
      term.write(new Uint8Array(event.payload.data))
    }).then((fn) => {
      unlistenData = fn
    })
    void listen<TerminalExit>('terminal://exit', (event) => {
      if (event.payload.id !== sessionIdRef.current) return
      term.writeln('\r\n\x1b[90m[process exited]\x1b[0m')
      sessionIdRef.current = null
    }).then((fn) => {
      unlistenExit = fn
    })

    setIsTermReady(true)

    return () => {
      disposeData.dispose()
      disposeResize.dispose()
      observer.disconnect()
      unlistenData?.()
      unlistenExit?.()
      const id = sessionIdRef.current
      if (id) void killTerminal(id)
      sessionIdRef.current = null
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [])

  // Discover available interpreters for the dropdown (does not auto-restart the shell).
  useEffect(() => {
    let cancelled = false
    void discoverPythonInterpreters()
      .then((found) => {
        if (!cancelled) setInterpreters(found)
      })
      .catch((error) => {
        onStatus?.(error instanceof Error ? error.message : String(error))
      })
    return () => {
      cancelled = true
    }
  }, [onStatus])

  // Start (or restart) the shell session whenever the terminal is ready or the
  // selected interpreter changes. Restarting on a fresh dataset keeps cwd correct.
  useEffect(() => {
    if (!isTermReady) return
    const term = termRef.current
    const fit = fitRef.current
    if (!term || !fit) return

    let cancelled = false

    const restart = async (): Promise<void> => {
      const previous = sessionIdRef.current
      if (previous) {
        sessionIdRef.current = null
        await killTerminal(previous).catch(() => undefined)
      }
      if (cancelled) return
      try {
        fit.fit()
      } catch {
        // ignore zero-size fit
      }
      term.reset()
      try {
        const id = await startTerminal({
          interpreterPath: interpreterRef.current || undefined,
          rows: term.rows,
          cols: term.cols
        })
        if (cancelled) {
          void killTerminal(id)
          return
        }
        sessionIdRef.current = id
        term.focus()
      } catch (error) {
        term.writeln(
          `\r\n\x1b[31m${error instanceof Error ? error.message : String(error)}\x1b[0m`
        )
      }
    }

    void restart()
    return () => {
      cancelled = true
    }
  }, [isTermReady, selectedPath, datasetRoot])

  async function handleSelectChange(value: string): Promise<void> {
    if (value === BROWSE_VALUE) {
      try {
        const picked = await pickPythonInterpreter()
        if (!picked) return
        setInterpreters((current) =>
          current.some((entry) => entry.path === picked.path) ? current : [picked, ...current]
        )
        persistInterpreter(picked.path)
        setSelectedPath(picked.path)
      } catch (error) {
        onStatus?.(error instanceof Error ? error.message : String(error))
      }
      return
    }
    persistInterpreter(value)
    setSelectedPath(value)
  }

  function restartSession(): void {
    const term = termRef.current
    if (!term) return
    const previous = sessionIdRef.current
    sessionIdRef.current = null
    if (previous) void killTerminal(previous)
    term.reset()
    try {
      fitRef.current?.fit()
    } catch {
      // ignore zero-size fit
    }
    void startTerminal({
      interpreterPath: interpreterRef.current || undefined,
      rows: term.rows,
      cols: term.cols
    })
      .then((id) => {
        sessionIdRef.current = id
        term.focus()
      })
      .catch((error) => {
        term.writeln(
          `\r\n\x1b[31m${error instanceof Error ? error.message : String(error)}\x1b[0m`
        )
      })
  }

  function killSession(): void {
    const id = sessionIdRef.current
    if (id) {
      void killTerminal(id)
      sessionIdRef.current = null
    }
    termRef.current?.writeln('\r\n\x1b[90m[terminated]\x1b[0m')
  }

  const hasSelectedOption = !selectedPath || interpreters.some((entry) => entry.path === selectedPath)

  return (
    <div className="nv-terminal-panel">
      <div className="nv-terminal-toolbar">
        <label className="nv-select nv-terminal-interpreter">
          <span>Python</span>
          <select value={selectedPath} onChange={(event) => void handleSelectChange(event.target.value)}>
            <option value="">System default (PATH)</option>
            {!hasSelectedOption ? <option value={selectedPath}>{selectedPath}</option> : null}
            {interpreters.map((interpreter) => (
              <option key={interpreter.path} value={interpreter.path}>
                {interpreter.label}
              </option>
            ))}
            <option value={BROWSE_VALUE}>Browse…</option>
          </select>
          <ChevronDown size={14} />
        </label>

        <div className="nv-terminal-actions">
          <button
            className="nv-icon-button"
            onClick={() => void handleSelectChange(BROWSE_VALUE)}
            title="Browse for a Python interpreter"
            type="button"
          >
            <FolderSearch size={15} />
          </button>
          <button
            className="nv-icon-button"
            onClick={restartSession}
            title="Restart terminal"
            type="button"
          >
            <RotateCcw size={15} />
          </button>
          <button
            className="nv-icon-button"
            onClick={killSession}
            title="Kill terminal"
            type="button"
          >
            <Trash2 size={15} />
          </button>
        </div>
      </div>

      <div className="nv-terminal-body" ref={containerRef} />
    </div>
  )
}

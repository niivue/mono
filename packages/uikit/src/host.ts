// Host bridges for the browser-only work a canvas widget cannot do itself:
// opening the file chooser, saving a download and reaching the clipboard. A
// widget keeps its
// affordance and state on the canvas and calls one of these, so a host that
// is not a browser (a test, an Electron shell, a native wrapper) can supply
// its own. The browser implementations here take the DOM as a parameter so
// they can be exercised without one.

/** What a file picker asks the host for, mirroring `<input type="file">`. */
export interface FilePickerOptions {
  /** Comma-separated extensions or MIME types, as the `accept` attribute. */
  accept?: string
  multiple?: boolean
  /** Pick a directory (every file inside it) instead of files. */
  directory?: boolean
}

/**
 * Open the host's file chooser and resolve with the files picked, or with an
 * empty array when the user cancels. Call it synchronously from a pointer or
 * key handler: browsers only open a chooser inside a user activation.
 */
export type FilePickerBridge = (options: FilePickerOptions) => Promise<File[]>

/** Save a blob to the host under a file name (a browser "download"). */
export type DownloadBridge = (blob: Blob, filename: string) => void

/** The subset of a Document the browser file picker uses. */
export interface FilePickerDocument {
  createElement(tagName: 'input'): HTMLInputElement
  body: Pick<HTMLElement, 'appendChild' | 'removeChild'>
}

/** The subset of a Window the browser bridges use: timers and focus. */
export interface BridgeWindow {
  setTimeout(handler: () => void, ms: number): number
  clearTimeout(id: number): void
  addEventListener(type: 'focus', listener: () => void): void
  removeEventListener(type: 'focus', listener: () => void): void
}

/**
 * How long after the window regains focus a chooser with neither a `change`
 * nor a `cancel` event counts as cancelled. A pick's `change` can trail the
 * focus, so this leaves it room.
 */
export const FILE_PICKER_CANCEL_GRACE_MS = 1000

/**
 * How long a download keeps its object URL: revoking it in the tick that
 * clicks the anchor can cancel the download before it starts.
 */
export const DOWNLOAD_REVOKE_DELAY_MS = 40_000

/**
 * A file picker that drives a hidden `<input type="file">`. The input is
 * attached to the body while the chooser is open (some browsers ignore a
 * detached input) and removed once it settles. Cancelling resolves to an
 * empty array through the input's `cancel` event or, where there is none
 * (Safari before 16.4, Chrome before 113), once the window has had focus
 * back for `FILE_PICKER_CANCEL_GRACE_MS` with no pick. `directory` sets
 * `webkitdirectory`, which every current engine honours.
 */
export function createBrowserFilePicker(
  doc: FilePickerDocument = document,
  win: BridgeWindow = window,
): FilePickerBridge {
  return (options) =>
    new Promise<File[]>((resolve) => {
      const input = doc.createElement('input')
      input.type = 'file'
      if (options.accept) input.accept = options.accept
      input.multiple = options.multiple === true
      if (options.directory) input.webkitdirectory = true
      input.style.display = 'none'
      let settled = false
      let timer: number | null = null
      const settle = (files: File[]) => {
        if (settled) return
        settled = true
        input.removeEventListener('change', onChange)
        input.removeEventListener('cancel', onCancel)
        win.removeEventListener('focus', onFocus)
        if (timer !== null) win.clearTimeout(timer)
        doc.body.removeChild(input)
        resolve(files)
      }
      const onChange = () => settle(input.files ? [...input.files] : [])
      const onCancel = () => settle([])
      const onFocus = () => {
        if (timer !== null) win.clearTimeout(timer)
        timer = win.setTimeout(onChange, FILE_PICKER_CANCEL_GRACE_MS)
      }
      input.addEventListener('change', onChange)
      input.addEventListener('cancel', onCancel)
      win.addEventListener('focus', onFocus)
      doc.body.appendChild(input)
      input.click()
    })
}

/** The subset of a Document and URL the browser download uses. */
export interface DownloadDocument {
  createElement(tagName: 'a'): HTMLAnchorElement
  body: Pick<HTMLElement, 'appendChild' | 'removeChild'>
}
export interface DownloadUrlFactory {
  createObjectURL(blob: Blob): string
  revokeObjectURL(url: string): void
}

/**
 * A download that clicks a temporary anchor with a `download` name over an
 * object URL of the blob, then revokes the URL `DOWNLOAD_REVOKE_DELAY_MS`
 * later.
 */
export function createBrowserDownload(
  doc: DownloadDocument = document,
  urls: DownloadUrlFactory = URL,
  win: Pick<BridgeWindow, 'setTimeout'> = window,
): DownloadBridge {
  return (blob, filename) => {
    const url = urls.createObjectURL(blob)
    const a = doc.createElement('a')
    a.href = url
    a.download = filename
    a.style.display = 'none'
    doc.body.appendChild(a)
    try {
      a.click()
    } finally {
      doc.body.removeChild(a)
      win.setTimeout(() => urls.revokeObjectURL(url), DOWNLOAD_REVOKE_DELAY_MS)
    }
  }
}

/** A `.ext` list or MIME list from file extensions, for `FilePickerOptions.accept`. */
export function acceptExtensions(extensions: readonly string[]): string {
  return extensions.map((e) => (e.startsWith('.') ? e : `.${e}`)).join(',')
}

/**
 * The clipboard a text widget copies to and pastes from. `write` puts text
 * on it; `read` resolves with its text, or with an empty string when it
 * holds none or the host refuses. Browsers grant both only inside a user
 * activation, so the widgets call them synchronously from a key handler.
 */
export interface ClipboardBridge {
  write(text: string): void
  read(): Promise<string>
}

/** The subset of `navigator.clipboard` the browser clipboard bridge uses. */
export interface ClipboardSource {
  readText(): Promise<string>
  writeText(text: string): Promise<void>
}

/**
 * A clipboard bridge over the async clipboard API. Without a source (an
 * insecure context, or no navigator) writes are dropped and reads resolve
 * empty; a refused read also resolves empty.
 */
export function createBrowserClipboard(
  source: ClipboardSource | undefined = globalThis.navigator?.clipboard,
): ClipboardBridge {
  return {
    write(text) {
      if (!source) return
      try {
        source.writeText(text).catch(() => undefined)
      } catch {
        // The host refused; the copy is lost, nothing else changes.
      }
    },
    async read() {
      if (!source) return ''
      try {
        return await source.readText()
      } catch {
        return ''
      }
    },
  }
}

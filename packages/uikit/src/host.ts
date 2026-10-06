// Host bridges for the browser-only work a canvas widget cannot do itself:
// opening the file chooser and saving a download. A widget keeps its
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

/**
 * A file picker that drives a hidden `<input type="file">`. The input is
 * attached to the body while the chooser is open (some browsers ignore a
 * detached input) and removed once it settles. Cancelling resolves to an
 * empty array through the input's `cancel` event; `directory` sets
 * `webkitdirectory`, which every current engine honours.
 */
export function createBrowserFilePicker(
  doc: FilePickerDocument = document,
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
      const settle = (files: File[]) => {
        if (settled) return
        settled = true
        input.removeEventListener('change', onChange)
        input.removeEventListener('cancel', onCancel)
        doc.body.removeChild(input)
        resolve(files)
      }
      const onChange = () => settle(input.files ? [...input.files] : [])
      const onCancel = () => settle([])
      input.addEventListener('change', onChange)
      input.addEventListener('cancel', onCancel)
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
 * object URL of the blob, then revokes the URL.
 */
export function createBrowserDownload(
  doc: DownloadDocument = document,
  urls: DownloadUrlFactory = URL,
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
      urls.revokeObjectURL(url)
    }
  }
}

/** A `.ext` list or MIME list from file extensions, for `FilePickerOptions.accept`. */
export function acceptExtensions(extensions: readonly string[]): string {
  return extensions.map((e) => (e.startsWith('.') ? e : `.${e}`)).join(',')
}

import { describe, expect, it } from 'bun:test'
import {
  acceptExtensions,
  type ClipboardSource,
  createBrowserClipboard,
  createBrowserDownload,
  createBrowserFilePicker,
  DOWNLOAD_REVOKE_DELAY_MS,
  type DownloadDocument,
  FILE_PICKER_CANCEL_GRACE_MS,
  type FilePickerDocument,
} from './host'

// The bridges take the DOM as a parameter, so a stub document stands in for
// the hidden input and the temporary anchor.
type Listener = () => void

function stubInput() {
  const listeners = new Map<string, Listener>()
  const input = {
    type: '',
    accept: '',
    multiple: false,
    webkitdirectory: false,
    style: { display: '' },
    files: null as File[] | null,
    clicks: 0,
    addEventListener(name: string, fn: Listener) {
      listeners.set(name, fn)
    },
    removeEventListener(name: string) {
      listeners.delete(name)
    },
    click() {
      this.clicks++
    },
    fire(name: string) {
      listeners.get(name)?.()
    },
    get listenerCount() {
      return listeners.size
    },
  }
  return input
}

function stubDocument(input: ReturnType<typeof stubInput>) {
  const attached: unknown[] = []
  const doc: FilePickerDocument = {
    createElement: () => input as unknown as HTMLInputElement,
    body: {
      appendChild: (n: Node) => {
        attached.push(n)
        return n
      },
      removeChild: (n: Node) => {
        attached.splice(attached.indexOf(n), 1)
        return n
      },
    } as unknown as FilePickerDocument['body'],
  }
  return { doc, attached }
}

/** A window whose timers run only when the test advances its clock. */
function stubWindow() {
  let now = 0
  let nextId = 1
  const timers = new Map<number, { at: number; fn: () => void }>()
  const focus = new Set<Listener>()
  return {
    setTimeout(fn: () => void, ms: number) {
      timers.set(nextId, { at: now + ms, fn })
      return nextId++
    },
    clearTimeout(id: number) {
      timers.delete(id)
    },
    addEventListener(_type: 'focus', fn: Listener) {
      focus.add(fn)
    },
    removeEventListener(_type: 'focus', fn: Listener) {
      focus.delete(fn)
    },
    focus() {
      for (const fn of focus) fn()
    },
    advance(ms: number) {
      now += ms
      for (const [id, t] of [...timers]) {
        if (t.at > now) continue
        timers.delete(id)
        t.fn()
      }
    },
    get pending() {
      return timers.size + focus.size
    },
  }
}

describe('createBrowserFilePicker', () => {
  it('configures and clicks a hidden input, then resolves with the chosen files', async () => {
    const input = stubInput()
    const { doc, attached } = stubDocument(input)
    const win = stubWindow()
    const pick = createBrowserFilePicker(doc, win)
    const promise = pick({ accept: '.nii,.nii.gz', multiple: true })
    expect(input.type).toBe('file')
    expect(input.accept).toBe('.nii,.nii.gz')
    expect(input.multiple).toBe(true)
    expect(input.webkitdirectory).toBe(false)
    expect(input.style.display).toBe('none')
    expect(input.clicks).toBe(1)
    expect(attached).toHaveLength(1)
    input.files = [new File(['x'], 'a.nii'), new File(['y'], 'b.nii')]
    input.fire('change')
    const files = await promise
    expect(files.map((f) => f.name)).toEqual(['a.nii', 'b.nii'])
    expect(attached).toHaveLength(0)
    expect(input.listenerCount).toBe(0)
    expect(win.pending).toBe(0)
  })

  it('resolves empty on cancel and asks for a directory when told to', async () => {
    const input = stubInput()
    const { doc } = stubDocument(input)
    const promise = createBrowserFilePicker(
      doc,
      stubWindow(),
    )({
      directory: true,
    })
    expect(input.webkitdirectory).toBe(true)
    input.fire('cancel')
    expect(await promise).toEqual([])
    // A late change after settling is ignored.
    input.files = [new File(['x'], 'late.nii')]
    input.fire('change')
    expect(await promise).toEqual([])
  })

  it('counts focus back with no pick as a cancel where there is no cancel event', async () => {
    const input = stubInput()
    const { doc, attached } = stubDocument(input)
    const win = stubWindow()
    const got: { files: File[] | null } = { files: null }
    createBrowserFilePicker(
      doc,
      win,
    )({}).then((files) => {
      got.files = files
    })
    win.focus()
    win.advance(FILE_PICKER_CANCEL_GRACE_MS - 1)
    await Promise.resolve()
    expect(got.files).toBeNull()
    win.advance(1)
    await Promise.resolve()
    expect(got.files).toEqual([])
    expect(attached).toHaveLength(0)
    expect(input.listenerCount).toBe(0)
    expect(win.pending).toBe(0)
  })

  it('takes a pick whose change trails the focus, or arrives within the grace', async () => {
    const input = stubInput()
    const { doc } = stubDocument(input)
    const win = stubWindow()
    const early = createBrowserFilePicker(doc, win)({})
    win.focus()
    input.files = [new File(['x'], 'a.nii')]
    input.fire('change')
    expect((await early).map((f) => f.name)).toEqual(['a.nii'])
    expect(win.pending).toBe(0)
    // Files already on the input when the grace runs out count as picked.
    const late = createBrowserFilePicker(doc, win)({})
    input.files = [new File(['y'], 'b.nii')]
    win.focus()
    win.advance(FILE_PICKER_CANCEL_GRACE_MS)
    expect((await late).map((f) => f.name)).toEqual(['b.nii'])
  })
})

describe('createBrowserDownload', () => {
  it('clicks a temporary anchor over an object URL and revokes it', () => {
    const anchor = {
      href: '',
      download: '',
      style: { display: '' },
      clicks: 0,
      click() {
        anchor.clicks++
      },
    }
    const attached: unknown[] = []
    const urls: string[] = []
    const revoked: string[] = []
    const doc: DownloadDocument = {
      createElement: () => anchor as unknown as HTMLAnchorElement,
      body: {
        appendChild: (n: Node) => {
          attached.push(n)
          return n
        },
        removeChild: (n: Node) => {
          attached.splice(attached.indexOf(n), 1)
          return n
        },
      } as unknown as DownloadDocument['body'],
    }
    const win = stubWindow()
    const download = createBrowserDownload(
      doc,
      {
        createObjectURL: () => {
          urls.push('blob:1')
          return 'blob:1'
        },
        revokeObjectURL: (u) => {
          revoked.push(u)
        },
      },
      win,
    )
    download(new Blob(['{}'], { type: 'application/json' }), 'scene.json')
    expect(anchor.clicks).toBe(1)
    expect(anchor.href).toBe('blob:1')
    expect(anchor.download).toBe('scene.json')
    expect(attached).toHaveLength(0)
    // The URL outlives the click, so the download can start before it goes.
    expect(revoked).toEqual([])
    win.advance(DOWNLOAD_REVOKE_DELAY_MS)
    expect(revoked).toEqual(['blob:1'])
  })
})

describe('acceptExtensions', () => {
  it('joins extensions with a leading dot each', () => {
    expect(acceptExtensions(['nii', '.nii.gz', 'mgz'])).toBe(
      '.nii,.nii.gz,.mgz',
    )
  })
})

describe('createBrowserClipboard', () => {
  it('forwards writes and reads to the async clipboard', async () => {
    const written: string[] = []
    const source: ClipboardSource = {
      readText: () => Promise.resolve('from host'),
      writeText: (text) => {
        written.push(text)
        return Promise.resolve()
      },
    }
    const clipboard = createBrowserClipboard(source)
    clipboard.write('out')
    expect(written).toEqual(['out'])
    expect(await clipboard.read()).toBe('from host')
  })

  it('reads empty and drops writes when the host refuses or has no clipboard', async () => {
    const refusing: ClipboardSource = {
      readText: () => Promise.reject(new Error('denied')),
      writeText: () => Promise.reject(new Error('denied')),
    }
    const clipboard = createBrowserClipboard(refusing)
    expect(() => clipboard.write('out')).not.toThrow()
    expect(await clipboard.read()).toBe('')
    const none = createBrowserClipboard(undefined)
    expect(() => none.write('out')).not.toThrow()
    expect(await none.read()).toBe('')
  })
})

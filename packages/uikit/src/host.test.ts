import { describe, expect, it } from 'bun:test'
import {
  acceptExtensions,
  type ClipboardSource,
  createBrowserClipboard,
  createBrowserDownload,
  createBrowserFilePicker,
  type DownloadDocument,
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

describe('createBrowserFilePicker', () => {
  it('configures and clicks a hidden input, then resolves with the chosen files', async () => {
    const input = stubInput()
    const { doc, attached } = stubDocument(input)
    const pick = createBrowserFilePicker(doc)
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
  })

  it('resolves empty on cancel and asks for a directory when told to', async () => {
    const input = stubInput()
    const { doc } = stubDocument(input)
    const promise = createBrowserFilePicker(doc)({ directory: true })
    expect(input.webkitdirectory).toBe(true)
    input.fire('cancel')
    expect(await promise).toEqual([])
    // A late change after settling is ignored.
    input.files = [new File(['x'], 'late.nii')]
    input.fire('change')
    expect(await promise).toEqual([])
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
    const download = createBrowserDownload(doc, {
      createObjectURL: () => {
        urls.push('blob:1')
        return 'blob:1'
      },
      revokeObjectURL: (u) => {
        revoked.push(u)
      },
    })
    download(new Blob(['{}'], { type: 'application/json' }), 'scene.json')
    expect(anchor.clicks).toBe(1)
    expect(anchor.href).toBe('blob:1')
    expect(anchor.download).toBe('scene.json')
    expect(attached).toHaveLength(0)
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

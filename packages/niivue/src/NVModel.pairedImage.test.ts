import { afterEach, describe, expect, mock, test } from 'bun:test'
import { loadVolume, nii2volume } from '@/volume/NVVolume'

// loadBridge imports a Vite `?worker&inline` module that Bun cannot load. Stand
// in its main-thread fallback, which is the same loadVolume + nii2volume pair.
mock.module('@/volume/loadBridge', () => ({
  loadVolumePrepared: async (
    url: string | File,
    paired: string | File | null,
    limitFrames4D: number,
    name?: string,
  ) => {
    const { hdr, img } = await loadVolume(url, paired, limitFrames4D, name)
    return nii2volume(hdr, img, name ?? '', limitFrames4D)
  },
}))
const { default: NVModel } = await import('@/NVModel')

// A 2x2x2 uint8 AFNI dataset: just enough of a .HEAD for the reader.
const HEAD_TEXT = [
  'type = integer-attribute',
  'name = DATASET_DIMENSIONS',
  'count = 3',
  ' 2 2 2',
  '',
  'type = integer-attribute',
  'name = BRICK_TYPES',
  'count = 1',
  ' 0',
  '',
  'type = integer-attribute',
  'name = ORIENT_SPECIFIC',
  'count = 3',
  ' 1 2 4',
  '',
].join('\n')
const BRIK = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])

/** Serve `files` by URL as the global fetch; 404 everything else. */
function serve(files: Record<string, BodyInit>): string[] {
  const requested: string[] = []
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = String(input)
    requested.push(url)
    const body = files[url]
    return body === undefined
      ? new Response('not found', { status: 404 })
      : new Response(body, { status: 200 })
  }) as typeof fetch
  return requested
}

describe('NVModel.prepareVolume with a .HEAD URL', () => {
  const realFetch = globalThis.fetch
  afterEach(() => {
    globalThis.fetch = realFetch
  })

  test('findsTheBrikAndStashesItLikeAnExplicitUrlImageData', async () => {
    serve({
      'http://test/tiny+orig.HEAD': HEAD_TEXT,
      'http://test/tiny+orig.BRIK': BRIK,
    })
    const vol = await NVModel.prepareVolume({
      url: 'http://test/tiny+orig.HEAD',
    })
    expect(Array.from(vol.hdr.dims.slice(1, 4))).toEqual([2, 2, 2])
    expect(vol._urlImageData).toBe('http://test/tiny+orig.BRIK')
  })

  test('fallsBackToTheBrikGz', async () => {
    serve({
      'http://test/tiny+orig.HEAD': HEAD_TEXT,
      'http://test/tiny+orig.BRIK.gz': Bun.gzipSync(BRIK),
    })
    const vol = await NVModel.prepareVolume({
      url: 'http://test/tiny+orig.HEAD',
    })
    expect(vol._urlImageData).toBe('http://test/tiny+orig.BRIK.gz')
    expect(vol.nVox3D).toBe(8)
  })

  test('anExplicitUrlImageDataIsUsedAsGiven', async () => {
    const requested = serve({
      'http://test/tiny+orig.HEAD': HEAD_TEXT,
      'http://test/tiny+orig.BRIK': BRIK,
      'http://other/data.BRIK': BRIK,
    })
    const vol = await NVModel.prepareVolume({
      url: 'http://test/tiny+orig.HEAD',
      urlImageData: 'http://other/data.BRIK',
    })
    expect(vol._urlImageData).toBe('http://other/data.BRIK')
    expect(requested).not.toContain('http://test/tiny+orig.BRIK')
  })
})

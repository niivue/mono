import { describe, expect, test } from 'bun:test'
import { decode, encode } from 'cbor-x'
import { isLinkableUrl, shouldLinkVolume } from './documentLinkData'

// A real niivue test-images URL (the "niivue test images repo") plus a served
// local path — both are the kind of URL a linked document references.
const REMOTE_URL = 'https://niivue.github.io/niivue-demo-images/mni152.nii.gz'
const LOCAL_URL = '/volumes/mni152.nii.gz'

describe('isLinkableUrl', () => {
  test('remote and local/relative URLs are linkable', () => {
    expect(isLinkableUrl(REMOTE_URL)).toBe(true)
    expect(isLinkableUrl(LOCAL_URL)).toBe(true)
    expect(isLinkableUrl('http://example.org/brain.nii')).toBe(true)
    expect(isLinkableUrl('brain.nii.gz')).toBe(true)
  })

  test('ephemeral and empty URLs are not linkable', () => {
    expect(isLinkableUrl('blob:https://app/9f2c')).toBe(false)
    expect(isLinkableUrl('data:application/gzip;base64,H4sI')).toBe(false)
    expect(isLinkableUrl('')).toBe(false)
    expect(isLinkableUrl('   ')).toBe(false)
    expect(isLinkableUrl(undefined)).toBe(false)
  })
})

describe('shouldLinkVolume', () => {
  test('links only when linkData is on AND the URL is linkable', () => {
    expect(shouldLinkVolume(REMOTE_URL, true)).toBe(true)
    expect(shouldLinkVolume(LOCAL_URL, true)).toBe(true)
    // linkData off -> always embed
    expect(shouldLinkVolume(REMOTE_URL, false)).toBe(false)
    // linkData on but no fetchable URL -> embed (fallback)
    expect(shouldLinkVolume('blob:https://app/9f2c', true)).toBe(false)
    expect(shouldLinkVolume(undefined, true)).toBe(false)
  })
})

// Mirror the per-volume decision + wire shape of NVDocument.serialize (the full
// module can't be imported under the Bun harness -- its graph uses Vite's
// import.meta.glob; see slideSerialization.test.ts for the same pattern). This
// locks the linked-document contract the loader relies on: a linked volume has a
// URL and NO embedded `data` (reconstructVolume then takes its `else if (v.url)`
// refetch branch); an embedded volume carries `data`.
type SrcVolume = { url?: string; name: string; img: Uint8Array }
type DocVolume = { url?: string; name: string; data?: { img: Uint8Array } }

function toDocVolume(v: SrcVolume, linkData: boolean): DocVolume {
  const doc: DocVolume = { url: v.url, name: v.name }
  if (!shouldLinkVolume(v.url, linkData)) doc.data = { img: v.img }
  return doc
}

// The loader's branch selector (mirrors reconstructVolume).
function loaderBranch(v: DocVolume): 'embedded' | 'url' | 'none' {
  if (v.data) return 'embedded'
  if (v.url) return 'url'
  return 'none'
}

describe('linked document wire contract (CBOR round-trip)', () => {
  const src: SrcVolume = {
    url: REMOTE_URL,
    name: 'mni152',
    img: new Uint8Array([1, 2, 3, 4, 5]),
  }

  test('embedded save carries the bytes; loader takes the embedded branch', () => {
    const doc = decode(encode(toDocVolume(src, false))) as DocVolume
    expect(doc.url).toBe(REMOTE_URL)
    expect(doc.data?.img).toEqual(src.img)
    expect(loaderBranch(doc)).toBe('embedded')
  })

  test('linked save omits the bytes; loader refetches from the URL', () => {
    const doc = decode(encode(toDocVolume(src, true))) as DocVolume
    expect(doc.url).toBe(REMOTE_URL)
    expect(doc.data).toBeUndefined()
    expect(loaderBranch(doc)).toBe('url')
  })

  test('linkData with an unlinkable URL still embeds so the doc round-trips', () => {
    const local: SrcVolume = { ...src, url: 'blob:https://app/abc' }
    const doc = decode(encode(toDocVolume(local, true))) as DocVolume
    expect(doc.data?.img).toEqual(local.img)
    expect(loaderBranch(doc)).toBe('embedded')
  })
})

// Opt-in network test against the real niivue test-images repo: proves a linked
// document's URL reference actually rehydrates. Off by default (CI is hermetic);
// run with `RUN_NETWORK_TESTS=1 bun test src/documentLinkData.test.ts`.
const runNetwork = !!process.env.RUN_NETWORK_TESTS
const netDescribe = runNetwork ? describe : describe.skip
netDescribe(
  'linked reference against the niivue test-images repo (network)',
  () => {
    test('the referenced URL fetches a gzipped NIfTI', async () => {
      const res = await fetch(REMOTE_URL)
      expect(res.ok).toBe(true)
      const body = res.body
      expect(body).toBeTruthy()
      if (!body) return
      // Read just the first chunk and confirm the gzip magic (0x1f 0x8b), then
      // cancel so we don't download the whole volume.
      const reader = body.getReader()
      const { value } = await reader.read()
      await reader.cancel()
      expect(value && value.length >= 2).toBe(true)
      expect([value?.[0], value?.[1]]).toEqual([0x1f, 0x8b])
    }, 20000)
  },
)

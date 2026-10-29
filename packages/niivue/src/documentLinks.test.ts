import { describe, expect, test } from 'bun:test'
import { type DocumentLinkKind, resolveLinkedEntry } from './documentLinks'

describe('resolveLinkedEntry', () => {
  test('without a resolver every entry loads unchanged', () => {
    const entry = { url: 'a.nii.gz' }
    expect(resolveLinkedEntry(entry, 'volume')).toBe(entry)
  })

  test('a linked entry loads from the URL the resolver returns', () => {
    const entry = { url: 'a.nii.gz', name: 'a' }
    const resolved = resolveLinkedEntry(
      entry,
      'volume',
      (url) => `https://host/${url}`,
    )
    expect(resolved).toEqual({ url: 'https://host/a.nii.gz', name: 'a' })
    // The document's own entry is not rewritten.
    expect(entry.url).toBe('a.nii.gz')
  })

  test('a resolver returning null skips the entry', () => {
    expect(resolveLinkedEntry({ url: 'a.mz3' }, 'mesh', () => null)).toBeNull()
  })

  test('the resolver is told what kind of link it sees', () => {
    const kinds: DocumentLinkKind[] = []
    const resolve = (url: string, kind: DocumentLinkKind) => {
      kinds.push(kind)
      return url
    }
    resolveLinkedEntry({ url: 'a.nii.gz' }, 'volume', resolve)
    resolveLinkedEntry({ url: 'a.mz3' }, 'mesh', resolve)
    expect(kinds).toEqual(['volume', 'mesh'])
  })

  test('an embedded entry never reaches the resolver, even with a url', () => {
    let calls = 0
    const entry = { url: 'a.nii.gz', data: new Uint8Array(4) }
    const resolved = resolveLinkedEntry(entry, 'volume', () => {
      calls += 1
      return null
    })
    expect(resolved).toBe(entry)
    expect(calls).toBe(0)
  })

  test('an entry with neither url nor data is left to the loader', () => {
    let calls = 0
    const entry: { name: string; url?: string } = { name: 'empty' }
    expect(
      resolveLinkedEntry(entry, 'volume', () => {
        calls += 1
        return null
      }),
    ).toBe(entry)
    expect(calls).toBe(0)
  })
})

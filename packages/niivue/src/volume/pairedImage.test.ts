import { describe, expect, test } from 'bun:test'
import { pairedImageUrlCandidates, resolvePairedImage } from './pairedImage'

/** A fetch stand-in that serves `files` by URL and 404s everything else. */
function fakeFetch(files: Record<string, BodyInit>): {
  fetch: typeof fetch
  requested: string[]
} {
  const requested: string[] = []
  const impl = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input)
    requested.push(url)
    const body = files[url]
    return body === undefined
      ? new Response('not found', { status: 404 })
      : new Response(body, { status: 200 })
  }
  return { fetch: impl as typeof fetch, requested }
}

describe('pairedImageUrlCandidates', () => {
  test('pairsAHeadWithBrikThenBrikGz', () => {
    expect(pairedImageUrlCandidates('/volumes/afni/DT_FA+orig.HEAD')).toEqual([
      '/volumes/afni/DT_FA+orig.BRIK',
      '/volumes/afni/DT_FA+orig.BRIK.gz',
    ])
  })

  test('keepsALowercaseExtensionLowercase', () => {
    expect(pairedImageUrlCandidates('data/anat+tlrc.head')).toEqual([
      'data/anat+tlrc.brik',
      'data/anat+tlrc.brik.gz',
    ])
  })

  test('carriesAQueryStringAndFragmentToEachCandidate', () => {
    expect(
      pairedImageUrlCandidates('https://x.org/a/epi+orig.HEAD?token=abc#v1'),
    ).toEqual([
      'https://x.org/a/epi+orig.BRIK?token=abc#v1',
      'https://x.org/a/epi+orig.BRIK.gz?token=abc#v1',
    ])
  })

  test('ignoresHeadInTheQueryOrDirectory', () => {
    expect(pairedImageUrlCandidates('/HEAD/brain.nii.gz')).toEqual([])
    expect(pairedImageUrlCandidates('/brain.nii.gz?f=x.HEAD')).toEqual([])
    expect(pairedImageUrlCandidates('/brain.HEADER')).toEqual([])
  })
})

describe('resolvePairedImage', () => {
  const head = '/v/epi+orig.HEAD'

  test('usesTheBrikWhenItExists', async () => {
    const { fetch, requested } = fakeFetch({ '/v/epi+orig.BRIK': 'x' })
    expect(await resolvePairedImage(head, null, fetch)).toBe('/v/epi+orig.BRIK')
    expect(requested).toEqual(['/v/epi+orig.BRIK'])
  })

  test('fallsBackToTheBrikGzWhenTheBrikIsMissing', async () => {
    const { fetch, requested } = fakeFetch({ '/v/epi+orig.BRIK.gz': 'x' })
    expect(await resolvePairedImage(head, undefined, fetch)).toBe(
      '/v/epi+orig.BRIK.gz',
    )
    expect(requested).toEqual(['/v/epi+orig.BRIK', '/v/epi+orig.BRIK.gz'])
  })

  test('fallsBackWhenTheBrikProbeThrows', async () => {
    const impl = (async (input: RequestInfo | URL) => {
      if (String(input).endsWith('.BRIK')) throw new TypeError('network')
      return new Response('x', { status: 200 })
    }) as typeof fetch
    expect(await resolvePairedImage(head, null, impl)).toBe(
      '/v/epi+orig.BRIK.gz',
    )
  })

  test('skipsAnHtmlFallbackPageServedForAMissingBrik', async () => {
    const impl = (async (input: RequestInfo | URL) =>
      String(input).endsWith('.BRIK')
        ? new Response('<!doctype html>', {
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
          })
        : new Response('x', { status: 200 })) as typeof fetch
    expect(await resolvePairedImage(head, null, impl)).toBe(
      '/v/epi+orig.BRIK.gz',
    )
  })

  test('keepsTheQueryStringOnTheResolvedUrl', async () => {
    const { fetch } = fakeFetch({ '/v/epi+orig.BRIK.gz?sig=1': 'x' })
    expect(await resolvePairedImage(`${head}?sig=1`, null, fetch)).toBe(
      '/v/epi+orig.BRIK.gz?sig=1',
    )
  })

  test('returnsNullWhenNeitherDataFileExists', async () => {
    const { fetch } = fakeFetch({})
    expect(await resolvePairedImage(head, null, fetch)).toBeNull()
  })

  test('anExplicitUrlImageDataWinsWithoutProbing', async () => {
    const { fetch, requested } = fakeFetch({ '/v/epi+orig.BRIK': 'x' })
    expect(await resolvePairedImage(head, '/elsewhere/data.BRIK', fetch)).toBe(
      '/elsewhere/data.BRIK',
    )
    expect(requested).toEqual([])
  })

  test('doesNotProbeForOtherFormatsOrFiles', async () => {
    const { fetch, requested } = fakeFetch({})
    expect(await resolvePairedImage('/v/t1.nii.gz', null, fetch)).toBeNull()
    const file = new File(['x'], 'epi+orig.HEAD')
    expect(await resolvePairedImage(file, null, fetch)).toBeNull()
    expect(requested).toEqual([])
  })
})

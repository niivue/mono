import { describe, expect, test } from 'bun:test'
import { loadMatcapOrDefault } from '@/view/matcapFallback'

/** A loader that fails for the URLs in `broken` and records every call. */
function loader(broken: string[]) {
  const calls: string[] = []
  const load = async (url: string): Promise<string> => {
    calls.push(url)
    if (broken.includes(url)) throw new Error(`404 ${url}`)
    return url || 'white'
  }
  return { calls, load }
}

describe('loadMatcapOrDefault', () => {
  test('loads the requested matcap', async () => {
    const { calls, load } = loader([])
    expect(await loadMatcapOrDefault('/gold.jpg', '/cortex.jpg', load)).toBe(
      '/gold.jpg',
    )
    expect(calls).toEqual(['/gold.jpg'])
  })

  test('falls back to the default, then to white', async () => {
    const a = loader(['/gold.jpg'])
    expect(await loadMatcapOrDefault('/gold.jpg', '/cortex.jpg', a.load)).toBe(
      '/cortex.jpg',
    )
    const b = loader(['/gold.jpg', '/cortex.jpg'])
    expect(await loadMatcapOrDefault('/gold.jpg', '/cortex.jpg', b.load)).toBe(
      'white',
    )
    expect(b.calls).toEqual(['/gold.jpg', '/cortex.jpg', ''])
  })

  test('does not retry a failed default, and has none without matcaps', async () => {
    const a = loader(['/cortex.jpg'])
    expect(
      await loadMatcapOrDefault('/cortex.jpg', '/cortex.jpg', a.load),
    ).toBe('white')
    expect(a.calls).toEqual(['/cortex.jpg', ''])
    const b = loader(['/gold.jpg'])
    expect(await loadMatcapOrDefault('/gold.jpg', '', b.load)).toBe('white')
    expect(b.calls).toEqual(['/gold.jpg', ''])
  })
})

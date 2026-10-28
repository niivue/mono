import { describe, expect, test } from 'bun:test'
import { matcapFromName, matcapToName } from '@/documentMatcap'

const matcaps = { cortex: 'data:image/jpeg;base64,AAAA', shiny: '/m/Shiny.jpg' }

describe('matcapToName', () => {
  test('saves a known matcap by its name', () => {
    expect(matcapToName(matcaps.cortex, matcaps)).toBe('cortex')
    expect(matcapToName('/m/Shiny.jpg', matcaps)).toBe('shiny')
  })

  test('keeps an unknown or empty matcap as it is', () => {
    expect(matcapToName('https://x.org/a.jpg', matcaps)).toBe(
      'https://x.org/a.jpg',
    )
    expect(matcapToName('', matcaps)).toBe('')
    expect(matcapToName(matcaps.cortex, undefined)).toBe(matcaps.cortex)
  })
})

describe('matcapFromName', () => {
  test('looks a saved name up, ignoring case', () => {
    expect(matcapFromName('cortex', matcaps)).toBe(matcaps.cortex)
    expect(matcapFromName('Shiny', matcaps)).toBe('/m/Shiny.jpg')
  })

  test('matches a path to a built-in matcap by its file name', () => {
    expect(matcapFromName('/src/assets/matcaps/Cortex.jpg', matcaps)).toBe(
      matcaps.cortex,
    )
    expect(
      matcapFromName('/@fs/x/niivue/src/assets/matcaps/shiny.jpg?v=2', matcaps),
    ).toBe('/m/Shiny.jpg')
  })

  test('keeps any other URL, for the renderer to load or replace', () => {
    for (const url of [
      'https://x.org/gold.jpg',
      'data:image/png;base64,BBBB',
      '/custom/gold.jpg',
      './matcaps/gold.jpg',
      '//cdn.example.org/gold.jpg',
      // An app's own image that happens to share a built-in's name.
      '/custom/Cortex.jpg',
      // A built-in path this instance has no matcap for.
      '/src/assets/matcaps/Gold.jpg',
      // Another host's image under the same path as a built-in.
      'https://cdn.example.org/assets/matcaps/Cortex.jpg',
      '//cdn.example.org/src/assets/matcaps/shiny.jpg',
      'HTTP://x.org/assets/matcaps/Cortex.jpg?v=1',
    ]) {
      expect(matcapFromName(url, matcaps)).toBe(url)
    }
    expect(matcapFromName('blob:https://x.org/1', undefined)).toBe(
      'blob:https://x.org/1',
    )
    expect(matcapFromName('', matcaps)).toBe('')
  })

  test('replaces a name it does not know with the default', () => {
    expect(matcapFromName('gold', matcaps)).toBe(matcaps.cortex)
    // No matcaps: the default is none.
    expect(matcapFromName('cortex', {})).toBe('')
    expect(matcapFromName('/src/assets/matcaps/Cortex.jpg', undefined)).toBe(
      '/src/assets/matcaps/Cortex.jpg',
    )
  })

  test('round-trips through matcapToName', () => {
    for (const url of Object.values(matcaps)) {
      expect(matcapFromName(matcapToName(url, matcaps), matcaps)).toBe(url)
    }
  })
})

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

  test('matches a path saved before names by its file name', () => {
    expect(matcapFromName('/src/assets/matcaps/Cortex.jpg', matcaps)).toBe(
      matcaps.cortex,
    )
    expect(matcapFromName('/a/shiny.png?v=2', matcaps)).toBe('/m/Shiny.jpg')
  })

  test('keeps a URL it does not know, and any data URL', () => {
    expect(matcapFromName('https://x.org/gold.jpg', matcaps)).toBe(
      'https://x.org/gold.jpg',
    )
    expect(matcapFromName('data:image/png;base64,BBBB', matcaps)).toBe(
      'data:image/png;base64,BBBB',
    )
    expect(matcapFromName('', matcaps)).toBe('')
    expect(matcapFromName('cortex', undefined)).toBe('cortex')
  })

  test('round-trips through matcapToName', () => {
    for (const url of Object.values(matcaps)) {
      expect(matcapFromName(matcapToName(url, matcaps), matcaps)).toBe(url)
    }
  })
})

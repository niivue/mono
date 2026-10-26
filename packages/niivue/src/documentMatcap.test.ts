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

  test('keeps a web, data or blob URL it does not know', () => {
    expect(matcapFromName('https://x.org/gold.jpg', matcaps)).toBe(
      'https://x.org/gold.jpg',
    )
    expect(matcapFromName('data:image/png;base64,BBBB', matcaps)).toBe(
      'data:image/png;base64,BBBB',
    )
    expect(matcapFromName('blob:https://x.org/1', undefined)).toBe(
      'blob:https://x.org/1',
    )
    expect(matcapFromName('', matcaps)).toBe('')
  })

  test('preserves unmatched paths for the image loader', () => {
    for (const path of [
      '/src/assets/matcaps/Gold.jpg',
      '../matcaps/Gold.jpg',
      'Gold.jpg',
      '/matcaps/gold?variant=2#image',
      '//cdn.example.org/gold.jpg',
    ]) {
      expect(matcapFromName(path, matcaps)).toBe(path)
      expect(matcapFromName(path, undefined)).toBe(path)
    }
  })

  test('replaces an unknown bare name with the default', () => {
    expect(matcapFromName('gold', matcaps)).toBe(matcaps.cortex)
    expect(matcapFromName('cortex', {})).toBe('')
  })

  test('round-trips through matcapToName', () => {
    for (const url of Object.values(matcaps)) {
      expect(matcapFromName(matcapToName(url, matcaps), matcaps)).toBe(url)
    }
  })
})

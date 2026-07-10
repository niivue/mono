import { describe, expect, test } from 'bun:test'

import { SlideVectorLayer } from './slideVector'

describe('SlideVectorLayer', () => {
  test('addPolygon stores a shape and needs >= 3 points', () => {
    const layer = new SlideVectorLayer()
    expect(
      layer.addPolygon(
        [
          [0, 0],
          [10, 0],
        ],
        '#fff',
      ),
    ).toBe(false)
    expect(layer.shapes).toHaveLength(0)
    expect(
      layer.addPolygon(
        [
          [0, 0],
          [10, 0],
          [10, 10],
        ],
        '#e62d37',
      ),
    ).toBe(true)
    expect(layer.shapes).toHaveLength(1)
    expect(layer.version).toBe(1)
  })

  test('removeLast and clear update the layer + version', () => {
    const layer = new SlideVectorLayer()
    layer.addPolygon(
      [
        [0, 0],
        [4, 0],
        [4, 4],
      ],
      '#fff',
    )
    layer.addPolygon(
      [
        [1, 1],
        [2, 2],
        [3, 1],
      ],
      '#fff',
    )
    expect(layer.removeLast()).toBe(true)
    expect(layer.shapes).toHaveLength(1)
    layer.clear()
    expect(layer.shapes).toHaveLength(0)
    expect(layer.removeLast()).toBe(false)
  })

  test('toSVG emits a slide-sized viewBox with polygon points', () => {
    const layer = new SlideVectorLayer()
    layer.addPolygon(
      [
        [0, 0],
        [100, 0],
        [100, 50],
      ],
      '#e62d37',
      4,
    )
    const svg = layer.toSVG(1536, 1024)
    expect(svg).toContain('viewBox="0 0 1536 1024"')
    expect(svg).toContain('<polygon points="0,0 100,0 100,50"')
    expect(svg).toContain('stroke="#e62d37"')
    expect(svg).toContain('stroke-width="4"')
    expect(svg.startsWith('<svg')).toBe(true)
  })

  test('a hostile color cannot break out of the stroke attribute', () => {
    const layer = new SlideVectorLayer()
    layer.addPolygon(
      [
        [0, 0],
        [10, 0],
        [10, 10],
      ],
      '#fff" onload="alert(1)',
      4,
    )
    const svg = layer.toSVG(100, 100)
    expect(svg).not.toContain('onload')
    expect(svg).toContain('stroke="none"')
  })

  test('non-finite geometry never serializes as NaN', () => {
    const layer = new SlideVectorLayer()
    layer.addPolygon(
      [
        [0, 0],
        [Number.NaN, 10],
        [10, Number.POSITIVE_INFINITY],
      ],
      'red',
      Number.NaN,
    )
    const svg = layer.toSVG(100, 100)
    expect(svg).not.toContain('NaN')
    expect(svg).not.toContain('Infinity')
  })
})

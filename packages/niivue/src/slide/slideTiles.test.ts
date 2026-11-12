import { describe, expect, test } from 'bun:test'
import type { NVSlide, NVSlideScreen, NVSlideVisibleTile } from './NVSlide'
import { forEachSlideTile, slideRectNdc } from './slideTiles'

function tile(key: string, screenX = 0): NVSlideVisibleTile {
  return {
    key,
    screenX,
    screenY: 0,
    screenWidth: 10,
    screenHeight: 10,
  } as NVSlideVisibleTile
}

function fakeSlide(
  fallback: NVSlideVisibleTile[],
  tiles: NVSlideVisibleTile[],
  cached: string[],
): NVSlide {
  const entry = { level: {} }
  return {
    requestVisibleTiles: () => ({ fallback, tiles }),
    cachedTile: (key: string) => (cached.includes(key) ? entry : null),
  } as unknown as NVSlide
}

function visits(slide: NVSlide) {
  const seen: string[] = []
  forEachSlideTile(slide, {} as NVSlideScreen, (t, entry, _rect, isFallback) =>
    seen.push(
      `${isFallback ? 'fallback' : 'tile'}:${t.key}:${entry ? 'cached' : 'missing'}`,
    ),
  )
  return seen
}

describe('forEachSlideTile', () => {
  test('paints cached fallback tiles first, then the target level', () => {
    const slide = fakeSlide(
      [tile('f1'), tile('f2')],
      [tile('t1'), tile('t2')],
      ['f1', 't1'],
    )
    expect(visits(slide)).toEqual(['fallback:f1:cached', 'tile:t1:cached'])
  })

  test('a missing target tile is a placeholder only with no fallback behind it', () => {
    const slide = fakeSlide([], [tile('t1')], [])
    expect(visits(slide)).toEqual(['tile:t1:missing'])
  })
})

describe('slideRectNdc', () => {
  test('maps a screen rect to clip space, y up', () => {
    expect(
      slideRectNdc({ x: 0, y: 0, width: 50, height: 25 }, 100, 50),
    ).toEqual([-1, 1, 0, 0])
  })

  test('drops empty and off-screen rects', () => {
    expect(
      slideRectNdc({ x: 0, y: 0, width: 0, height: 5 }, 100, 50),
    ).toBeNull()
    expect(
      slideRectNdc({ x: 101, y: 0, width: 5, height: 5 }, 100, 50),
    ).toBeNull()
    expect(
      slideRectNdc({ x: -6, y: 0, width: 5, height: 5 }, 100, 50),
    ).toBeNull()
  })
})

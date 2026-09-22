import { describe, expect, test } from 'bun:test'
import {
  omeZarrAxisIndices,
  omeZarrResolveAxes,
  omeZarrSpatialOrder,
  omeZarrSpatialScaleUm,
  parseOmeroColor,
  parseOmeZarrAttrs,
} from './omeZarr'

/** A 0.4 `.zattrs` in the shape IDR publishes: tczyx plus an omero block. */
const IDR_STYLE_ATTRS = {
  multiscales: [
    {
      version: '0.4',
      name: '6001240.zarr',
      axes: [
        { name: 't', type: 'time', unit: 'millisecond' },
        { name: 'c', type: 'channel' },
        { name: 'z', type: 'space', unit: 'micrometer' },
        { name: 'y', type: 'space', unit: 'micrometer' },
        { name: 'x', type: 'space', unit: 'micrometer' },
      ],
      datasets: [
        {
          path: '0',
          coordinateTransformations: [
            { type: 'scale', scale: [1, 1, 0.5, 0.36, 0.36] },
          ],
        },
        {
          path: '1',
          coordinateTransformations: [
            { type: 'scale', scale: [1, 1, 0.5, 0.72, 0.72] },
            { type: 'translation', translation: [0, 0, 0, 0.18, 0.18] },
          ],
        },
      ],
    },
  ],
  omero: {
    channels: [
      {
        label: 'LaminB1',
        color: '00FF00',
        window: { start: 0, end: 1500, min: 0, max: 65535 },
        active: true,
      },
      {
        label: 'Dapi',
        color: 'FF00FF',
        window: { start: 100, end: 3000 },
        active: false,
      },
    ],
  },
}

describe('parseOmeZarrAttrs', () => {
  test('reads a 0.4 zattrs: axes, datasets, omero channels', () => {
    const info = parseOmeZarrAttrs(IDR_STYLE_ATTRS)
    expect(info.version).toBe('0.4')
    expect(info.name).toBe('6001240.zarr')
    expect(info.axes?.map((a) => a.name)).toEqual(['t', 'c', 'z', 'y', 'x'])
    expect(info.axes?.[2].unit).toBe('micrometer')
    expect(info.datasets.map((d) => d.path)).toEqual(['0', '1'])
    expect(info.datasets[0].scale).toEqual([1, 1, 0.5, 0.36, 0.36])
    expect(info.datasets[1].translation).toEqual([0, 0, 0, 0.18, 0.18])
    expect(info.channels).toHaveLength(2)
    expect(info.channels[0].label).toBe('LaminB1')
    expect(info.channels[0].color).toEqual([0, 255, 0])
    expect(info.channels[0].window).toEqual({
      start: 0,
      end: 1500,
      min: 0,
      max: 65535,
    })
    expect(info.channels[1].window?.min).toBeNull()
    expect(info.channels[1].active).toBe(false)
  })

  test('reads a 0.5 attributes object with the ome wrapper', () => {
    const attrs = {
      ome: {
        version: '0.5',
        multiscales: [
          {
            axes: [
              { name: 'z', type: 'space', unit: 'micrometer' },
              { name: 'y', type: 'space', unit: 'micrometer' },
              { name: 'x', type: 'space', unit: 'micrometer' },
            ],
            datasets: [
              {
                path: 'scale0',
                coordinateTransformations: [
                  { type: 'scale', scale: [2, 2, 2] },
                ],
              },
            ],
          },
        ],
        omero: { channels: [{ label: 'heart', color: 'FF0000' }] },
      },
    }
    const info = parseOmeZarrAttrs(attrs)
    expect(info.version).toBe('0.5')
    expect(info.datasets[0].path).toBe('scale0')
    expect(info.channels[0].label).toBe('heart')
    expect(info.channels[0].window).toBeNull()
  })

  test('accepts 0.3 string axes, inferring their types', () => {
    const attrs = {
      multiscales: [
        {
          version: '0.3',
          axes: ['t', 'c', 'z', 'y', 'x'],
          datasets: [{ path: '0' }],
        },
      ],
    }
    const info = parseOmeZarrAttrs(attrs)
    expect(info.axes?.map((a) => a.type)).toEqual([
      'time',
      'channel',
      'space',
      'space',
      'space',
    ])
    expect(info.datasets[0].scale).toBeNull()
    expect(info.channels).toEqual([])
  })

  test('a store without axes parses with axes null', () => {
    const info = parseOmeZarrAttrs({
      multiscales: [{ datasets: [{ path: '0' }] }],
    })
    expect(info.axes).toBeNull()
  })

  test('throws without multiscales or without datasets', () => {
    expect(() => parseOmeZarrAttrs({})).toThrow('no multiscales')
    expect(() => parseOmeZarrAttrs(null)).toThrow('no multiscales')
    expect(() =>
      parseOmeZarrAttrs({ multiscales: [{ datasets: [] }] }),
    ).toThrow('no datasets')
  })
})

describe('parseOmeroColor', () => {
  test('accepts bare, hash-prefixed and alpha-carrying hex', () => {
    expect(parseOmeroColor('FF8000')).toEqual([255, 128, 0])
    expect(parseOmeroColor('#00ff00')).toEqual([0, 255, 0])
    expect(parseOmeroColor('0000FF80')).toEqual([0, 0, 255])
  })

  test('rejects malformed values', () => {
    expect(parseOmeroColor('red')).toBeNull()
    expect(parseOmeroColor('FFF')).toBeNull()
    expect(parseOmeroColor(0xff0000)).toBeNull()
    expect(parseOmeroColor(undefined)).toBeNull()
  })
})

describe('omeZarrResolveAxes', () => {
  test('returns declared axes when their count matches', () => {
    const info = parseOmeZarrAttrs(IDR_STYLE_ATTRS)
    expect(omeZarrResolveAxes(info, 5)).toBe(info.axes as never)
    expect(() => omeZarrResolveAxes(info, 3)).toThrow('5 axes declared')
  })

  test('falls back to the trailing tczyx slice when axes are absent', () => {
    const info = parseOmeZarrAttrs({
      multiscales: [{ datasets: [{ path: '0' }] }],
    })
    expect(omeZarrResolveAxes(info, 5).map((a) => a.name)).toEqual([
      't',
      'c',
      'z',
      'y',
      'x',
    ])
    expect(omeZarrResolveAxes(info, 3).map((a) => a.name)).toEqual([
      'z',
      'y',
      'x',
    ])
    expect(() => omeZarrResolveAxes(info, 6)).toThrow('cannot infer')
    expect(() => omeZarrResolveAxes(info, 1)).toThrow('cannot infer')
  })
})

describe('axis classification and display order', () => {
  test('tczyx: channel and time found, spatial in declared order', () => {
    const info = parseOmeZarrAttrs(IDR_STYLE_ATTRS)
    const axes = omeZarrResolveAxes(info, 5)
    const indices = omeZarrAxisIndices(axes)
    expect(indices.time).toBe(0)
    expect(indices.channel).toBe(1)
    expect(indices.spatial).toEqual([2, 3, 4])
    expect(omeZarrSpatialOrder(axes, indices.spatial)).toEqual({
      x: 2,
      y: 1,
      z: 0,
    })
  })

  test('xyz declared order (Human Organ Atlas) maps by name', () => {
    const axes = [
      { name: 'x', type: 'space', unit: 'micrometer' },
      { name: 'y', type: 'space', unit: 'micrometer' },
      { name: 'z', type: 'space', unit: 'micrometer' },
    ]
    const indices = omeZarrAxisIndices(axes)
    expect(indices.time).toBe(-1)
    expect(indices.channel).toBe(-1)
    expect(omeZarrSpatialOrder(axes, indices.spatial)).toEqual({
      x: 0,
      y: 1,
      z: 2,
    })
  })

  test('unconventional names fall back to fastest-last', () => {
    const axes = [
      { name: 'depth', type: 'space', unit: null },
      { name: 'row', type: 'space', unit: null },
      { name: 'col', type: 'space', unit: null },
    ]
    expect(omeZarrSpatialOrder(axes, [0, 1, 2])).toEqual({ x: 2, y: 1, z: 0 })
  })

  test('a 2D image gets z -1 and a single slice downstream', () => {
    const axes = [
      { name: 'y', type: 'space', unit: null },
      { name: 'x', type: 'space', unit: null },
    ]
    const indices = omeZarrAxisIndices(axes)
    expect(omeZarrSpatialOrder(axes, indices.spatial)).toEqual({
      x: 1,
      y: 0,
      z: -1,
    })
  })

  test('rejects axis lists without a usable spatial pair', () => {
    expect(() =>
      omeZarrAxisIndices([{ name: 'c', type: 'channel', unit: null }]),
    ).toThrow('spatial axes')
  })
})

describe('omeZarrSpatialScaleUm', () => {
  test('converts stated units to micrometres in display order', () => {
    const info = parseOmeZarrAttrs(IDR_STYLE_ATTRS)
    const axes = omeZarrResolveAxes(info, 5)
    expect(omeZarrSpatialScaleUm(info.datasets[0], axes)).toEqual([
      0.36, 0.36, 0.5,
    ])
  })

  test('nanometre units scale down; a missing scale falls back to 1', () => {
    const axes = [
      { name: 'z', type: 'space', unit: 'nanometer' },
      { name: 'y', type: 'space', unit: 'nanometer' },
      { name: 'x', type: 'space', unit: 'nanometer' },
    ]
    expect(
      omeZarrSpatialScaleUm(
        { path: '0', scale: [500, 250, 250], translation: null },
        axes,
      ),
    ).toEqual([0.25, 0.25, 0.5])
    expect(
      omeZarrSpatialScaleUm(
        { path: '0', scale: null, translation: null },
        axes,
      ),
    ).toEqual([1, 1, 1])
  })

  test('an unstated unit passes through as micrometres', () => {
    const axes = [
      { name: 'z', type: 'space', unit: null },
      { name: 'y', type: 'space', unit: null },
      { name: 'x', type: 'space', unit: null },
    ]
    expect(
      omeZarrSpatialScaleUm(
        { path: '0', scale: [2, 0.5, 0.5], translation: null },
        axes,
      ),
    ).toEqual([0.5, 0.5, 2])
  })
})
